import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { noteVersions, notes } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import {
  delNotesCache,
  getNotesCache,
  notesListKey,
  notesNoteKey,
  setNotesCache,
} from "@/lib/cache";

/**
 * Ownership-scoped note storage. Every query filters by the caller's user id
 * in the same WHERE clause, so knowing a note id never grants access —
 * foreign and nonexistent reads are indistinguishable (null), and malformed
 * ids are rejected before the database is contacted.
 *
 * The two hot reads go through a per-user read-through cache: hits can never
 * leak another user's notes, null is never cached, an empty list is cached,
 * and writes never populate the cache. Invalidation happens after the write
 * commits (failed writes invalidate nothing); the TTL only bounds staleness
 * for the window where invalidation itself failed. Writes and their audit
 * events share one transaction. Version history and checkpoints stay
 * DB-only — there is nothing to invalidate.
 */
export const NOTES_CACHE_TTL_SECONDS = 60;

async function invalidateNoteKeys(userId: string, noteId: string): Promise<void> {
  await Promise.all([
    delNotesCache(notesListKey(userId)),
    delNotesCache(notesNoteKey(userId, noteId)),
  ]);
}

export type Note = typeof notes.$inferSelect;

export type NoteVersion = typeof noteVersions.$inferSelect;

export type NoteSummary = {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateNoteResult =
  | { ok: true; note: Note }
  | { ok: false; reason: "empty_note" | "invalid_user" };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function getNoteForUser(
  userId: string,
  noteId: string,
): Promise<Note | null> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return null;
  }

  const cached = await getNotesCache<Note>(notesNoteKey(userId, noteId));
  if (cached !== null) {
    return cached;
  }

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);

  if (!note) {
    // Never cache null: not-found and foreign reads stay uncached.
    return null;
  }

  await setNotesCache(notesNoteKey(userId, noteId), note, NOTES_CACHE_TTL_SECONDS);
  return note;
}

export async function listNotesForUser(userId: string): Promise<NoteSummary[]> {
  if (!isUuid(userId)) {
    return [];
  }

  const cached = await getNotesCache<NoteSummary[]>(notesListKey(userId));
  if (cached !== null) {
    return cached;
  }

  const summaries = await db
    .select({
      id: notes.id,
      title: notes.title,
      content: notes.content,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt));

  await setNotesCache(notesListKey(userId), summaries, NOTES_CACHE_TTL_SECONDS);
  return summaries;
}

/** Lists an owned note's versions, newest first; empty also covers denied. */
export async function listNoteVersionsForUser(
  userId: string,
  noteId: string,
): Promise<NoteVersion[]> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return [];
  }

  return db
    .select({
      id: noteVersions.id,
      noteId: noteVersions.noteId,
      title: noteVersions.title,
      content: noteVersions.content,
      createdAt: noteVersions.createdAt,
    })
    .from(noteVersions)
    .innerJoin(notes, eq(noteVersions.noteId, notes.id))
    .where(and(eq(noteVersions.noteId, noteId), eq(notes.userId, userId)))
    .orderBy(desc(noteVersions.createdAt));
}

/**
 * Restores an owned note to a version's stored state. History is
 * append-only: the restored state becomes a NEW version in the same
 * transaction, and one audit event (note.version_restored) records the
 * lineage. Denied, foreign, and nonexistent are all null.
 */
export async function restoreNoteVersionForUser(
  userId: string,
  noteId: string,
  versionId: string,
): Promise<Note | null> {
  if (!isUuid(userId) || !isUuid(noteId) || !isUuid(versionId)) {
    return null;
  }

  const note = await db.transaction(async (tx) => {
    const [version] = await tx
      .select({
        title: noteVersions.title,
        content: noteVersions.content,
      })
      .from(noteVersions)
      .innerJoin(notes, eq(noteVersions.noteId, notes.id))
      .where(
        and(
          eq(noteVersions.id, versionId),
          eq(notes.id, noteId),
          eq(notes.userId, userId),
        ),
      )
      .limit(1);

    if (!version) {
      return null;
    }

    const [note] = await tx
      .update(notes)
      .set({ title: version.title, content: version.content })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .returning();

    if (!note) {
      return null;
    }

    await tx.insert(noteVersions).values({
      noteId: note.id,
      title: version.title,
      content: version.content,
    });

    await recordAuditEvent(tx, {
      actorUserId: userId,
      resourceType: "note",
      resourceId: noteId,
      action: "note.version_restored",
      metadata: { restoredVersionId: versionId },
    });

    return note;
  });

  if (note) {
    // Post-commit: a null return (not-found/foreign) wrote nothing and
    // invalidates nothing.
    await invalidateNoteKeys(userId, noteId);
  }

  return note;
}

/**
 * A note may have only a title, only content, or both; it is rejected as
 * empty_note only when both are blank after trimming. Missing or non-string
 * form fields are treated as empty strings, since server actions receive
 * FormDataEntryValue | null. This blankness rule applies to creation only:
 * an existing note may be edited to become fully blank, so the ENG-9 update
 * path must not reuse this check.
 */
export async function createNoteForUser(
  userId: string,
  title: unknown,
  content: unknown,
): Promise<CreateNoteResult> {
  if (!isUuid(userId)) {
    return { ok: false, reason: "invalid_user" };
  }

  const titleText = typeof title === "string" ? title : "";
  const contentText = typeof content === "string" ? content : "";

  if (titleText.trim().length === 0 && contentText.trim().length === 0) {
    return { ok: false, reason: "empty_note" };
  }

  const result = await db.transaction(async (tx) => {
    const [note] = await tx
      .insert(notes)
      .values({ userId, title: titleText.trim(), content: contentText })
      .returning();

    await tx.insert(noteVersions).values({
      noteId: note.id,
      title: titleText.trim(),
      content: contentText,
    });

    await recordAuditEvent(tx, {
      actorUserId: userId,
      resourceType: "note",
      resourceId: note.id,
      action: "note.created",
      metadata: {},
    });

    return { ok: true as const, note };
  });

  if (result.ok) {
    // Post-commit: a new noteId's note key cannot exist yet (null is never
    // cached), so only the list key can be stale.
    await delNotesCache(notesListKey(userId));
  }

  return result;
}

/**
 * Updates an owned note through the same authorization boundary as the
 * reads: a single UPDATE filtered by both note id and user id, with
 * RETURNING providing the row. Zero rows means not-found and not-yours are
 * indistinguishable — null is returned exactly as getNoteForUser would
 * return it, and no existence probe ever runs.
 *
 * Only string-valued fields in changes are applied (partial update); a key
 * holding a non-string value is treated as absent rather than coerced,
 * since coercing on update would silently erase existing content. Values
 * are stored verbatim — no trimming, unlike create. There is deliberately
 * no blankness rule here: a note may be edited down to fully empty title
 * and content (the empty_note rule is create-only).
 *
 * Changes that apply no field are an honest no-op: the current note is
 * returned through the ownership-scoped read, with no write, no updatedAt
 * bump, and no audit event. A successful update writes note.updated in the
 * same transaction as the UPDATE, so a state change never lands without
 * its audit record.
 */
export async function updateNoteForUser(
  userId: string,
  noteId: string,
  changes: { title?: string; content?: string },
): Promise<Note | null> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return null;
  }

  const updates: { title?: string; content?: string } = {};
  if (typeof changes.title === "string") {
    updates.title = changes.title;
  }
  if (typeof changes.content === "string") {
    updates.content = changes.content;
  }

  if (updates.title === undefined && updates.content === undefined) {
    return getNoteForUser(userId, noteId);
  }

  const note = await db.transaction(async (tx) => {
    const [note] = await tx
      .update(notes)
      .set(updates)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .returning();

    if (!note) {
      return null;
    }

    await recordAuditEvent(tx, {
      actorUserId: userId,
      resourceType: "note",
      resourceId: note.id,
      action: "note.updated",
      metadata: {},
    });

    return note;
  });

  if (note) {
    // Post-commit: a null return (not-found/foreign) wrote nothing and
    // invalidates nothing.
    await invalidateNoteKeys(userId, noteId);
  }

  return note;
}

/**
 * Captures an owned note's current state as a version, triggered when the
 * user pauses editing or ends a session. The only server-side guard is the
 * dedupe: a version is written only when the state differs from the most
 * recent one. Routine snapshots write no audit event.
 */
export async function checkpointNoteVersionForUser(
  userId: string,
  noteId: string,
): Promise<{ created: boolean } | null> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return null;
  }

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);

  if (!note) {
    return null;
  }

  const [lastVersion] = await db
    .select()
    .from(noteVersions)
    .where(eq(noteVersions.noteId, note.id))
    .orderBy(desc(noteVersions.createdAt))
    .limit(1);

  const differs =
    !lastVersion ||
    lastVersion.title !== note.title ||
    lastVersion.content !== note.content;

  if (!differs) {
    return { created: false };
  }

  await db.insert(noteVersions).values({
    noteId: note.id,
    title: note.title,
    content: note.content,
  });

  return { created: true };
}

/**
 * Deletes an owned note (versions cascade via foreign key). Zero rows means
 * not-found and not-yours are indistinguishable — false. The note.deleted
 * audit event commits with the delete; the audit row survives the note.
 */
export async function deleteNoteForUser(
  userId: string,
  noteId: string,
): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return false;
  }

  const deleted = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .returning({ id: notes.id });

    if (deleted.length === 0) {
      return false;
    }

    await recordAuditEvent(tx, {
      actorUserId: userId,
      resourceType: "note",
      resourceId: noteId,
      action: "note.deleted",
      metadata: {},
    });

    return true;
  });

  if (deleted) {
    // Post-commit: false (not-found/foreign) wrote nothing and invalidates
    // nothing.
    await invalidateNoteKeys(userId, noteId);
  }

  return deleted;
}
