"use client";

import {
  type ReactNode,
  useEffect,
  useActionState,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createNoteAction, type CreateNoteFormState } from "./actions";
import { resolveCreateClose } from "./create-close-policy";

const initialState: CreateNoteFormState = { status: "idle" };

export function CreateNoteDialog({ trigger }: { trigger: ReactNode }) {
  const [state, formAction, pending] = useActionState(
    createNoteAction,
    initialState,
  );
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (state.status === "success") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- closing on server-action completion is external-system sync, not a state cascade
      setOpen(false);
    }
    if (state.status !== "idle") {
      inFlightRef.current = false;
    }
  }, [state]);

  function readFields(): { title: string; content: string } {
    const form = formRef.current;
    if (!form) return { title: "", content: "" };
    const data = new FormData(form);
    return {
      title: String(data.get("title") ?? ""),
      content: String(data.get("content") ?? ""),
    };
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setOpen(true);
      return;
    }
    // Pending-guard first (same philosophy as the editor dialog): one create
    // in flight at a time; a dismissal during the flight must never unmount
    // the form over the running action. Cancel stays available below.
    if (inFlightRef.current) return;
    // A dismissal with typed work creates the Note instead of discarding it
    // (Autosave must never silently discard work); a fully blank dismissal
    // closes silently and never contacts the server.
    if (resolveCreateClose(readFields()) === "dismiss") {
      setOpen(false);
      return;
    }
    formRef.current?.requestSubmit();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
          <DialogDescription>Add a title, some content, or both.</DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          action={formAction}
          className="space-y-4"
          onSubmit={(event) => {
            if (inFlightRef.current) {
              event.preventDefault();
              return;
            }
            inFlightRef.current = true;
          }}
        >
          {state.status === "error" && (
            <p className="text-destructive text-sm">{state.message}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input id="note-title" dir="auto" name="title" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-content">Content</Label>
            <textarea
              id="note-content"
              dir="auto"
              name="content"
              rows={6}
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
