export type SaveIndicatorState = "saving" | "saved" | "failed" | "idle";

/** Derives the editor's status line in priority order: pending → "saving", error → "failed", savedRecently → "saved", else "idle". */
export function resolveSaveIndicator(input: {
  pending: boolean;
  status: "idle" | "success" | "error";
  savedRecently: boolean;
}): SaveIndicatorState {
  if (input.pending) {
    return "saving";
  }
  if (input.status === "error") {
    return "failed";
  }
  if (input.savedRecently) {
    return "saved";
  }
  return "idle";
}
