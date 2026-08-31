"use client";

import {
  type ReactNode,
  useEffect,
  useActionState,
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

const initialState: CreateNoteFormState = { status: "idle" };

export function CreateNoteDialog({ trigger }: { trigger: ReactNode }) {
  const [state, formAction, pending] = useActionState(
    createNoteAction,
    initialState,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.status === "success") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- closing on server-action completion is external-system sync, not a state cascade
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
          <DialogDescription>Add a title, some content, or both.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          {state.status === "error" && (
            <p className="text-destructive text-sm">{state.message}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input id="note-title" name="title" autoComplete="off" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-content">Content</Label>
            <textarea
              id="note-content"
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
