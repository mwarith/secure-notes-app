import { log } from "@/lib/logger";
import { incrementCounter } from "@/lib/metrics";
import { valkey } from "@/lib/valkey";

/**
 * Bounded notes-cache layer over the shared Valkey client. Three policies:
 * JSON serialization that preserves Dates (pre-walked to epoch-ms objects
 * — a naive round-trip breaks the UI), bounded failure (every op logs one
 * warn and degrades, never throwing into the read path), and hit/miss
 * counters for the metrics exposition. Key helpers own the "notes:"
 * namespace, disjoint from sessions and rate limiting.
 */

const DATE_MS_FIELD = "__date__ms";
/**
 * Dates are pre-walked to { __date__ms } before stringify (toJSON runs
 * before replacers, so replacer wrappers would silently become ISO
 * strings) and revived on read.
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
      // Poisoned payload: count a miss and remove the key so the next
      // read refills from Postgres.
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
