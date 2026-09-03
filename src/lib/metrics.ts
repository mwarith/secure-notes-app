/**
 * Process-wide counter registry, anchored on globalThis: Next.js compiles
 * each bundle separately and module state is bundle-local, so an unanchored
 * Map would give /api/metrics blind spots. The registry lives and dies with
 * the process — the epoch below is what makes that restart visible.
 */
const counters = ((globalThis as { __appMetricsCounters?: Map<string, number> })
  .__appMetricsCounters ??= new Map<string, number>());

/** Process-start epoch, shared across bundles via globalThis. */
const processStartedAtMs = ((globalThis as {
  __appMetricsCountersStartedAt?: number;
}).__appMetricsCountersStartedAt ??= Date.now());

/** In-memory counter seam for observability; call sites must not change. */
export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounter(name: string): number {
  return counters.get(name) ?? 0;
}

/** Process-start epoch in milliseconds. */
export function processStartedAtEpochMs(): number {
  return processStartedAtMs;
}
