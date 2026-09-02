import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { noteVersions, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey } from "@/lib/valkey";
import { readCounter } from "@/lib/metrics";
import {
  delNotesCache,
  notesListKey,
  notesNoteKey,
  ttlNotesCache,
} from "@/lib/cache";
import {
  NOTES_CACHE_TTL_SECONDS,
  checkpointNoteVersionForUser,
  createNoteForUser,
  deleteNoteForUser,
  getNoteForUser,
  listNotesForUser,
  restoreNoteVersionForUser,
  updateNoteForUser,
} from "@/lib/notes";
import { resolveTestDatabaseUrl } from "../../../../vitest.helpers";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);

const GHOST_NOTE_ID = "00000000-0000-4000-8000-000000000000";

async function seedUser(email: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: "test-hash-not-verified-here" })
    .returning({ id: users.id });
  return user.id;
}

async function seedNote(
  userId: string,
  title: string,
  content: string,
): Promise<string> {
  const [note] = await db
    .insert(notes)
    .values({ userId, title, content })
    .returning({ id: notes.id });
  return note.id;
}

afterAll(async () => {
  await Promise.all([pool.end(), appPool.end()]);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
});

describe("NOTES_CACHE_TTL_SECONDS", () => {
  it("is the documented 60-second staleness bound", () => {
    expect(NOTES_CACHE_TTL_SECONDS).toBe(60);
  });
});

describe("read-through: getNoteForUser", () => {
  it("refills on miss, serves a stale hit without a DB query, and revives Dates", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Original title", "Original content");

    const first = await getNoteForUser(userId, noteId);
    expect(first?.title).toBe("Original title");
    const ttl = await ttlNotesCache(notesNoteKey(userId, noteId));
    expect(ttl).not.toBeNull();
    expect(ttl ?? 0).toBeGreaterThan(0);
    expect(ttl ?? 0).toBeLessThanOrEqual(NOTES_CACHE_TTL_SECONDS);

    const hitsBefore = readCounter("notes_cache_hits_total");
    await db
      .update(notes)
      .set({ title: "Mutated behind the cache" })
      .where(eq(notes.id, noteId));

    const second = await getNoteForUser(userId, noteId);
    expect(second?.title).toBe("Original title");
    expect(second?.createdAt).toBeInstanceOf(Date);
    expect(second?.updatedAt).toBeInstanceOf(Date);
    expect(second?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
    expect(readCounter("notes_cache_hits_total")).toBe(hitsBefore + 1);
  });

  it("repopulates with fresh data after invalidation", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Before", "content");
    await getNoteForUser(userId, noteId);

    const updated = await updateNoteForUser(userId, noteId, {
      title: "After",
    });
    expect(updated?.title).toBe("After");
    expect(await valkey.exists(notesNoteKey(userId, noteId))).toBe(0);

    const fresh = await getNoteForUser(userId, noteId);
    expect(fresh?.title).toBe("After");
    expect(await valkey.exists(notesNoteKey(userId, noteId))).toBe(1);
  });
});

describe("read-through: listNotesForUser", () => {
  it("refills on miss, serves a stale hit, and revives Dates", async () => {
    const userId = await seedUser("owner@example.com");
    await seedNote(userId, "Only note", "content");

    const first = await listNotesForUser(userId);
    expect(first).toHaveLength(1);
    const ttl = await ttlNotesCache(notesListKey(userId));
    expect(ttl).not.toBeNull();
    expect(ttl ?? 0).toBeGreaterThan(0);
    expect(ttl ?? 0).toBeLessThanOrEqual(NOTES_CACHE_TTL_SECONDS);

    const hitsBefore = readCounter("notes_cache_hits_total");
    await db.insert(notes).values({ userId, title: "Second", content: "x" });

    const stale = await listNotesForUser(userId);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.updatedAt).toBeInstanceOf(Date);
    expect(readCounter("notes_cache_hits_total")).toBe(hitsBefore + 1);
  });

  it("caches an empty list as a value", async () => {
    const userId = await seedUser("empty@example.com");

    expect(await listNotesForUser(userId)).toEqual([]);
    expect(await valkey.exists(notesListKey(userId))).toBe(1);
  });

  it("repopulates with fresh data after invalidation", async () => {
    const userId = await seedUser("owner@example.com");
    await seedNote(userId, "Before", "content");
    expect(await listNotesForUser(userId)).toHaveLength(1);

    const created = await createNoteForUser(userId, "After", "content");
    expect(created.ok).toBe(true);
    expect(await valkey.exists(notesListKey(userId))).toBe(0);

    const fresh = await listNotesForUser(userId);
    expect(fresh).toHaveLength(2);
    expect(await valkey.exists(notesListKey(userId))).toBe(1);
  });
});

describe("post-commit invalidation per write op", () => {
  it("create deletes the list key", async () => {
    const userId = await seedUser("owner@example.com");
    const listKey = notesListKey(userId);
    await listNotesForUser(userId);
    expect(await valkey.exists(listKey)).toBe(1);

    const created = await createNoteForUser(userId, "T", "C");
    expect(created.ok).toBe(true);
    expect(await valkey.exists(listKey)).toBe(0);
  });

  it("update deletes the list and note keys", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Before", "content");
    const listKey = notesListKey(userId);
    const noteKey = notesNoteKey(userId, noteId);
    await listNotesForUser(userId);
    await getNoteForUser(userId, noteId);
    expect(await valkey.exists(listKey)).toBe(1);
    expect(await valkey.exists(noteKey)).toBe(1);

    await updateNoteForUser(userId, noteId, { title: "After" });
    expect(await valkey.exists(listKey)).toBe(0);
    expect(await valkey.exists(noteKey)).toBe(0);
  });

  it("delete deletes the list and note keys", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Doomed", "content");
    const listKey = notesListKey(userId);
    const noteKey = notesNoteKey(userId, noteId);
    await listNotesForUser(userId);
    await getNoteForUser(userId, noteId);

    expect(await deleteNoteForUser(userId, noteId)).toBe(true);
    expect(await valkey.exists(listKey)).toBe(0);
    expect(await valkey.exists(noteKey)).toBe(0);
    expect(await getNoteForUser(userId, noteId)).toBeNull();
  });

  it("restore deletes the list and note keys", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "V1", "V1 content");
    if (!created.ok) throw new Error("expected created");
    const noteId = created.note.id;
    await updateNoteForUser(userId, noteId, { title: "V2", content: "V2" });
    await checkpointNoteVersionForUser(userId, noteId);

    await listNotesForUser(userId);
    await getNoteForUser(userId, noteId);
    const listKey = notesListKey(userId);
    const noteKey = notesNoteKey(userId, noteId);
    expect(await valkey.exists(listKey)).toBe(1);
    expect(await valkey.exists(noteKey)).toBe(1);

    const [creationVersion] = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId))
      .orderBy(noteVersions.createdAt);
    if (!creationVersion) throw new Error("expected the creation version");

    const restored = await restoreNoteVersionForUser(
      userId,
      noteId,
      creationVersion.id,
    );
    expect(restored?.title).toBe("V1");
    expect(await valkey.exists(listKey)).toBe(0);
    expect(await valkey.exists(noteKey)).toBe(0);
  });

  it("the no-op update path (no applicable fields) is not a write and invalidates nothing", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Steady", "content");
    const noteKey = notesNoteKey(userId, noteId);
    const listKey = notesListKey(userId);
    await listNotesForUser(userId);
    await getNoteForUser(userId, noteId);
    expect(await valkey.exists(noteKey)).toBe(1);
    expect(await valkey.exists(listKey)).toBe(1);

    await updateNoteForUser(userId, noteId, {});
    expect(await valkey.exists(noteKey)).toBe(1);
    expect(await valkey.exists(listKey)).toBe(1);
  });
});

describe("failed writes do not invalidate", () => {
  it("foreign-user update/delete/restore leave the owner's populated cache intact", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNote(ownerId, "Private", "content");
    const listKey = notesListKey(ownerId);
    const noteKey = notesNoteKey(ownerId, noteId);
    await listNotesForUser(ownerId);
    await getNoteForUser(ownerId, noteId);

    expect(
      await updateNoteForUser(attackerId, noteId, { title: "Hacked" }),
    ).toBeNull();
    expect(await deleteNoteForUser(attackerId, noteId)).toBe(false);
    expect(await valkey.exists(listKey)).toBe(1);
    expect(await valkey.exists(noteKey)).toBe(1);

    expect(
      await restoreNoteVersionForUser(attackerId, noteId, GHOST_NOTE_ID),
    ).toBeNull();
    expect(await valkey.exists(listKey)).toBe(1);
    expect(await valkey.exists(noteKey)).toBe(1);
  });
});

describe("cross-user isolation", () => {
  it("keys are user-specific; B never sees A's cached note and B's null is not cached", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNote(ownerId, "A's secret", "content");

    const ownerView = await getNoteForUser(ownerId, noteId);
    expect(ownerView?.title).toBe("A's secret");
    expect(notesNoteKey(ownerId, noteId)).not.toBe(
      notesNoteKey(attackerId, noteId),
    );
    expect(notesListKey(ownerId)).not.toBe(notesListKey(attackerId));

    const missesBefore = readCounter("notes_cache_misses_total");
    expect(await getNoteForUser(attackerId, noteId)).toBeNull();
    expect(readCounter("notes_cache_misses_total")).toBe(missesBefore + 1);
    expect(await valkey.exists(notesNoteKey(attackerId, noteId))).toBe(0);
    expect(await valkey.exists(notesNoteKey(ownerId, noteId))).toBe(1);
  });
});

describe("never-cache-null", () => {
  it("a nonexistent but well-formed note id leaves no key behind", async () => {
    const userId = await seedUser("owner@example.com");
    const noteKey = notesNoteKey(userId, GHOST_NOTE_ID);

    expect(await getNoteForUser(userId, GHOST_NOTE_ID)).toBeNull();
    expect(await valkey.exists(noteKey)).toBe(0);
  });
});

describe("valkey-down fallback and recovery", () => {
  it("reads return correct DB data while valkey fails, then caching resumes", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Resilient", "content");
    const listKey = notesListKey(userId);
    const noteKey = notesNoteKey(userId, noteId);
    await delNotesCache(listKey);
    await delNotesCache(noteKey);

    vi.spyOn(valkey, "get").mockRejectedValue(new Error("valkey down"));
    vi.spyOn(valkey, "set").mockRejectedValue(new Error("valkey down"));

    const note = await getNoteForUser(userId, noteId);
    expect(note?.title).toBe("Resilient");
    const list = await listNotesForUser(userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Resilient");

    vi.restoreAllMocks();
    expect(await valkey.exists(noteKey)).toBe(0);
    const refilled = await getNoteForUser(userId, noteId);
    expect(refilled?.title).toBe("Resilient");
    expect(await valkey.exists(noteKey)).toBe(1);
  });
});
