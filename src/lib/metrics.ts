const counters = new Map<string, number>();

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
