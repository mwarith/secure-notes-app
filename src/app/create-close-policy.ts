export type CreateCloseDecision = "dismiss" | "submit";

/**
 * Pure decision core for the New-note dialog's dismissal triggers
 * (outside click, Esc, the X button — anything routing through the
 * Dialog's onOpenChange).
 *
 * Rules:
 * - Both fields blank after trimming → "dismiss": an empty dismissal closes
 *   silently, creates no Note, and never contacts the server. This pairs
 *   with the create-only blank-Note rule (server reason `empty_note`).
 * - Any non-blank field → "submit": a dismissal with typed work creates the
 *   Note instead of discarding it — work must never be silently discarded.
 *
 * Trimming happens here and only here, for the decision alone. The submit
 * path sends the field values exactly as typed; the server-side create
 * already trims the title.
 */
export function resolveCreateClose(fields: {
  title: string;
  content: string;
}): CreateCloseDecision {
  if (fields.title.trim() === "" && fields.content.trim() === "") {
    return "dismiss";
  }
  return "submit";
}
