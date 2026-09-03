import { Redis } from "ioredis";

/**
 * Shared Valkey client. maxRetriesPerRequest is deliberately low (ioredis
 * default is 20): when Valkey is unreachable, commands must fail fast so the
 * app's fail-open and graceful-degradation paths can kick in instead of
 * hanging every request. Session CREATION during an outage remains a hard
 * dependency (documented ENG-X limitation).
 *
 * Failure-latency contract (ENG-53, from the ENG-38 outage drill finding F1):
 * operations reject in <= ~2s when Valkey is unreachable — drill-verified
 * after this retune (the pre-retune client measured ~27-28s per failed op:
 * 2 reconnect cycles x ~13s DNS+connect against a blackholed address, making
 * drill journeys 10-60s). The three options that buy that bound:
 *
 * - connectTimeout: 1000 — bounds every connect attempt (initial and
 *   reconnect; ioredis applies it via stream.setTimeout on each connecting
 *   socket). The 10s default is the blackhole cost the drill measured.
 * - retryStrategy: min(100 * times, 1000) — reconnects FOREVER with delays
 *   capped at 1s, so recovery stays automatic (the drill's guarantee).
 *   NEVER return null/undefined here: ioredis treats a non-number return as
 *   "stop reconnecting" (event_handler.js), which would permanently abandon
 *   recovery.
 * - enableOfflineQueue: false — commands issued while disconnected reject
 *   immediately instead of queueing behind reconnect attempts. Cache reads
 *   degrade to misses instantly; session reads hit the durable Postgres
 *   fallback (ENG-15); rate limiters reach their documented fail-open (and
 *   fail-closed TOTP) paths immediately.
 *
 * Boot-window trade-off: operations issued before the first successful
 * connection reject immediately (offline queue off) — every consumer already
 * degrades on rejection, so startup is fast-fail rather than fast-hang.
 * TOTP note: the fail-closed code limiter rejects login attempts instantly
 * during a Valkey blip instead of after ~27s — same outcome, strictly better
 * UX. Recovery needs no code: the reconnect loop keeps trying (1s-capped
 * delays), and the next command after "ready" succeeds.
 */
export const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  connectTimeout: 1000,
  retryStrategy: (times) => Math.min(100 * times, 1000),
  enableOfflineQueue: false,
});
