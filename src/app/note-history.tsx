"use client";

import { useEffect, useState } from "react";
import { listNoteVersionsAction } from "./actions";
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

export function NoteHistory({ noteId }: { noteId: string }) {
  const [history, setHistory] = useState<HistoryState>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
              onClick={() =>
                setSelectedId((current) =>
                  current === version.id ? null : version.id,
                )
              }
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
          <p className="text-muted-foreground text-xs">
            Viewing version from {dateFormatter.format(selected.createdAt)}
          </p>
          <p className="mt-1 font-semibold">
            {selected.title !== "" ? selected.title : "(untitled)"}
          </p>
          <p className="text-muted-foreground mt-1 whitespace-pre-line text-sm">
            {selected.content}
          </p>
        </div>
      )}
    </div>
  );
}
