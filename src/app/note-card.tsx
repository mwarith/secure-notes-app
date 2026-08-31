import type { NoteSummary } from "@/lib/notes";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function NoteCard({ note }: { note: NoteSummary }) {
  return (
    <li
      tabIndex={0}
      className="focus-visible:ring-ring/50 flex h-44 flex-col justify-between gap-2 rounded-xl border bg-card p-4 shadow-sm outline-none transition-[translate,box-shadow] hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-3"
    >
      <div className="min-h-0 overflow-hidden">
        {note.title !== "" && (
          <h2 className="mb-1 line-clamp-2 break-words font-semibold">
            {note.title}
          </h2>
        )}
        {note.content !== "" && (
          <p className="text-muted-foreground line-clamp-6 break-words whitespace-pre-line text-sm">
            {note.content}
          </p>
        )}
      </div>
      <p className="text-muted-foreground shrink-0 text-xs">
        Edited {dateFormatter.format(note.updatedAt)}
      </p>
    </li>
  );
}
