import { Redis } from "ioredis";

/**
 * Shared Valkey client, tuned to bound failure TIME when Valkey is
 * unreachable: operations reject in <= ~2s (drill-verified) instead of
 * hanging for tens of seconds, so every consumer's degradation path — cache
 * miss, session Postgres fallback, limiter fail-open/fail-closed — fires
 * immediately.
 *
 * - connectTimeout: 1000 bounds each connect attempt (default is 10s).
 * - retryStrategy reconnects forever with delays capped at 1s; it must
 *   NEVER return a non-number, or ioredis stops reconnecting and recovery
 *   dies.
 * - enableOfflineQueue: false rejects commands issued while disconnected
 *   instead of queueing them. Boot window: pre-connection ops reject
 *   immediately — every consumer already degrades on rejection.
 * - maxRetriesPerRequest: 2 keeps the per-command bound small.
 *
 * Session CREATION remains a hard dependency (reads fall back to Postgres).
 */
export const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  connectTimeout: 1000,
  retryStrategy: (times) => Math.min(100 * times, 1000),
  enableOfflineQueue: false,
});
