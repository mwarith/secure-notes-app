import { Redis } from "ioredis";

/**
 * Shared Valkey client. maxRetriesPerRequest is deliberately low (ioredis
 * default is 20): when Valkey is unreachable, commands must fail in well under
 * a second so the app's fail-open and graceful-degradation paths can kick in
 * instead of hanging every request for ~70s. Session CREATION during an outage
 * remains a hard dependency (documented ENG-X limitation).
 */
export const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
});
