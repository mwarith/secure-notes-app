import pino from "pino";

export type LogLevel = "info" | "warn" | "error";

/**
 * Structured logger: one JSON line per entry on stdout, shaped as
 * { ts, level, event, ...fields }. The shape is a downstream contract —
 * Loki panels query `| json | event="..."` — so ts stays an ISO string and
 * level stays a string label. Plain stdout destination, no transports.
 * Secret-shaped fields (password/token/secret/code/recoveryCode/totp,
 * top-level and one level deep) are mechanically censored to "[redacted]";
 * callers must still never pass secrets.
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
