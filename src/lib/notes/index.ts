import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notes } from "@/db/schema";

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
 */

export type Note = typeof notes.$inferSelect;

export type NoteSummary = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

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
