"use client";

import {
  type ReactNode,
  useEffect,
  useActionState,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { updateNoteAction, type UpdateNoteFormState } from "./actions";
import type { NoteSummary } from "@/lib/notes";

const initialState: UpdateNoteFormState = { status: "idle" };

export function NoteEditorDialog({
  note,
  children,
}: {
  note: NoteSummary;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(
    updateNoteAction,
    initialState,
  );
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const formRef = useRef<HTMLFormElement>(null);

  const dirty = title !== note.title || content !== note.content;

  useEffect(() => {
    if (state.status === "success") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- closing on server-action completion is external-system sync, not a state cascade
      setOpen(false);
    }
  }, [state]);

  function handleOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      return;
    }
    if (pending) return;
    if (state.status === "error") {
      setTitle(note.title);
      setContent(note.content);
      setOpen(false);
      return;
    }
    if (dirty) {
      formRef.current?.requestSubmit();
      return;
    }
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit note</DialogTitle>
          <DialogDescription>
            {pending ? "Saving…" : "Changes save when you close the editor."}
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} action={formAction} className="space-y-4">
          <input type="hidden" name="noteId" value={note.id} />
          {state.status === "error" && (
            <p className="text-destructive text-sm">{state.message}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              name="title"
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-content">Content</Label>
            <textarea
              id="note-content"
              name="content"
              rows={12}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
