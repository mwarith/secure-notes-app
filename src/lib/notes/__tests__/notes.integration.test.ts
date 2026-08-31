import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import {
  createNoteForUser,
  getNoteForUser,
  listNotesForUser,
} from "@/lib/notes";
import { resolveTestDatabaseUrl } from "../../../../vitest.helpers";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);

const PASSWORD_HASH = "test-hash-not-verified-here";

async function seedUser(email: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: PASSWORD_HASH })
    .returning({ id: users.id });
  return user.id;
}

async function seedNote(userId: string, title: string, content: string): Promise<string> {
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
});

describe("getNoteForUser (integration)", () => {
  it("returns the full note for its owner", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "My note", "Private content");

    const note = await getNoteForUser(userId, noteId);

    expect(note).not.toBeNull();
    expect(note?.id).toBe(noteId);
    expect(note?.userId).toBe(userId);
    expect(note?.title).toBe("My note");
    expect(note?.content).toBe("Private content");
    expect(note?.createdAt).toBeInstanceOf(Date);
    expect(note?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns not-found when a different user reads someone else's note", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNote(ownerId, "My note", "Private content");

    expect(await getNoteForUser(attackerId, noteId)).toBeNull();
  });

  it("returns not-found for a nonexistent but well-formed note id", async () => {
    const userId = await seedUser("owner@example.com");

    expect(
      await getNoteForUser(userId, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("returns not-found for a malformed note id without a database error", async () => {
    const userId = await seedUser("owner@example.com");
    await seedNote(userId, "My note", "Private content");

    expect(await getNoteForUser(userId, "not-a-uuid")).toBeNull();
    expect(await getNoteForUser(userId, "")).toBeNull();
    expect(await getNoteForUser(userId, "1; DROP TABLE notes; --")).toBeNull();
  });

  it("returns not-found for a malformed user id", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "My note", "Private content");

    expect(await getNoteForUser("not-a-uuid", noteId)).toBeNull();
  });
});

describe("listNotesForUser (integration)", () => {
  it("returns only the user's own notes, never another user's", async () => {
    const userA = await seedUser("a@example.com");
    const userB = await seedUser("b@example.com");
    const noteA1 = await seedNote(userA, "A1", "content a1");
    const noteA2 = await seedNote(userA, "A2", "content a2");
    const noteB1 = await seedNote(userB, "B1", "content b1");

    const listA = await listNotesForUser(userA);
    const listB = await listNotesForUser(userB);

    expect(listA.map((note) => note.id)).toEqual(
      expect.arrayContaining([noteA1, noteA2]),
    );
    expect(listA).toHaveLength(2);
    expect(listB.map((note) => note.id)).toEqual([noteB1]);

    for (const note of [...listA, ...listB]) {
      expect(note).toEqual({
        id: expect.any(String),
        title: expect.any(String),
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    }
  });

  it("orders notes by updatedAt descending", async () => {
    const userId = await seedUser("owner@example.com");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [older] = await db
      .insert(notes)
      .values({
        userId,
        title: "Older",
        content: "content",
        createdAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
      })
      .returning({ id: notes.id });
    const [newer] = await db
      .insert(notes)
      .values({
        userId,
        title: "Newer",
        content: "content",
        createdAt: oneHourAgo,
        updatedAt: oneHourAgo,
      })
      .returning({ id: notes.id });

    const before = await listNotesForUser(userId);
    expect(before.map((note) => note.id)).toEqual([newer.id, older.id]);

    await db
      .update(notes)
      .set({ title: "Older, touched", updatedAt: new Date() })
      .where(eq(notes.id, older.id));

    const after = await listNotesForUser(userId);
    expect(after.map((note) => note.id)).toEqual([older.id, newer.id]);
  });

  it("returns an empty list for a user with no notes", async () => {
    const userId = await seedUser("empty@example.com");

    expect(await listNotesForUser(userId)).toEqual([]);
  });

  it("returns an empty list for a malformed user id without a database error", async () => {
    expect(await listNotesForUser("not-a-uuid")).toEqual([]);
  });
});

describe("createNoteForUser (integration)", () => {
  it("creates a note owned by the user, trimmed, and immediately retrievable", async () => {
    const userId = await seedUser("owner@example.com");

    const result = await createNoteForUser(
      userId,
      "  My new note  ",
      "Private content",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.userId).toBe(userId);
    expect(result.note.title).toBe("My new note");
    expect(result.note.content).toBe("Private content");
    expect(result.note.createdAt).toBeInstanceOf(Date);
    expect(result.note.updatedAt).toBeInstanceOf(Date);

    const retrieved = await getNoteForUser(userId, result.note.id);
    expect(retrieved?.id).toBe(result.note.id);
    expect(retrieved?.title).toBe("My new note");
  });

  it("shows the created note in the owner's list and nobody else's", async () => {
    const userA = await seedUser("a@example.com");
    const userB = await seedUser("b@example.com");

    const result = await createNoteForUser(userA, "A's note", "content");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const listA = await listNotesForUser(userA);
    const listB = await listNotesForUser(userB);

    expect(listA.map((note) => note.id)).toEqual([result.note.id]);
    expect(listB).toEqual([]);
  });

  it("allows a title-only note", async () => {
    const userId = await seedUser("owner@example.com");

    const result = await createNoteForUser(userId, "Title only", "");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.title).toBe("Title only");
    expect(result.note.content).toBe("");
  });

  it("allows a content-only note", async () => {
    const userId = await seedUser("owner@example.com");

    const result = await createNoteForUser(userId, "   ", "Content only");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.title).toBe("");
    expect(result.note.content).toBe("Content only");
  });

  it("treats missing or non-string fields as empty", async () => {
    const userId = await seedUser("owner@example.com");

    const missingTitle = await createNoteForUser(userId, undefined, "content");
    expect(missingTitle.ok).toBe(true);
    if (!missingTitle.ok) return;
    expect(missingTitle.note.title).toBe("");

    const missingContent = await createNoteForUser(userId, "title", null);
    expect(missingContent.ok).toBe(true);
    if (!missingContent.ok) return;
    expect(missingContent.note.content).toBe("");
  });

  it("writes a note.created audit event in the same transaction as the insert", async () => {
    const userId = await seedUser("owner@example.com");

    const result = await createNoteForUser(userId, "Audited", "content");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("note.created");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("note");
    expect(event.resourceId).toBe(result.note.id);
    expect(event.metadata).toEqual({});
  });

  it("rejects a fully blank note as empty_note", async () => {
    const userId = await seedUser("owner@example.com");

    expect(await createNoteForUser(userId, "", "")).toEqual({
      ok: false,
      reason: "empty_note",
    });
    expect(await createNoteForUser(userId, "   ", "   ")).toEqual({
      ok: false,
      reason: "empty_note",
    });
    expect(await createNoteForUser(userId, undefined, null)).toEqual({
      ok: false,
      reason: "empty_note",
    });

    expect(await listNotesForUser(userId)).toEqual([]);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("rejects a malformed user id as invalid_user without touching the database", async () => {
    expect(
      await createNoteForUser("not-a-uuid", "Title", "content"),
    ).toEqual({ ok: false, reason: "invalid_user" });
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });
});
