"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useActionState,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History, Trash2 } from "lucide-react";
import { resolveEditorSave, type EditorFields } from "./editor-save-policy";
import {
  resolveSaveIndicator,
  type SaveIndicatorState,
} from "./save-indicator";
import {
  checkpointNoteVersionAction,
  deleteNoteAction,
  updateNoteAction,
  type UpdateNoteFormState,
} from "./actions";
import { NoteHistory } from "./note-history";
import type { NoteSummary } from "@/lib/notes";

const initialState: UpdateNoteFormState = { status: "idle" };

const AUTOSAVE_DELAY_MS = 2000;

const SAVED_INDICATOR_MS = 2500;

const VERSION_SILENCE_MS = 10_000;

const SAVE_INDICATOR_TEXT: Record<SaveIndicatorState, string> = {
  saving: "Saving…",
  saved: "Saved",
  failed: "Save failed",
  idle: "Changes save when you close the editor.",
};

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [savedRecently, setSavedRecently] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldsRef = useRef<EditorFields>({
    title: note.title,
    content: note.content,
  });
  const lastSavedRef = useRef<EditorFields>({
    title: note.title,
    content: note.content,
  });
  const snapshotRef = useRef<EditorFields | null>(null);
  const failedAttemptRef = useRef<EditorFields | null>(null);
  const closeIntentRef = useRef(false);
  const statusRef = useRef(state.status);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    statusRef.current = state.status;
  }, [state]);

  useEffect(() => {
    if (state.status === "success") {
      const snapshot = snapshotRef.current;
      snapshotRef.current = null;
      failedAttemptRef.current = null;
      if (snapshot) {
        lastSavedRef.current = snapshot;
        setSavedRecently(true);
        if (savedIndicatorTimerRef.current !== null) {
          clearTimeout(savedIndicatorTimerRef.current);
        }
        savedIndicatorTimerRef.current = setTimeout(() => {
          savedIndicatorTimerRef.current = null;
          setSavedRecently(false);
        }, SAVED_INDICATOR_MS);
      }
      if (closeIntentRef.current) {
        closeIntentRef.current = false;
        if (
          snapshot &&
          fieldsRef.current.title === snapshot.title &&
          fieldsRef.current.content === snapshot.content
        ) {
          setSavedRecently(false);
          void checkpointNoteVersionAction(note.id).catch(() => undefined);
          setOpen(false);
        }
      }
      return () => {
        if (savedIndicatorTimerRef.current !== null) {
          clearTimeout(savedIndicatorTimerRef.current);
        }
      };
    }
    if (state.status === "error") {
      failedAttemptRef.current = snapshotRef.current;
      snapshotRef.current = null;
    }
  }, [state, note.id]);

  const dispatchSave = useCallback((closeIntent: boolean) => {
    if (snapshotRef.current) return;
    snapshotRef.current = { ...fieldsRef.current };
    closeIntentRef.current = closeIntent;
    setSavedRecently(false);
    formRef.current?.requestSubmit();
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      autosaveTimerRef.current = null;
      const decision = resolveEditorSave({
        trigger: "debounce",
        pending: snapshotRef.current !== null,
        status: statusRef.current,
        fields: fieldsRef.current,
        lastSaved: lastSavedRef.current,
        failedAttempt: failedAttemptRef.current,
      });
      if (decision === "submit") dispatchSave(false);
    }, AUTOSAVE_DELAY_MS);
    autosaveTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      autosaveTimerRef.current = null;
    };
  }, [title, content, open, dispatchSave]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void checkpointNoteVersionAction(note.id).catch(() => undefined);
    }, VERSION_SILENCE_MS);
    return () => clearTimeout(timer);
  }, [title, content, open, note.id]);

  function handleTitleChange(value: string) {
    fieldsRef.current = { ...fieldsRef.current, title: value };
    setTitle(value);
  }

  function handleContentChange(value: string) {
    fieldsRef.current = { ...fieldsRef.current, content: value };
    setContent(value);
  }

  function handleFieldBlur() {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const decision = resolveEditorSave({
      trigger: "blur",
      pending: snapshotRef.current !== null,
      status: state.status,
      fields: fieldsRef.current,
      lastSaved: lastSavedRef.current,
      failedAttempt: failedAttemptRef.current,
    });
    if (decision === "submit") dispatchSave(false);
  }

  function handleRetry() {
    const decision = resolveEditorSave({
      trigger: "retry",
      pending: snapshotRef.current !== null,
      status: state.status,
      fields: fieldsRef.current,
      lastSaved: lastSavedRef.current,
      failedAttempt: failedAttemptRef.current,
    });
    if (decision === "submit") dispatchSave(false);
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      lastSavedRef.current = { title: note.title, content: note.content };
      // Open is an authoritative resync from server truth: server-side
      // changes (restore, other tabs) must never be silently reverted by a
      // close-flush of stale local fields.
      setTitle(note.title);
      setContent(note.content);
      fieldsRef.current = { title: note.title, content: note.content };
      setSavedRecently(false);
      setHistoryOpen(false);
      setOpen(true);
      return;
    }
    const decision = resolveEditorSave({
      trigger: "close",
      pending: snapshotRef.current !== null,
      status: state.status,
      fields: fieldsRef.current,
      lastSaved: lastSavedRef.current,
      failedAttempt: failedAttemptRef.current,
    });
    if (decision === "ignore") return;
    if (decision === "abandon") {
      handleTitleChange(note.title);
      handleContentChange(note.content);
      setSavedRecently(false);
      setOpen(false);
      return;
    }
    if (decision === "submit") {
      dispatchSave(true);
      return;
    }
    setSavedRecently(false);
    void checkpointNoteVersionAction(note.id).catch(() => undefined);
    setOpen(false);
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await deleteNoteAction(note.id);
    } finally {
      setIsDeleting(false);
      setDeleteOpen(false);
      setHistoryOpen(false);
      setOpen(false);
    }
  }

  const indicator = resolveSaveIndicator({
    pending,
    status: state.status,
    savedRecently,
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Edit note</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((current) => !current)}
            >
              <History className="size-4" aria-hidden />
              History
            </Button>
          </div>
          <DialogDescription
            role="status"
            aria-live="polite"
            className={indicator === "failed" ? "text-destructive" : undefined}
          >
            {SAVE_INDICATOR_TEXT[indicator]}
          </DialogDescription>
        </DialogHeader>
        {historyOpen && (
          <div className="border-t pt-3">
            <NoteHistory
              noteId={note.id}
              onRestored={() => {
                setHistoryOpen(false);
                setOpen(false);
              }}
            />
          </div>
        )}
        <form
          ref={formRef}
          action={formAction}
          className="space-y-4"
          onSubmit={() => {
            if (snapshotRef.current) return;
            snapshotRef.current = { ...fieldsRef.current };
            closeIntentRef.current = false;
            setSavedRecently(false);
          }}
        >
          <input type="hidden" name="noteId" value={note.id} />
          {state.status === "error" && (
            <p className="text-destructive text-sm">{state.message}</p>
          )}
          {state.status === "error" && state.retryable && (
            <Button type="button" variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          )}
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              dir="auto"
              name="title"
              autoComplete="off"
              value={title}
              onChange={(event) => handleTitleChange(event.target.value)}
              onBlur={handleFieldBlur}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-content">Content</Label>
            <textarea
              id="note-content"
              dir="auto"
              name="content"
              rows={12}
              value={content}
              onChange={(event) => handleContentChange(event.target.value)}
              onBlur={handleFieldBlur}
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>
        </form>
        <div className="flex justify-end border-t pt-3">
          <AlertDialog
            open={deleteOpen}
            onOpenChange={(next) => {
              if (!isDeleting) setDeleteOpen(next);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Delete note"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this note?</AlertDialogTitle>
                <AlertDialogDescription>
                  This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel variant="ghost" disabled={isDeleting}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={isDeleting}
                  onClick={(event) => {
                    event.preventDefault();
                    void handleDelete().catch(() => undefined);
                  }}
                >
                  {isDeleting ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </DialogContent>
    </Dialog>
  );
}
