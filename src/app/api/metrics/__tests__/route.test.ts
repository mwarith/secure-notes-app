import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The counter registry is process-wide on globalThis (see lib/metrics.ts:
 * bundle-local Maps would make /api/metrics blind to increments from other
 * bundles). Each test therefore binds a fresh registry by swapping the
 * globalThis slot before importing the modules, so assertions see exactly
 * their own counter state, and restores the real registry afterwards.
 */
const REGISTRY_HOLDER = globalThis as {
  __appMetricsCounters?: Map<string, number>;
};

describe("GET /api/metrics", () => {
  let restoreRegistry: () => void = () => undefined;

  beforeEach(() => {
    vi.resetModules();
    const original = REGISTRY_HOLDER.__appMetricsCounters;
    REGISTRY_HOLDER.__appMetricsCounters = new Map<string, number>();
    restoreRegistry = () => {
      REGISTRY_HOLDER.__appMetricsCounters = original;
    };
  });

  afterEach(() => restoreRegistry());

  async function getMetricsResponse(): Promise<Response> {
    const { GET } = await import("@/app/api/metrics/route");
    return GET();
  }

  it("returns a valid empty exposition without throwing on an empty counter map", async () => {
    const response = await getMetricsResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(await response.text()).toBe("");
  });

  it("exposes incremented counters with HELP/TYPE and the documented dot mapping", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected", 3);
    incrementCounter("errors.operational");
    incrementCounter("autosave_failures_total", 2);

    const response = await getMetricsResponse();

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("# HELP app_errors_total ");
    expect(body).toContain("# TYPE app_errors_total counter");
    expect(body).toContain('app_errors_total{class="unexpected"} 3');
    expect(body).toContain('app_errors_total{class="operational"} 1');
    expect(body).toContain("# HELP autosave_failures_total ");
    expect(body).toContain("# TYPE autosave_failures_total counter");
    expect(body).toContain("autosave_failures_total 2");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("omits counters that were never incremented (sparse exposition)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected");

    const body = await (await getMetricsResponse()).text();

    expect(body).toContain('app_errors_total{class="unexpected"} 1');
    expect(body).not.toContain('class="operational"');
    expect(body).not.toContain("autosave_failures_total");
  });

  it("exposes the notes cache hit/miss counters (ENG-36 catalog)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("notes_cache_hits_total", 4);
    incrementCounter("notes_cache_misses_total", 2);

    const body = await (await getMetricsResponse()).text();

    expect(body).toContain("# HELP notes_cache_hits_total ");
    expect(body).toContain("# TYPE notes_cache_hits_total counter");
    expect(body).toContain("notes_cache_hits_total 4");
    expect(body).toContain("# HELP notes_cache_misses_total ");
    expect(body).toContain("# TYPE notes_cache_misses_total counter");
    expect(body).toContain("notes_cache_misses_total 2");
  });

  it("keeps the notes cache counters sparse until the cache is wired (ENG-37)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected");

    const body = await (await getMetricsResponse()).text();

    expect(body).not.toContain("notes_cache_hits_total");
    expect(body).not.toContain("notes_cache_misses_total");
  });
});