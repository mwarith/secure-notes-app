import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notes } from "@/db/schema";
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
 * transaction, so a note never exists without its audit record. Unlike the
 * read functions, a failed create is ordinary validation rather than the
 * access-denial boundary, so it returns a discriminated union with the
 * specific reason instead of null.
 */

export type Note = typeof notes.$inferSelect;

export type NoteSummary = {
  id: string;
  title: string;
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
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt));
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
