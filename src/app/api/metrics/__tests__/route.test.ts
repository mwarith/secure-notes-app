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

  it("exposes the process start gauge and every catalog family even at zero (ENG-54, non-sparse)", async () => {
    const body = await (await getMetricsResponse()).text();

    const startMatch = body.match(/^app_process_start_time_seconds (\d+)$/m);
    expect(startMatch).not.toBeNull();
    const startedAtSeconds = Number(startMatch?.[1]);
    expect(startedAtSeconds).toBeGreaterThan(0);
    expect(startedAtSeconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    expect(body).toContain("# TYPE app_process_start_time_seconds gauge");
    expect(body).toContain("# TYPE app_errors_total counter");
    expect(body).toContain('app_errors_total{class="operational"} 0');
    expect(body).toContain('app_errors_total{class="unexpected"} 0');
    expect(body).toContain("autosave_failures_total 0");
    expect(body).toContain("notes_cache_hits_total 0");
    expect(body).toContain("notes_cache_misses_total 0");
    expect(body.endsWith("\n")).toBe(true);
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

  it("exposes zero-valued counters alongside incremented ones (non-sparse, ENG-54)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected");

    const body = await (await getMetricsResponse()).text();

    expect(body).toContain('app_errors_total{class="unexpected"} 1');
    expect(body).toContain('app_errors_total{class="operational"} 0');
    expect(body).toContain("autosave_failures_total 0");
    expect(body).toContain("notes_cache_hits_total 0");
    expect(body).toContain("notes_cache_misses_total 0");
  });

  it("emits _created lines per counter sample with the same labels and the process start epoch (ENG-54)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected", 3);
    incrementCounter("notes_cache_hits_total", 4);

    const body = await (await getMetricsResponse()).text();

    const startMatch = body.match(/^app_process_start_time_seconds (\d+)$/m);
    expect(startMatch).not.toBeNull();
    const startedAtSeconds = startMatch?.[1];
    expect(body).toContain(
      `app_errors_created{class="unexpected"} ${startedAtSeconds}`,
    );
    expect(body).toContain(
      `app_errors_created{class="operational"} ${startedAtSeconds}`,
    );
    expect(body).toContain(`autosave_failures_created ${startedAtSeconds}`);
    expect(body).toContain(`notes_cache_hits_created ${startedAtSeconds}`);
    expect(body).toContain(`notes_cache_misses_created ${startedAtSeconds}`);
    expect(body).not.toContain("_total_created");
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

  it("keeps the exposition non-sparse after increments (notes cache families stay present, ENG-54)", async () => {
    const { incrementCounter } = await import("@/lib/metrics");
    incrementCounter("errors.unexpected");

    const body = await (await getMetricsResponse()).text();

    expect(body).toContain("notes_cache_hits_total 0");
    expect(body).toContain("notes_cache_misses_total 0");
    expect(body).toContain("notes_cache_hits_created");
    expect(body).toContain("notes_cache_misses_created");
  });
});
