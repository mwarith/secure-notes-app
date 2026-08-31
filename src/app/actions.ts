"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  createNoteForUser,
  listNoteVersionsForUser,
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
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

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
  const cookieStore = await cookies();
  const noteId = formData.get("noteId");
  const title = formData.get("title");
  const content = formData.get("content");
  const checkpoint = formData.get("checkpoint");
  const noteIdText = typeof noteId === "string" ? noteId : null;

  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return transientSaveFailure(null, noteIdText);
  }

  if (!session) {
    redirect("/login");
  }

  let updatedNote: Awaited<ReturnType<typeof updateNoteForUser>>;
  try {
    updatedNote = await updateNoteForUser(
      session.userId,
      noteIdText ?? "",
      {
        title: typeof title === "string" ? title : undefined,
        content: typeof content === "string" ? content : undefined,
      },
      { checkpoint: checkpoint === "true" },
    );
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
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  return listNoteVersionsForUser(
    session.userId,
    typeof noteId === "string" ? noteId : "",
  );
}
