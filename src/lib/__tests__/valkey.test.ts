import { describe, expect, it } from "vitest";
import { valkey } from "@/lib/valkey";

/**
 * Posture test for the shared Valkey client's failure-latency contract
 * (ENG-53, from the ENG-38 drill finding F1): when Valkey is unreachable,
 * operations must reject in well under the pre-retune ~27s so every
 * consumer's degradation path (cache miss, session fallback, limiter
 * fail-open/fail-closed) fires while journeys stay fast. The recovery
 * guarantee lives in retryStrategy — it must keep reconnecting forever.
 */
describe("valkey client failure-latency posture", () => {
  it("bounds each connect attempt to ~1s (default is 10000)", () => {
    expect(valkey.options.connectTimeout).toBeLessThanOrEqual(2000);
  });

  it("rejects commands immediately while disconnected (offline queue off)", () => {
    expect(valkey.options.enableOfflineQueue).toBe(false);
  });

  it("keeps the per-command retry bound from ENG-15", () => {
    expect(valkey.options.maxRetriesPerRequest).toBe(2);
  });

  it("reconnects forever with delays capped at 1s", () => {
    const { retryStrategy } = valkey.options;
    expect(typeof retryStrategy).toBe("function");
    for (let times = 1; times <= 50; times++) {
      const delay = retryStrategy?.(times);
      expect(delay).not.toBeNull();
      expect(delay).not.toBeUndefined();
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it("exports a live shared client instance", () => {
    expect(typeof valkey.status).toBe("string");
  });
});
