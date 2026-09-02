/**
 * Process-wide counter registry. Next.js compiles route handlers/actions
 * and pages into separate server bundles, and module-level state is
 * bundle-local — an in-memory Map here would give each bundle its own
 * counters, making /api/metrics blind to increments from actions and
 * pages (found live in ENG-39). Anchoring on globalThis (the standard
 * Next.js singleton pattern, like the Prisma-client dedup) makes the Map
 * one process-wide instance regardless of bundle.
 */
const counters = ((globalThis as { __appMetricsCounters?: Map<string, number> })
  .__appMetricsCounters ??= new Map<string, number>());

/**
 * In-memory counter seam for observability. ENG-30 wires this to Prometheus
 * via /api/metrics — call sites must not change.
 */
export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounter(name: string): number {
  return counters.get(name) ?? 0;
}
