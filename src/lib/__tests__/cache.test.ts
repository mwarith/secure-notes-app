import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { readCounter } from "@/lib/metrics";
import { valkey } from "@/lib/valkey";
import {
  delNotesCache,
  getNotesCache,
  notesListKey,
  notesNoteKey,
  setNotesCache,
  ttlNotesCache,
} from "../cache/notes";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOTE_ID = "00000000-0000-4000-8000-000000000002";
const LIST_KEY = notesListKey(USER_ID);
const NOTE_KEY = notesNoteKey(USER_ID, NOTE_ID);

interface NoteSummaryShape {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

function makeSummary(): NoteSummaryShape {
  return {
    id: NOTE_ID,
    title: "Grocery list\n— second line",
    content: "line1\nline2 — café ñ 🚀\n\ttabbed \\backslash \"quoted\"",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T12:34:56.789Z"),
  };
}

function countCalls(spy: ReturnType<typeof vi.fn>): number {
  return spy.mock.calls.length;
}

beforeEach(async () => {
  await delNotesCache(LIST_KEY);
  await delNotesCache(NOTE_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key naming", () => {
  it("builds the documented key shapes in the notes: namespace", () => {
    expect(notesListKey("user-1")).toBe("notes:list:user-1");
    expect(notesNoteKey("user-1", "note-9")).toBe("notes:note:user-1:note-9");
    expect(notesListKey(USER_ID)).toBe(LIST_KEY);
    expect(notesNoteKey(USER_ID, NOTE_ID)).toBe(NOTE_KEY);
  });

  it("never collides with the session or rate-limiter namespaces", () => {
    for (const key of [notesListKey("u"), notesNoteKey("u", "n")]) {
      expect(key.startsWith("session:")).toBe(false);
      expect(key.startsWith("rl:")).toBe(false);
      expect(key.startsWith("notes:")).toBe(true);
    }
  });
});

describe("serialization round-trip (unit over real valkey)", () => {
  it("revives Date fields as Date instances, not strings", async () => {
    const summary = makeSummary();
    await setNotesCache(LIST_KEY, summary, 60);

    const revived = await getNotesCache<NoteSummaryShape>(LIST_KEY);

    expect(revived).not.toBeNull();
    expect(revived?.updatedAt).toBeInstanceOf(Date);
    expect(revived?.createdAt).toBeInstanceOf(Date);
    expect(revived?.updatedAt.getTime()).toBe(summary.updatedAt.getTime());
    expect(revived?.createdAt.getTime()).toBe(summary.createdAt.getTime());
  });

  it("round-trips a NoteSummary list; newlines and unicode survive exactly", async () => {
    const summaries: NoteSummaryShape[] = [
      makeSummary(),
      {
        id: "00000000-0000-4000-8000-000000000003",
        title: "두 번째 노트 — خط عربي",
        content: "line1\nline2\n\nline4\ttabbed\\backslash \"quoted\"",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T03:04:05.678Z"),
      },
    ];
    await setNotesCache(LIST_KEY, summaries, 60);

    const revived = await getNotesCache<NoteSummaryShape[]>(LIST_KEY);

    expect(revived).not.toBeNull();
    expect(revived).toHaveLength(2);
    for (const note of revived ?? []) {
      expect(note.updatedAt).toBeInstanceOf(Date);
      expect(note.createdAt).toBeInstanceOf(Date);
    }
    expect(JSON.stringify(revived)).toBe(JSON.stringify(summaries));
  });

  it("preserves plain values that contain no Date fields", async () => {
    await setNotesCache(NOTE_KEY, { plain: "value", count: 3 }, 60);
    expect(await getNotesCache(NOTE_KEY)).toEqual({ plain: "value", count: 3 });
  });
});

describe("TTL contract (integration)", () => {
  it("stores with a TTL that valkey reports and expires when it passes", async () => {
    expect(await setNotesCache(NOTE_KEY, { v: 1 }, 2)).toBe(true);
    expect(await ttlNotesCache(NOTE_KEY)).toBeLessThanOrEqual(2);

    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(await getNotesCache<{ v: number }>(NOTE_KEY)).toBeNull();
  });
});

describe("misses and malformed payloads", () => {
  it("returns null and counts a miss for a key that was never set", async () => {
    const missesBefore = readCounter("notes_cache_misses_total");
    expect(await getNotesCache(NOTE_KEY)).toBeNull();
    expect(readCounter("notes_cache_misses_total")).toBe(missesBefore + 1);
  });

  it("treats malformed JSON as a miss, deletes the key, and never crashes", async () => {
    await valkey.set(NOTE_KEY, "{not valid json");
    const missesBefore = readCounter("notes_cache_misses_total");

    expect(await getNotesCache<NoteSummaryShape>(NOTE_KEY)).toBeNull();
    expect(await valkey.exists(NOTE_KEY)).toBe(0);
    expect(readCounter("notes_cache_misses_total")).toBe(missesBefore + 1);
  });
});

describe("hit/miss counters", () => {
  it("counts a hit on a populated key and a miss after expiry", async () => {
    await setNotesCache(NOTE_KEY, { v: 1 }, 60);
    const hitsBefore = readCounter("notes_cache_hits_total");
    expect(await getNotesCache<{ v: number }>(NOTE_KEY)).toEqual({ v: 1 });
    expect(readCounter("notes_cache_hits_total")).toBe(hitsBefore + 1);

    const missesBefore = readCounter("notes_cache_misses_total");
    expect(await getNotesCache<{ v: number }>(LIST_KEY)).toBeNull();
    expect(readCounter("notes_cache_misses_total")).toBe(missesBefore + 1);
  });
});

describe("bounded failure (unit — valkey failure injected)", () => {
  function failingValkey(error: Error): Redis {
    return {
      get: () => Promise.reject(error),
      set: () => Promise.reject(error),
      del: () => Promise.reject(error),
      ttl: () => Promise.reject(error),
    } as unknown as Redis;
  }

  it("get -> null + one warn + miss counter", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getSpy = vi
      .spyOn(valkey, "get")
      .mockImplementation(failingValkey(new Error("valkey down")).get);
    const missesBefore = readCounter("notes_cache_misses_total");

    expect(await getNotesCache(LIST_KEY)).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as {
      level: string;
      event: string;
      operation: string;
    };
    expect(line.level).toBe("warn");
    expect(line.event).toBe("cache.valkey_failed");
    expect(line.operation).toBe("get");
    expect(readCounter("notes_cache_misses_total")).toBe(missesBefore + 1);
  });

  it("set -> false + one warn; del -> false + one warn; ttl -> null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = failingValkey(new Error("valkey down"));
    const setSpy = vi.spyOn(valkey, "set").mockImplementation(failing.set);
    const delSpy = vi.spyOn(valkey, "del").mockImplementation(failing.del);
    const ttlSpy = vi.spyOn(valkey, "ttl").mockImplementation(failing.ttl);

    expect(await setNotesCache(NOTE_KEY, { v: 1 }, 60)).toBe(false);
    expect(await delNotesCache(NOTE_KEY)).toBe(false);
    expect(await ttlNotesCache(NOTE_KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(delSpy).toHaveBeenCalledTimes(1);
    expect(countCalls(ttlSpy)).toBe(1);
  });
});

describe("delete (integration)", () => {
  it("returns true when a key existed and false when it did not", async () => {
    await setNotesCache(NOTE_KEY, { v: 1 }, 60);
    expect(await delNotesCache(NOTE_KEY)).toBe(true);
    expect(await delNotesCache(NOTE_KEY)).toBe(false);
    expect(await getNotesCache(NOTE_KEY)).toBeNull();
  });

  it("logs nothing when valkey is healthy", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await setNotesCache(NOTE_KEY, { v: 1 }, 60);
    await getNotesCache(NOTE_KEY);
    await delNotesCache(NOTE_KEY);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
