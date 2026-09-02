import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Lightbulb, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logoutAction } from "./(auth)/login/actions";
import { getActiveSession, isRedirectError } from "@/lib/auth/active-session";
import { AppError, reportError } from "@/lib/errors";
import { listNotesForUser } from "@/lib/notes";
import { CreateNoteDialog } from "./create-note-dialog";
import { NoteCard } from "./note-card";
import { NoteEditorDialog } from "./note-editor-dialog";

const WORKSPACE_OUTAGE_MESSAGE = "Workspace temporarily unavailable.";

/**
 * The outage screen (PRD §9/§17): both the session lookup and the notes
 * query can fail when Postgres is unreachable; neither failure may render
 * as a 500. Each failure is captured as operational so /api/metrics sees it.
 */
function renderOutage() {
  reportError(
    new AppError({
      class: "operational",
      userMessage: WORKSPACE_OUTAGE_MESSAGE,
    }),
    { message: WORKSPACE_OUTAGE_MESSAGE },
  );
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-4 text-center">
      <p className="font-semibold">Secure Notes is temporarily unavailable</p>
      <p className="text-muted-foreground text-sm">
        We couldn&apos;t reach our services. Your saved notes are safe — please try
        again in a moment.
      </p>
    </main>
  );
}

export const metadata: Metadata = {
  title: "Secure Notes",
};

export default async function WorkspacePage() {
  let session: Awaited<ReturnType<typeof getActiveSession>>;
  try {
    session = await getActiveSession();
  } catch (error) {
    // getActiveSession signals auth redirects by throwing; those must keep
    // propagating, not turn into the outage screen.
    if (isRedirectError(error)) {
      throw error;
    }
    return renderOutage();
  }

  if (!session) {
    redirect("/login");
  }

  let notes: Awaited<ReturnType<typeof listNotesForUser>>;
  try {
    notes = await listNotesForUser(session.userId);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    return renderOutage();
  }

  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            Secure Notes
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" asChild>
              <a href="/settings/security">Settings</a>
            </Button>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12">
        <CreateNoteDialog
          trigger={
            <button
              type="button"
              className="border-border/70 hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-ring/50 mt-6 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm text-muted-foreground shadow-sm transition-colors outline-none focus-visible:ring-3"
            >
              <Plus className="size-4" aria-hidden />
              Take a note…
            </button>
          }
        />
        {notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Lightbulb
              className="text-muted-foreground/40 size-12"
              aria-hidden
            />
            <p className="text-muted-foreground mt-4 text-sm">
              Notes you add appear here
            </p>
            <CreateNoteDialog
              trigger={<Button className="mt-4">Create a note</Button>}
            />
          </div>
        ) : (
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {notes.map((note) => (
              <NoteEditorDialog key={note.id} note={note}>
                <NoteCard note={note} />
              </NoteEditorDialog>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
