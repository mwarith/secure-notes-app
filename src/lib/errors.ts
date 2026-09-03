import { log } from "./logger";
import { incrementCounter } from "./metrics";

/** The four failure classes every user-facing error belongs to. */
export type AppErrorClass =
  | "user_input"
  | "auth"
  | "operational"
  | "unexpected";

/** Retryability is decided by the class alone: only transient
 * infrastructure failures may be retried as-is. */
const RETRYABLE_BY_CLASS: Readonly<Record<AppErrorClass, boolean>> = {
  user_input: false,
  auth: false,
  operational: true,
  unexpected: false,
};

/**
 * A classified failure raised by feature code. `class` drives retryability;
 * `userMessage` is the only text ever shown to the user; `detail` is
 * internal context for investigation and must never reach the interface or
 * contain secrets.
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
 * Normalizes any thrown value to the safe message/retryable shape the
 * forms serve. AppErrors keep their message; anything else gets the
 * fallback message with non-retryable semantics — unknown throwables are
 * never echoed to the user.
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
 * Same shape as toActionError, plus internal capture for operational and
 * unexpected failures (one structured log line + error counter each).
 * user_input and auth failures are neither logged nor counted here — their
 * call sites already audit them (login.failed and friends).
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

/** Every user-facing failure case the product must give clear feedback for. */
export type ErrorCaseId =
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
 * The failure class for each error case. Keyed by ErrorCaseId, so a
 * missing or extra case is a compile error, not a runtime surprise.
 */
export const EXPECTED_ERROR_CASES: Readonly<Record<ErrorCaseId, AppErrorClass>> = {
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
