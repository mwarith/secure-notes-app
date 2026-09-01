"use client";

import { useEffect, useState } from "react";
import { listNoteVersionsAction, restoreNoteVersionAction } from "./actions";
import { Button } from "@/components/ui/button";
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
import type { NoteVersion } from "@/lib/notes";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type HistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; versions: NoteVersion[] };

export function NoteHistory({
  noteId,
  onRestored,
}: {
  noteId: string;
  onRestored: () => void;
}) {
  const [history, setHistory] = useState<HistoryState>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listNoteVersionsAction(noteId)
      .then((versions) => {
        if (!cancelled) setHistory({ status: "ready", versions });
      })
      .catch(() => {
        if (!cancelled) setHistory({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  if (history.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  if (history.status === "error") {
    return <p className="text-destructive text-sm">Couldn&apos;t load history.</p>;
  }

  const selected = history.versions.find((v) => v.id === selectedId) ?? null;

  async function handleRestore(version: NoteVersion) {
    setRestoreError(false);
    setIsRestoring(true);
    try {
      const result = await restoreNoteVersionAction(noteId, version.id);
      if (!result.ok) {
        setRestoreError(true);
        return;
      }
      onRestored();
    } catch {
      setRestoreError(true);
    } finally {
      setIsRestoring(false);
    }
  }

  if (history.versions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No versions yet — versions are captured when you finish editing.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {history.versions.map((version) => (
          <li key={version.id}>
            <button
              type="button"
              aria-pressed={selectedId === version.id}
              onClick={() => {
                setRestoreError(false);
                setSelectedId((current) =>
                  current === version.id ? null : version.id,
                );
              }}
              className="border-border/70 hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm shadow-sm transition-colors outline-none focus-visible:ring-3"
            >
              <span className="text-muted-foreground shrink-0 text-xs">
                {dateFormatter.format(version.createdAt)}
              </span>
              <span className="truncate">
                {version.title !== "" ? version.title : "(untitled)"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="bg-muted/40 max-h-64 overflow-y-auto rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Viewing version from {dateFormatter.format(selected.createdAt)}
            </p>
            <AlertDialog
              open={confirmOpen}
              onOpenChange={(next) => {
                if (!isRestoring) setConfirmOpen(next);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  Restore
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restore this version?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The current content will be replaced.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isRestoring}>
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={isRestoring}
                    onClick={(event) => {
                      event.preventDefault();
                      void handleRestore(selected);
                    }}
                  >
                    {isRestoring ? "Restoring…" : "Restore"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <p className="mt-1 font-semibold">
            {selected.title !== "" ? selected.title : "(untitled)"}
          </p>
          <p className="text-muted-foreground mt-1 whitespace-pre-line text-sm">
            {selected.content}
          </p>
          {restoreError && (
            <p className="text-destructive mt-2 text-sm">
              Couldn&apos;t restore this version.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
