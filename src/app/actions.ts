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
import { AppError, reportError, toActionError } from "@/lib/errors";

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
  try {
    return await runCreate(formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    // Classified expected failures (empty_note, invalid_user) pass through
    // toActionError with no capture; user_input/auth own their feedback and
    // audit sites, and double-logging them would be a defect. Only an
    // unclassified infrastructure throw is captured, as operational.
    if (error instanceof AppError) {
      return {
        status: "error",
        message: toActionError(error, { message: GENERIC_ERROR_MESSAGE })
          .message,
      };
    }
    return {
      status: "error",
      message: captureOperational(GENERIC_ERROR_MESSAGE).userMessage,
    };
  }
}

async function runCreate(formData: FormData): Promise<CreateNoteFormState> {
  const session = await getActiveSession();

  const result = await createNoteForUser(
    session.userId,
    formData.get("title"),
    formData.get("content"),
  );

  if (!result.ok) {
    if (result.reason === "empty_note") {
      throw new AppError({ class: "user_input", userMessage: EMPTY_NOTE_MESSAGE });
    }
    throw new AppError({ class: "auth", userMessage: GENERIC_ERROR_MESSAGE });
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

/**
 * The autosave failure state: the dedicated autosave observability stays
 * (its own event and counter), and the user-facing shape is produced via
 * toActionError so `retryable` is derived from the operational class rather
 * than hand-rolled.
 */
function transientSaveFailure(
  userId: string | null,
  noteId: string | null,
): UpdateNoteFormState {
  log("error", "autosave.save_failed", { userId, noteId });
  incrementCounter("autosave_failures_total");
  const { message, retryable } = toActionError(
    captureOperational(TRANSIENT_SAVE_FAILURE_MESSAGE),
    { message: TRANSIENT_SAVE_FAILURE_MESSAGE },
  );
  return { status: "error", message, retryable };
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
    const { message, retryable } = toActionError(
      new AppError({ class: "auth", userMessage: NOTE_UNAVAILABLE_MESSAGE }),
      { message: NOTE_UNAVAILABLE_MESSAGE },
    );
    return { status: "error", message, retryable };
  }

  return { status: "success" };
}

export async function listNoteVersionsAction(
  noteId: unknown,
): Promise<NoteVersion[]> {
  try {
    return await runListVersions(noteId);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    // The history panel owns the error display; re-throw the classified
    // failure so the client's existing catch shows its message unchanged.
    throw captureOperational("Couldn't load history.");
  }
}

async function runListVersions(noteId: unknown): Promise<NoteVersion[]> {
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
  try {
    return await runRestore(noteId, versionId);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    captureOperational("Couldn't restore this version.");
    return { ok: false };
  }
}

async function runRestore(
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
 * A failed checkpoint reports "not created" after capture — the client's
 * swallow points stay UI-silent on purpose (a missed routine snapshot must
 * never nag), the capture here is the observability.
 */
export async function checkpointNoteVersionAction(
  noteId: unknown,
): Promise<{ created: boolean }> {
  try {
    return await runCheckpoint(noteId);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    captureOperational("Couldn't capture this version.");
    return { created: false };
  }
}

async function runCheckpoint(noteId: unknown): Promise<{ created: boolean }> {
  const session = await getActiveSession();

  const noteIdText = typeof noteId === "string" ? noteId : null;

  const result = await checkpointNoteVersionForUser(
    session.userId,
    noteIdText ?? "",
  );

  return { created: result?.created ?? false };
}

export type DeleteNoteResult = { ok: boolean; error?: string };

/**
 * The boolean no-op (already deleted or foreign note) stays deliberately
 * indistinguishable and error-free; only an unexpected infrastructure
 * failure returns the classified safe error message alongside ok: false.
 */
export async function deleteNoteAction(
  noteId: unknown,
): Promise<DeleteNoteResult> {
  try {
    return await runDelete(noteId);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    const { message } = toActionError(
      captureOperational("Couldn't delete this note. Please try again."),
      { message: "Couldn't delete this note. Please try again." },
    );
    return { ok: false, error: message };
  }
}

async function runDelete(noteId: unknown): Promise<DeleteNoteResult> {
  const session = await getActiveSession();

  const noteIdText = typeof noteId === "string" ? noteId : null;

  const deleted = await deleteNoteForUser(session.userId, noteIdText ?? "");

  revalidatePath("/");

  return { ok: deleted };
}

/**
 * Classifies an infrastructure failure as operational, captures it once via
 * reportError (warn level + errors.operational), and hands back the
 * AppError for callers that re-throw it.
 */
function captureOperational(userMessage: string): AppError {
  const classified = new AppError({ class: "operational", userMessage });
  reportError(classified, { message: userMessage });
  return classified;
}
