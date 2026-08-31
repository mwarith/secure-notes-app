import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { noteVersions, notes } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";

const VERSION_CHECKPOINT_MS = 5 * 60 * 1000;

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
 * transaction, so a note never exists without its audit record. Unlike the
 * read functions, a failed create is ordinary validation rather than the
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
 *
 * When the update succeeds, a Note version snapshot may be captured in the
 * same transaction (PRD §7). A version records a saved state: it stores the
 * post-update title and content. The boundary rule — insert a version when
 * no prior version exists for the note, or when the saved values differ
 * exactly from the most recent version AND either the caller forced a
 * checkpoint (the editor closing) or at least VERSION_CHECKPOINT_MS have
 * passed since that version was created. Identical-value saves never
 * snapshot, and routine snapshots write no audit event (restoration is
 * ENG-23). Update, optional version, and audit commit or roll back together.
 */
export async function updateNoteForUser(
  userId: string,
  noteId: string,
  changes: { title?: string; content?: string },
  options?: { checkpoint?: boolean },
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

    const [lastVersion] = await tx
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, note.id))
      .orderBy(desc(noteVersions.createdAt))
      .limit(1);

    let shouldSnapshot: boolean;
    if (!lastVersion) {
      shouldSnapshot = true;
    } else {
      const differs =
        lastVersion.title !== note.title ||
        lastVersion.content !== note.content;
      const due =
        Date.now() - lastVersion.createdAt.getTime() >= VERSION_CHECKPOINT_MS;
      shouldSnapshot = differs && (options?.checkpoint === true || due);
    }

    if (shouldSnapshot) {
      await tx.insert(noteVersions).values({
        noteId: note.id,
        title: note.title,
        content: note.content,
      });
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
