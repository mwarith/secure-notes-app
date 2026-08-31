"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { createNoteForUser, updateNoteForUser } from "@/lib/notes";

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
  | { status: "error"; message: string };

const NOTE_UNAVAILABLE_MESSAGE = "This note is no longer available.";

export async function updateNoteAction(
  _prevState: UpdateNoteFormState,
  formData: FormData,
): Promise<UpdateNoteFormState> {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  const noteId = formData.get("noteId");
  const title = formData.get("title");
  const content = formData.get("content");

  const updatedNote = await updateNoteForUser(
    session.userId,
    typeof noteId === "string" ? noteId : "",
    {
      title: typeof title === "string" ? title : undefined,
      content: typeof content === "string" ? content : undefined,
    },
  );

  revalidatePath("/");

  if (!updatedNote) {
    return { status: "error", message: NOTE_UNAVAILABLE_MESSAGE };
  }

  return { status: "success" };
}
