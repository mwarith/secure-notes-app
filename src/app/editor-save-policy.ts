export type SaveTrigger = "close" | "debounce" | "blur" | "retry";

export type SaveDecision = "ignore" | "submit" | "abandon" | "close";

export type EditorFields = { title: string; content: string };

/**
 * Pure decision core for the note editor's save triggers.
 *
 * One save in flight at a time ("pending" ignores new triggers). Close on a
 * shown, unchanged failure abandons (a failed save can never trap the
 * dialog); typing since the failure makes close a retry. Debounce/blur
 * submit only when dirty. Explicit retry always submits. Dirty checks live
 * here because the server treats an identical-value write as a real write
 * (updatedAt bump + audit), so avoiding meaningless saves is the client's
 * job.
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

  if (input.trigger === "retry") {
    return "submit";
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
