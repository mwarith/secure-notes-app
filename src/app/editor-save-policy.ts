export type SaveTrigger = "close" | "debounce" | "blur";

export type SaveDecision = "ignore" | "submit" | "abandon" | "close";

export type EditorFields = { title: string; content: string };

/**
 * Pure decision core for the note editor's save triggers.
 *
 * Rules:
 * - pending → "ignore": one save in flight at a time; a close attempt during
 *   a flight must never unmount the form over the running action.
 * - "close": with a shown error, unchanged since the failed attempt (or no
 *   outstanding snapshot at all) → "abandon", so a failed save can never
 *   trap the dialog in a resubmit loop; typed more since the failure →
 *   "submit" as a retry, so keystrokes are never silently discarded.
 *   Otherwise dirty against lastSaved → "submit", clean → "close".
 * - "debounce"/"blur": dirty → "submit", clean → "ignore". The save status
 *   is deliberately not consulted for these triggers.
 *
 * WHY the dirty checks live here: updateNoteForUser stores values verbatim
 * and treats an identical-value write as a real write (updatedAt bump plus a
 * note.updated audit event); its honest no-op only applies when there are no
 * applicable string fields at all (pinned §3 decision from ENG-9). Avoiding
 * meaningless saves is therefore the client's job.
 */
export function resolveEditorSave(input: {
  trigger: SaveTrigger;
  pending: boolean;
  status: "idle" | "success" | "error";
  fields: EditorFields;
  lastSaved: EditorFields;
  failedAttempt: EditorFields | null;
}): SaveDecision {
  if (input.pending) {
    return "ignore";
  }

  const dirty =
    input.fields.title !== input.lastSaved.title ||
    input.fields.content !== input.lastSaved.content;

  if (input.trigger === "close") {
    if (input.status === "error") {
      const unchangedSinceFailure =
        input.failedAttempt === null ||
        (input.failedAttempt.title === input.fields.title &&
          input.failedAttempt.content === input.fields.content);
      return unchangedSinceFailure ? "abandon" : "submit";
    }
    return dirty ? "submit" : "close";
  }

  return dirty ? "submit" : "ignore";
}
