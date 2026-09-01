import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { noteVersions, notes } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";

/**
 * Ownership-scoped Note reads (PRD §6, §15; CONTEXT.md "Ownership-scoped
 * query").
 *
 * Every query filters by the session user's id in the same WHERE clause that
 * selects the note, so knowing a note id alone never grants access: a note
 * belonging to another user and a nonexistent note id are indistinguishable —
 * both return null, and malformed UUIDs are rejected before the database sees
 * them. There is deliberately no way to fetch a note by id without a user id,
 * so the scope cannot be bypassed by a forgotten permission check.
 *
 * createNoteForUser follows the same ownership discipline on the write side:
 * the user id is an explicit parameter (never derived from a session inside
 * this module), and the insert plus its note.created audit event share one
 * transaction, so a note never exists without its audit record. The same
 * transaction also snapshots the creation state — the stored trimmed title
 * and verbatim content — as the note's first Note version, so the creation
 * state is version #1 (PRD §7) and every later update snapshots against
 * that baseline under the version boundary rules. Unlike the read
 * functions, a failed create is ordinary validation rather than the
 * access-denial boundary, so it returns a discriminated union with the
 * specific reason instead of null.
 */

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

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);

  return note ?? null;
}

export async function listNotesForUser(userId: string): Promise<NoteSummary[]> {
  if (!isUuid(userId)) {
    return [];
  }

  return db
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
}

/**
 * Lists a Note's versions through the same ownership-scoped boundary as the
 * reads: a single join filtered by both the note id and the session user's
 * id, newest first (PRD §7). An empty list means the note has no versions or
 * is not the caller's — denied and no-versions are indistinguishable, the
 * list convention. Malformed ids are rejected before the database sees them.
 */
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
 * Restores an owned note to one of its versions through the same
 * ownership-scoped boundary as the reads: the version is fetched via a
 * single join filtered by the version id, the note id, and the user id, so
 * a foreign note, a foreign version, and a nonexistent version are all
 * indistinguishable — null. Malformed ids are rejected before the database
 * sees them.
 *
 * The note's title and content are replaced by the version's stored state,
 * and the restored state is appended as a NEW Note version in the same
 * transaction: history is append-only (PRD §7) — never rewritten or
 * deleted — so creation is unconditional and the dedupe/threshold boundary
 * rules deliberately do not apply here. One user action produces exactly
 * one audit event, note.version_restored, with the restored version's id
 * in metadata for lineage; no note.updated event is written. Restore,
 * version append, and audit commit or roll back together.
 */
export async function restoreNoteVersionForUser(
  userId: string,
  noteId: string,
  versionId: string,
): Promise<Note | null> {
  if (!isUuid(userId) || !isUuid(noteId) || !isUuid(versionId)) {
    return null;
  }

  return db.transaction(async (tx) => {
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

  return db.transaction(async (tx) => {
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

    return { ok: true, note };
  });
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

  return db.transaction(async (tx) => {
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
}

/**
 * Captures a Note version of an owned note's current state. The trigger is
 * client-driven — the user has been silent for a while, or an editing
 * session just ended — so the server's only guard is the dedupe: the
 * snapshot is written only when the note's current title/content differ
 * exactly from the most recent version (or no version exists, which the
 * creation baseline makes rare). There is deliberately no throttle or
 * spacing rule — the client's silence timer is the rate limiter — and the
 * version history captures the states the user actually stopped on.
 *
 * Routine snapshots write no audit event (restoration is ENG-25's
 * note.version_restored). The ownership-scoped read makes denied and
 * nonexistent notes indistinguishable — null, exactly as getNoteForUser
 * would return; malformed ids are rejected before the database sees them.
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
 * Deletes an owned note through the same authorization boundary as the
 * reads and updates: a single DELETE filtered by both note id and user id.
 * Zero rows means not-found and not-yours are indistinguishable — both
 * return false, and no existence probe ever runs. Malformed ids return
 * false before the database is queried.
 *
 * The boolean return is deliberate: the caller never needs the deleted
 * content (reads return Note | null, create returns a discriminated union,
 * delete returns boolean). Note versions cascade through the
 * note_versions foreign key (onDelete: cascade) — there is no manual
 * version cleanup. The note.deleted audit event is written in the same
 * transaction as the DELETE, so a delete never lands without its audit
 * record; audit_events.resourceId has no foreign key, so the record
 * remains queryable after the note and its versions are gone.
 */
export async function deleteNoteForUser(
  userId: string,
  noteId: string,
): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(noteId)) {
    return false;
  }

  return db.transaction(async (tx) => {
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
}
