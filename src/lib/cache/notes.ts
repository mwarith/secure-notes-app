import { log } from "@/lib/logger";
import { incrementCounter } from "@/lib/metrics";
import { valkey } from "@/lib/valkey";

/**
 * Notes cache helper (PRD §11 visibility; ENG-36). A thin, bounded layer
 * over the shared Valkey client that ENG-37 will wire into the notes read
 * path as read-through + invalidation. This module owns three policies so
 * the read path never has to:
 *
 * - Serialization: JSON with epoch-ms Date encoding ("__date__" wrapper).
 *   A naive JSON round-trip turns NoteSummary.updatedAt into a string,
 *   which breaks the workspace UI (rendering/formatting expects Date);
 *   values are revived on read so callers receive real Date instances.
 * - Bounded failure: every operation catches, logs one warn line through
 *   the frozen logger seam, and degrades (null / false) — the cache can
 *   never throw into the read path, mirroring the shared client's
 *   maxRetriesPerRequest posture (fail fast, degrade gracefully).
 * - Counters: notes_cache_hits_total / notes_cache_misses_total via the
 *   frozen incrementCounter seam, so ENG-37's read-through is visible in
 *   /api/metrics from day one (the counters read 0/sparse until wired).
 *
 * Keys live in the "notes:" namespace — disjoint from "session:" and the
 * rate limiters' "rl:" — and the naming helpers below are the single
 * source of key shapes for ENG-37's reuse.
 */

const DATE_MS_FIELD = "__date__ms";
/**
 * Serialization protocol for cached values. JSON.stringify invokes toJSON
 * on Dates before any replacer, so replacer-based wrappers are silently
 * re-serialized as ISO strings (found live in this ticket's red run).
 * Instead, values are pre-walked: every Date becomes a plain
 * { "__date__ms": <epoch-ms> } object, which survives stringify verbatim;
 * on read, the parse reviver turns any single-key object with that exact
 * field back into a Date. A user object that legitimately contains only
 * a __date__ms field is indistinguishable from a Date stand-in — acceptable
 * here because cached values are the app's own notes-shaped payloads.
 */
const WARN_EVENT = "cache.valkey_failed";

export function notesListKey(userId: string): string {
  return `notes:list:${userId}`;
}

export function notesNoteKey(userId: string, noteId: string): string {
  return `notes:note:${userId}:${noteId}`;
}

function encode(value: unknown): string {
  function pre(entry: unknown): unknown {
    if (entry instanceof Date) {
      return { [DATE_MS_FIELD]: entry.getTime() };
    }
    if (Array.isArray(entry)) {
      return entry.map(pre);
    }
    if (entry !== null && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const [field, item] of Object.entries(entry)) {
        out[field] = pre(item);
      }
      return out;
    }
    return entry;
  }
  return JSON.stringify(pre(value));
}

function decode<T>(payload: string): T {
  return JSON.parse(payload, (_key, entry) => {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry as Record<string, unknown>).length === 1 &&
      typeof (entry as Record<string, unknown>)[DATE_MS_FIELD] === "number"
    ) {
      return new Date((entry as Record<string, number>)[DATE_MS_FIELD]);
    }
    return entry;
  }) as T;
}

/** One warn line through the frozen seam; nothing else escapes. */
function warnBoundedFailure(operation: string, error: unknown): void {
  log("warn", WARN_EVENT, {
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Returns the cached value at key, or null on miss/malformed/valkey
 * failure. Hits and misses are counted; a malformed payload is deleted so
 * a poisoned key cannot fail every future read (self-healing miss).
 */
export async function getNotesCache<T>(key: string): Promise<T | null> {
  try {
    const payload = await valkey.get(key);
    if (payload === null) {
      incrementCounter("notes_cache_misses_total");
      return null;
    }
    try {
      const value = decode<T>(payload);
      incrementCounter("notes_cache_hits_total");
      return value;
    } catch (error) {
      // Poisoned payload: count it as a miss and remove the key so the
      // next read goes through (ENG-37 will re-fill from Postgres).
      warnBoundedFailure("get", error);
      incrementCounter("notes_cache_misses_total");
      try {
        await valkey.del(key);
      } catch {
        // The payload is bad either way; deletion is best-effort.
      }
      return null;
    }
  } catch (error) {
    incrementCounter("notes_cache_misses_total");
    warnBoundedFailure("get", error);
    return null;
  }
}

/**
 * Stores value under key with a TTL. Returns false (never throws) when
 * valkey is unavailable — a cache write failure is always non-fatal.
 */
export async function setNotesCache(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  try {
    await valkey.set(key, encode(value), "EX", ttlSeconds);
    return true;
  } catch (error) {
    warnBoundedFailure("set", error);
    return false;
  }
}

/**
 * Deletes a key; true when a key was actually removed, false on miss or
 * valkey failure (bounded — the layer never throws).
 */
export async function delNotesCache(key: string): Promise<boolean> {
  try {
    const removed = await valkey.del(key);
    return removed > 0;
  } catch (error) {
    warnBoundedFailure("del", error);
    return false;
  }
}

/**
 * Remaining TTL in seconds, or null when the key is absent or valkey is
 * unreachable. Test/diagnostic helper for the TTL contract.
 */
export async function ttlNotesCache(key: string): Promise<number | null> {
  try {
    const ttl = await valkey.ttl(key);
    return ttl > 0 ? ttl : null;
  } catch {
    return null;
  }
}
