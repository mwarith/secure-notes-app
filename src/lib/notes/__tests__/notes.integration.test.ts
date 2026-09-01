import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, noteVersions, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import {
  checkpointNoteVersionForUser,
  createNoteForUser,
  deleteNoteForUser,
  getNoteForUser,
  listNotesForUser,
  listNoteVersionsForUser,
  restoreNoteVersionForUser,
  updateNoteForUser,
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
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
        content: expect.any(String),
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

  it("snapshots the creation state as the note's first version", async () => {
    const userId = await seedUser("owner@example.com");

    const result = await createNoteForUser(
      userId,
      "  My new note  ",
      "Private content",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const versions = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, result.note.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.noteId).toBe(result.note.id);
    expect(versions[0]?.title).toBe("My new note");
    expect(versions[0]?.content).toBe("Private content");
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

describe("updateNoteForUser (integration)", () => {
  async function seedNoteWithOldTimestamp(
    userId: string,
    title: string,
    content: string,
  ): Promise<string> {
    const [note] = await db
      .insert(notes)
      .values({
        userId,
        title,
        content,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning({ id: notes.id });
    return note.id;
  }

  it("updates both fields for the owner and bumps updatedAt", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      userId,
      "Old title",
      "Old content",
    );
    const before = await getNoteForUser(userId, noteId);
    if (!before) throw new Error("expected seeded note to be readable");

    const updated = await updateNoteForUser(userId, noteId, {
      title: "New title",
      content: "New content",
    });

    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(noteId);
    expect(updated?.userId).toBe(userId);
    expect(updated?.title).toBe("New title");
    expect(updated?.content).toBe("New content");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });

  it("fails as not-found when a different user updates someone else's note, leaving the note unchanged", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      ownerId,
      "Owner's title",
      "Owner's content",
    );
    const before = await getNoteForUser(ownerId, noteId);
    if (!before) throw new Error("expected seeded note to be readable");

    const result = await updateNoteForUser(attackerId, noteId, {
      title: "Hacked",
      content: "Hacked",
    });

    expect(result).toBeNull();
    expect(await getNoteForUser(ownerId, noteId)).toEqual(before);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("returns not-found for a nonexistent but well-formed note id", async () => {
    const userId = await seedUser("owner@example.com");

    expect(
      await updateNoteForUser(userId, "00000000-0000-4000-8000-000000000000", {
        title: "New title",
      }),
    ).toBeNull();
  });

  it("returns not-found for malformed ids without a database error", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(userId, "T", "C");

    expect(
      await updateNoteForUser(userId, "not-a-uuid", { title: "X" }),
    ).toBeNull();
    expect(
      await updateNoteForUser("not-a-uuid", noteId, { title: "X" }),
    ).toBeNull();
    expect(
      await updateNoteForUser("not-a-uuid", "also-bad", { title: "X" }),
    ).toBeNull();
  });

  it("updates only the title when only title is provided", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      userId,
      "Old title",
      "Old content",
    );
    const before = await getNoteForUser(userId, noteId);
    if (!before) throw new Error("expected seeded note to be readable");

    const updated = await updateNoteForUser(userId, noteId, {
      title: "New title",
    });

    expect(updated?.title).toBe("New title");
    expect(updated?.content).toBe("Old content");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });

  it("updates only the content when only content is provided", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      userId,
      "Old title",
      "Old content",
    );
    const before = await getNoteForUser(userId, noteId);
    if (!before) throw new Error("expected seeded note to be readable");

    const updated = await updateNoteForUser(userId, noteId, {
      content: "New content",
    });

    expect(updated?.title).toBe("Old title");
    expect(updated?.content).toBe("New content");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });

  it("stores values verbatim without trimming", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(userId, "T", "C");

    const updated = await updateNoteForUser(userId, noteId, {
      title: "  padded  ",
      content: "  kept  ",
    });

    expect(updated?.title).toBe("  padded  ");
    expect(updated?.content).toBe("  kept  ");
  });

  it("updates a note to fully blank title and content", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(userId, "T", "C");

    const updated = await updateNoteForUser(userId, noteId, {
      title: "",
      content: "",
    });

    expect(updated).not.toBeNull();
    expect(updated?.title).toBe("");
    expect(updated?.content).toBe("");
  });

  it("treats non-string values in a provided key as absent", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      userId,
      "Old title",
      "Old content",
    );

    const first = await updateNoteForUser(userId, noteId, {
      title: "Typed",
      content: 42 as unknown as string,
    });
    expect(first?.title).toBe("Typed");
    expect(first?.content).toBe("Old content");

    const second = await updateNoteForUser(userId, noteId, {
      title: 42 as unknown as string,
      content: "Typed",
    });
    expect(second?.title).toBe("Typed");
    expect(second?.content).toBe("Typed");
  });

  it("is a no-op with no write, no updatedAt bump, and no audit when no field applies", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(
      userId,
      "Untouched",
      "Untouched content",
    );
    const before = await getNoteForUser(userId, noteId);
    if (!before) throw new Error("expected seeded note to be readable");

    const emptyChanges = await updateNoteForUser(userId, noteId, {});
    expect(emptyChanges).not.toBeNull();
    expect(emptyChanges).toEqual(before);
    expect(emptyChanges?.updatedAt).toEqual(before.updatedAt);

    const nonStringOnly = await updateNoteForUser(userId, noteId, {
      title: 123 as unknown as string,
    });
    expect(nonStringOnly).toEqual(before);

    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("writes a note.updated audit event in the same transaction as the update", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNoteWithOldTimestamp(userId, "T", "C");

    const updated = await updateNoteForUser(userId, noteId, {
      title: "Audited",
    });
    expect(updated).not.toBeNull();

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("note.updated");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("note");
    expect(event.resourceId).toBe(noteId);
    expect(event.metadata).toEqual({});
  });
});

describe("listNoteVersionsForUser (integration)", () => {
  it("lists the owner's versions newest-first with full fields", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "V1 title", "V1 content");

    await updateNoteForUser(
      userId,
      noteId,
      { title: "V2 title", content: "V2 content" },
    );
    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: true,
    });
    await db
      .update(noteVersions)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 1000) })
      .where(eq(noteVersions.noteId, noteId));
    await updateNoteForUser(userId, noteId, {
      title: "V3 title",
      content: "V3 content",
    });
    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: true,
    });

    const versions = await listNoteVersionsForUser(userId, noteId);

    expect(versions).toHaveLength(2);
    expect(versions[0]?.title).toBe("V3 title");
    expect(versions[0]?.content).toBe("V3 content");
    expect(versions[0]?.createdAt.getTime()).toBeGreaterThan(
      versions[1]?.createdAt.getTime() ?? Infinity,
    );
    expect(versions[1]?.title).toBe("V2 title");
    expect(versions[1]?.content).toBe("V2 content");
    for (const version of versions) {
      expect(version.noteId).toBe(noteId);
      expect(version.id).toEqual(expect.any(String));
      expect(version.createdAt).toBeInstanceOf(Date);
    }
  });

  it("returns an empty list for another user's note", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNote(ownerId, "Private", "Private content");
    await updateNoteForUser(ownerId, noteId, {
      title: "Private v2",
      content: "Private content v2",
    });
    expect(await checkpointNoteVersionForUser(ownerId, noteId)).toEqual({
      created: true,
    });

    expect(await listNoteVersionsForUser(attackerId, noteId)).toEqual([]);
  });

  it("returns an empty list for a nonexistent but well-formed note id", async () => {
    const userId = await seedUser("owner@example.com");

    expect(
      await listNoteVersionsForUser(
        userId,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toEqual([]);
  });

  it("returns an empty list for malformed ids without a database error", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "T", "C");

    expect(await listNoteVersionsForUser(userId, "not-a-uuid")).toEqual([]);
    expect(await listNoteVersionsForUser("not-a-uuid", noteId)).toEqual([]);
    expect(await listNoteVersionsForUser("not-a-uuid", "also-bad")).toEqual([]);
  });

  it("returns an empty list for a note without versions", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "T", "C");

    expect(await listNoteVersionsForUser(userId, noteId)).toEqual([]);
  });
});

describe("deleteNoteForUser (integration)", () => {
  it("deletes the owner's note, cascades its versions, and writes a durable note.deleted audit event", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "Doomed", "Content");
    await db
      .insert(noteVersions)
      .values({ noteId, title: "Doomed", content: "Content" });
    await db
      .insert(noteVersions)
      .values({ noteId, title: "Doomed v2", content: "Content v2" });

    const deleted = await deleteNoteForUser(userId, noteId);

    expect(deleted).toBe(true);
    expect(await getNoteForUser(userId, noteId)).toBeNull();
    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toEqual([]);

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("note.deleted");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("note");
    expect(event.resourceId).toBe(noteId);
    expect(event.metadata).toEqual({});
  });

  it("returns false and leaves the note fully unchanged when a different user attempts deletion", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const noteId = await seedNote(ownerId, "Survivor", "Content");
    await db
      .insert(noteVersions)
      .values({ noteId, title: "Survivor", content: "Content" });

    const deleted = await deleteNoteForUser(attackerId, noteId);

    expect(deleted).toBe(false);

    const surviving = await getNoteForUser(ownerId, noteId);
    expect(surviving?.title).toBe("Survivor");
    expect(surviving?.content).toBe("Content");
    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("returns false for a well-formed nonexistent note id", async () => {
    const userId = await seedUser("owner@example.com");

    expect(
      await deleteNoteForUser(userId, "00000000-0000-4000-8000-000000000000"),
    ).toBe(false);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("returns false for malformed ids without a database error", async () => {
    const userId = await seedUser("owner@example.com");
    const noteId = await seedNote(userId, "T", "C");

    expect(await deleteNoteForUser(userId, "not-a-uuid")).toBe(false);
    expect(await deleteNoteForUser("not-a-uuid", noteId)).toBe(false);
    expect(await deleteNoteForUser("not-a-uuid", "also-bad")).toBe(false);

    expect(await getNoteForUser(userId, noteId)).not.toBeNull();
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe("restoreNoteVersionForUser (integration)", () => {
  it("restores the owner's note to a version, appends the restored state, and audits the restore", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "V1 title", "V1 content");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;

    await updateNoteForUser(userId, noteId, {
      title: "V2 title",
      content: "V2 content",
    });
    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: true,
    });
    const before = await getNoteForUser(userId, noteId);
    if (!before) throw new Error("expected note to be readable");

    const versionsBefore = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    expect(versionsBefore).toHaveLength(2);
    const creationVersion = versionsBefore.find(
      (version) => version.title === "V1 title",
    );
    if (!creationVersion) throw new Error("expected the creation version");

    const restored = await restoreNoteVersionForUser(
      userId,
      noteId,
      creationVersion.id,
    );

    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(noteId);
    expect(restored?.title).toBe("V1 title");
    expect(restored?.content).toBe("V1 content");
    expect(restored?.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );

    const versionsAfter = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId))
      .orderBy(desc(noteVersions.createdAt));
    expect(versionsAfter).toHaveLength(3);
    expect(versionsAfter[0]?.title).toBe("V1 title");
    expect(versionsAfter[0]?.content).toBe("V1 content");
    const priorPairs = versionsAfter
      .slice(1)
      .map((version) => `${version.title}|${version.content}`)
      .sort();
    expect(priorPairs).toEqual(["V1 title|V1 content", "V2 title|V2 content"]);

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.action === "note.updated")).toHaveLength(1);
    const [restoredEvent] = events.filter(
      (event) => event.action === "note.version_restored",
    );
    expect(restoredEvent?.actorUserId).toBe(userId);
    expect(restoredEvent?.resourceType).toBe("note");
    expect(restoredEvent?.resourceId).toBe(noteId);
    expect(restoredEvent?.metadata).toEqual({
      restoredVersionId: creationVersion.id,
    });
  });

  it("restores nothing for another user's note and leaves it fully untouched", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const created = await createNoteForUser(
      ownerId,
      "Private",
      "Private content",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;
    const versions = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const versionId = versions[0]?.id;
    if (!versionId) throw new Error("expected the creation version");
    const before = await getNoteForUser(ownerId, noteId);
    if (!before) throw new Error("expected note to be readable");

    expect(
      await restoreNoteVersionForUser(attackerId, noteId, versionId),
    ).toBeNull();

    expect(await getNoteForUser(ownerId, noteId)).toEqual(before);
    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toHaveLength(1);
    const events = await db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(["note.created"]);
  });

  it("returns null for a nonexistent but well-formed version id", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "T", "C");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      await restoreNoteVersionForUser(
        userId,
        created.note.id,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
    expect(
      (await db.select().from(auditEvents)).map((event) => event.action),
    ).toEqual(["note.created"]);
  });

  it("returns null for malformed ids without a database error", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "T", "C");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;
    const versions = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId));
    const versionId = versions[0]?.id;
    if (!versionId) throw new Error("expected the creation version");

    expect(
      await restoreNoteVersionForUser("not-a-uuid", noteId, versionId),
    ).toBeNull();
    expect(
      await restoreNoteVersionForUser(userId, "not-a-uuid", versionId),
    ).toBeNull();
    expect(
      await restoreNoteVersionForUser(userId, noteId, "not-a-uuid"),
    ).toBeNull();
    expect(
      (await db.select().from(auditEvents)).map((event) => event.action),
    ).toEqual(["note.created"]);
  });
});

describe("checkpointNoteVersionForUser (integration)", () => {
  it("snapshots the current state when it differs from the most recent version", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "T", "C");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;

    await updateNoteForUser(userId, noteId, {
      title: "New",
      content: "Content",
    });
    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toHaveLength(1);

    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: true,
    });

    const versions = await db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId))
      .orderBy(desc(noteVersions.createdAt));
    expect(versions).toHaveLength(2);
    expect(versions[0]?.title).toBe("New");
    expect(versions[0]?.content).toBe("Content");
    expect(versions[1]?.title).toBe("T");
    expect(versions[1]?.content).toBe("C");
    expect(
      (await db.select().from(auditEvents)).map((event) => event.action),
    ).toEqual(["note.created", "note.updated"]);
  });

  it("snapshots nothing when the current state matches the most recent version", async () => {
    const userId = await seedUser("owner@example.com");
    const created = await createNoteForUser(userId, "T", "C");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;

    await updateNoteForUser(userId, noteId, {
      title: "New",
      content: "Content",
    });
    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: true,
    });
    expect(await checkpointNoteVersionForUser(userId, noteId)).toEqual({
      created: false,
    });

    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toHaveLength(2);
  });

  it("returns null for another user's note and writes nothing", async () => {
    const ownerId = await seedUser("owner@example.com");
    const attackerId = await seedUser("attacker@example.com");
    const created = await createNoteForUser(
      ownerId,
      "Private",
      "Private content",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const noteId = created.note.id;

    expect(await checkpointNoteVersionForUser(attackerId, noteId)).toBeNull();

    expect(
      await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(auditEvents)).map((event) => event.action),
    ).toEqual(["note.created"]);
  });

  it("returns null for a nonexistent but well-formed note id", async () => {
    const userId = await seedUser("owner@example.com");

    expect(
      await checkpointNoteVersionForUser(
        userId,
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
  });

  it("returns null for malformed ids without a database error", async () => {
    expect(
      await checkpointNoteVersionForUser(
        "not-a-uuid",
        "00000000-0000-4000-8000-000000000000",
      ),
    ).toBeNull();
    expect(
      await checkpointNoteVersionForUser(
        "00000000-0000-4000-8000-000000000000",
        "not-a-uuid",
      ),
    ).toBeNull();
    expect(
      await checkpointNoteVersionForUser("not-a-uuid", "also-bad"),
    ).toBeNull();
  });
});
