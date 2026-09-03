import pino from "pino";

export type LogLevel = "info" | "warn" | "error";

/**
 * Structured logger: one JSON line per entry on stdout (fd 1), shaped as
 * { ts, level, event, ...fields }. Backed by pino (ENG-16) behind the same
 * seam — call sites must not change.
 *
 * Output contract (consumed downstream, do not break):
 * - `ts` stays an ISO string (custom pino timestamp fn) and `level` stays
 *   the string label (formatters.level maps pino's numeric 30/40/50).
 * - `event` passes through as a top-level field — ENG-40's Loki panels
 *   query `| json | event="..."` and docs/cache-drill.md greps for event
 *   names like cache.valkey_failed.
 * - Plain-stream destination (process.stdout): no pino transports, no
 *   worker threads, no pretty-printing — ENG-52 ships this stdout to Loki
 *   directly.
 * - Secret redaction is mechanical now: exact redact paths censor
 *   password/token/secret/code/recoveryCode/totp at the top level and one
 *   level deep with the censor "[redacted]". Callers must still never pass
 *   secrets, but a mistake is censored rather than leaked. Exact paths
 *   only: event, outcome, noteId, operation, userId etc. are untouched.
 */
const logger = pino(
  {
    level: "info",
    base: null,
    redact: {
      paths: [
        "password",
        "token",
        "secret",
        "code",
        "recoveryCode",
        "totp",
        "*.password",
        "*.token",
        "*.secret",
        "*.code",
        "*.recoveryCode",
        "*.totp",
      ],
      censor: "[redacted]",
    },
    timestamp: () => `,"ts":${JSON.stringify(new Date().toISOString())}`,
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  process.stdout,
);

export function log(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  logger[level]({ event, ...fields });
}
