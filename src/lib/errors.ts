import { log } from "./logger";
import { incrementCounter } from "./metrics";

export type AppErrorClass =
  | "user_input"
  | "auth"
  | "operational"
  | "unexpected";

const RETRYABLE_BY_CLASS: Readonly<Record<AppErrorClass, boolean>> = {
  user_input: false,
  auth: false,
  operational: true,
  unexpected: false,
};

/**
 * A classified failure raised by feature code.
 *
 * `class` is one of the four PRD §9 error classes and is the single source
 * of truth: `retryable` is derived from it, with no per-instance override.
 * `userMessage` is the only text ever shown to the user. `detail` is
 * internal capture for investigation and must never reach the interface —
 * keep secrets, tokens, and passwords out of it.
 */
export class AppError extends Error {
  readonly class: AppErrorClass;
  readonly userMessage: string;
  readonly detail?: string;

  constructor(fields: {
    class: AppErrorClass;
    userMessage: string;
    detail?: string;
  }) {
    super(fields.userMessage);
    this.name = "AppError";
    Object.setPrototypeOf(this, AppError.prototype);
    this.class = fields.class;
    this.userMessage = fields.userMessage;
    this.detail = fields.detail;
  }

  get retryable(): boolean {
    return RETRYABLE_BY_CLASS[this.class];
  }
}

/**
 * Pure normalizer from a thrown/returned value to the shape the form-state
 * unions serve ({ status: "error"; message; retryable }). No logging, no
 * counters — an action that only needs safe messaging uses this.
 *
 * Rules:
 * - An AppError yields its userMessage and its class-derived retryability.
 * - Anything else — an unknown Error, a thrown string, null, a plain
 *   object — yields the fallback message with "unexpected" semantics
 *   (retryable: false). The normalizer never crashes on a non-Error value
 *   and never echoes raw error.message from unknown throwables.
 */
export function toActionError(
  error: unknown,
  fallback: { message: string },
): { message: string; retryable: boolean } {
  if (error instanceof AppError) {
    return { message: error.userMessage, retryable: error.retryable };
  }
  return { message: fallback.message, retryable: false };
}

/**
 * Same return shape as toActionError, plus internal capture for the two
 * classes that own no dedicated audit event:
 *
 * - "operational" logs one structured line at warn and increments
 *   errors.operational — a temporary infrastructure failure (a failed
 *   Autosave flush, a lost DB connection) is an operations concern.
 * - "unexpected" logs at error and increments errors.unexpected — a bug or
 *   unclassified failure must be captured internally while the user sees
 *   only the safe fallback message.
 *
 * "user_input" and "auth" return the shape WITHOUT logging or counting:
 * their call sites already own dedicated audit events (login.failed,
 * account.locked-style auth boundaries), and double-logging here would be
 * a defect. Waiting out a Rate limit window is the recovery for auth, not
 * a retry; user input is fixed by the user, not re-attempted as-is.
 */
export function reportError(
  error: unknown,
  fallback: { message: string },
): { message: string; retryable: boolean } {
  const result = toActionError(error, fallback);
  const errorClass: AppErrorClass =
    error instanceof AppError ? error.class : "unexpected";
  if (errorClass === "operational" || errorClass === "unexpected") {
    const detail = error instanceof AppError ? error.detail : undefined;
    log(
      errorClass === "operational" ? "warn" : "error",
      "error.captured",
      { class: errorClass, detail },
    );
    incrementCounter(`errors.${errorClass}`);
  }
  return result;
}

export type Prd9CaseId =
  | "auth-fail"
  | "twofa-fail"
  | "unauthorized-action"
  | "invalid-input"
  | "note-save-fail"
  | "autosave-fail"
  | "timeout"
  | "service-unavailable"
  | "restore-fail"
  | "destructive-action-fail";

/**
 * The error class for each of PRD §9's ten clear-feedback cases. The Record
 * is keyed by Prd9CaseId, so a missing or extra case is a compile error,
 * not a runtime surprise.
 */
export const PRD9_CHECKLIST: Readonly<Record<Prd9CaseId, AppErrorClass>> = {
  "auth-fail": "auth",
  "twofa-fail": "auth",
  "unauthorized-action": "auth",
  "invalid-input": "user_input",
  "note-save-fail": "operational",
  "autosave-fail": "operational",
  timeout: "operational",
  "service-unavailable": "operational",
  "restore-fail": "operational",
  "destructive-action-fail": "operational",
};
