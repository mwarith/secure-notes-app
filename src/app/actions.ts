"use server";

import { revalidatePath } from "next/cache";
import { getActiveSession, isRedirectError } from "@/lib/auth/active-session";
import {
  checkpointNoteVersionForUser,
  createNoteForUser,
  deleteNoteForUser,
  listNoteVersionsForUser,
  restoreNoteVersionForUser,
  updateNoteForUser,
  type NoteVersion,
} from "@/lib/notes";
import { log } from "@/lib/logger";
import { incrementCounter } from "@/lib/metrics";

export type CreateNoteFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string };

const EMPTY_NOTE_MESSAGE = "Add a title or some content before saving.";
const GENERIC_ERROR_MESSAGE =
  "Unable to save the note right now. Please try again.";

export async function createNoteAction(
  _prevState: CreateNoteFormState,
  formData: FormData,
): Promise<CreateNoteFormState> {
  const session = await getActiveSession();

  const result = await createNoteForUser(
    session.userId,
    formData.get("title"),
    formData.get("content"),
  );

  if (!result.ok) {
    if (result.reason === "empty_note") {
      return { status: "error", message: EMPTY_NOTE_MESSAGE };
    }
    return { status: "error", message: GENERIC_ERROR_MESSAGE };
  }

  revalidatePath("/");
  return { status: "success" };
}

export type UpdateNoteFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string; retryable: boolean };

const NOTE_UNAVAILABLE_MESSAGE = "This note is no longer available.";
const TRANSIENT_SAVE_FAILURE_MESSAGE = "Couldn't save right now. Try again.";

function transientSaveFailure(
  userId: string | null,
  noteId: string | null,
): UpdateNoteFormState {
  log("error", "autosave.save_failed", { userId, noteId });
  incrementCounter("autosave_failures_total");
  return {
    status: "error",
    retryable: true,
    message: TRANSIENT_SAVE_FAILURE_MESSAGE,
  };
}

export async function updateNoteAction(
  _prevState: UpdateNoteFormState,
  formData: FormData,
): Promise<UpdateNoteFormState> {
  const noteId = formData.get("noteId");
  const title = formData.get("title");
  const content = formData.get("content");
  const noteIdText = typeof noteId === "string" ? noteId : null;

  let session: Awaited<ReturnType<typeof getActiveSession>>;
  try {
    session = await getActiveSession();
  } catch (error) {
    // getActiveSession signals auth redirects by throwing; those must keep
    // propagating, not become transient failures.
    if (isRedirectError(error)) {
      throw error;
    }
    return transientSaveFailure(null, noteIdText);
  }

  let updatedNote: Awaited<ReturnType<typeof updateNoteForUser>>;
  try {
    updatedNote = await updateNoteForUser(session.userId, noteIdText ?? "", {
      title: typeof title === "string" ? title : undefined,
      content: typeof content === "string" ? content : undefined,
    });
  } catch {
    return transientSaveFailure(session.userId, noteIdText);
  }

  revalidatePath("/");

  if (!updatedNote) {
    return { status: "error", retryable: false, message: NOTE_UNAVAILABLE_MESSAGE };
  }

  return { status: "success" };
}

export async function listNoteVersionsAction(
  noteId: unknown,
): Promise<NoteVersion[]> {
  const session = await getActiveSession();

  return listNoteVersionsForUser(
    session.userId,
    typeof noteId === "string" ? noteId : "",
  );
}

export async function restoreNoteVersionAction(
  noteId: unknown,
  versionId: unknown,
): Promise<{ ok: boolean }> {
  const session = await getActiveSession();

  const noteIdText = typeof noteId === "string" ? noteId : null;
  const versionIdText = typeof versionId === "string" ? versionId : null;

  const result = await restoreNoteVersionForUser(
    session.userId,
    noteIdText ?? "",
    versionIdText ?? "",
  );

  revalidatePath("/");

  return { ok: result !== null };
}

/**
 * No revalidatePath: version rows are not rendered on the workspace grid.
 */
export async function checkpointNoteVersionAction(
  noteId: unknown,
): Promise<{ created: boolean }> {
  const session = await getActiveSession();

  const noteIdText = typeof noteId === "string" ? noteId : null;

  const result = await checkpointNoteVersionForUser(
    session.userId,
    noteIdText ?? "",
  );

  return { created: result?.created ?? false };
}

export async function deleteNoteAction(
  noteId: unknown,
): Promise<{ ok: boolean }> {
  const session = await getActiveSession();

  const noteIdText = typeof noteId === "string" ? noteId : null;

  const deleted = await deleteNoteForUser(session.userId, noteIdText ?? "");

  revalidatePath("/");

  return { ok: deleted };
}
