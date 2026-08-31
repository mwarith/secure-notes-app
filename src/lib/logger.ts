export type LogLevel = "info" | "warn" | "error";

/**
 * Tiny structured logger: emits one JSON line per entry via console[level],
 * shaped as { ts, level, event, ...fields }.
 *
 * This is the seam ENG-16 replaces with pino — call sites must not change.
 * Callers must never pass secrets (passwords, tokens, session values, 2FA
 * secrets) as fields.
 */
export function log(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  console[level](
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }),
  );
}
