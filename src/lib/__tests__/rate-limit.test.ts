import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_RATE_LIMIT,
  RATE_LIMITED_MESSAGE,
  REGISTER_RATE_LIMIT,
  checkLoginRateLimit,
  checkRegisterRateLimit,
  consumeRateLimit,
  loginRateLimitKey,
  refundRateLimit,
  refundRegistrationRateLimit,
  registerRateLimitKey,
  resetLoginRateLimit,
  resetRateLimit,
  type RateLimitStore,
} from "../rate-limit";

const KEY = "rl:test:bucket";
const CONFIG = { limit: 3, windowSeconds: 900 };

function makeFakeStore(): RateLimitStore & {
  counts: Map<string, number>;
  expiries: Map<string, number>;
  pexpireCalls: Array<{ key: string; milliseconds: number }>;
  delCalls: string[];
  decrCalls: string[];
} {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const pexpireCalls: Array<{ key: string; milliseconds: number }> = [];
  const delCalls: string[] = [];
  const decrCalls: string[] = [];
  return {
    counts,
    expiries,
    pexpireCalls,
    delCalls,
    decrCalls,
    async incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async decr(key) {
      decrCalls.push(key);
      const next = (counts.get(key) ?? 0) - 1;
      counts.set(key, next);
      return next;
    },
    async pttl(key) {
      return expiries.get(key) ?? -1;
    },
    async pexpire(key, milliseconds) {
      pexpireCalls.push({ key, milliseconds });
      expiries.set(key, milliseconds);
      return 1;
    },
    async del(key) {
      delCalls.push(key);
      const existed = counts.delete(key);
      expiries.delete(key);
      return existed ? 1 : 0;
    },
  };
}

describe("rate-limit thresholds", () => {
  it("allows 5 failed login attempts per 15 minutes per ip+email", () => {
    expect(LOGIN_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 900 });
  });

  it("allows 5 registration attempts per hour per ip", () => {
    expect(REGISTER_RATE_LIMIT).toEqual({ limit: 5, windowSeconds: 3600 });
  });

  it("exposes a single generic rate-limited message", () => {
    expect(RATE_LIMITED_MESSAGE).toBe(
      "Too many attempts. Please try again later.",
    );
  });
});

describe("consumeRateLimit", () => {
  it("increments the counter and allows attempts up to the limit", async () => {
    const store = makeFakeStore();

    const first = await consumeRateLimit(store, KEY, CONFIG);
    const second = await consumeRateLimit(store, KEY, CONFIG);
    const third = await consumeRateLimit(store, KEY, CONFIG);

    expect(first).toEqual({ allowed: true, remaining: 2 });
    expect(second).toEqual({ allowed: true, remaining: 1 });
    expect(third).toEqual({ allowed: true, remaining: 0 });
    expect(store.counts.get(KEY)).toBe(3);
  });

  it("blocks the attempt after the limit and reports the retry delay", async () => {
    const store = makeFakeStore();
    for (let i = 0; i < CONFIG.limit; i += 1) {
      await consumeRateLimit(store, KEY, CONFIG);
    }

    const blocked = await consumeRateLimit(store, KEY, CONFIG);

    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 900 });
    expect(store.counts.get(KEY)).toBe(4);
  });

  it("sets the fixed-window TTL once and does not refresh it on later hits", async () => {
    const store = makeFakeStore();

    await consumeRateLimit(store, KEY, CONFIG);
    await consumeRateLimit(store, KEY, CONFIG);

    expect(store.pexpireCalls).toEqual([
      { key: KEY, milliseconds: 900_000 },
    ]);
  });

  it("repairs a missing TTL on a counter that was incremented without one", async () => {
    const store = makeFakeStore();
    store.counts.set(KEY, 2);

    const result = await consumeRateLimit(store, KEY, CONFIG);

    expect(result).toEqual({ allowed: true, remaining: 0 });
    expect(store.pexpireCalls).toEqual([
      { key: KEY, milliseconds: 900_000 },
    ]);
  });
});

describe("refundRateLimit", () => {
  it("decrements the counter so a refunded attempt does not consume budget", async () => {
    const store = makeFakeStore();
    await consumeRateLimit(store, KEY, CONFIG);

    await refundRateLimit(store, KEY);

    expect(store.decrCalls).toEqual([KEY]);
    expect(store.counts.get(KEY)).toBe(0);

    const next = await consumeRateLimit(store, KEY, CONFIG);
    expect(next).toEqual({ allowed: true, remaining: 2 });
  });
});

describe("resetRateLimit", () => {
  it("deletes the counter key", async () => {
    const store = makeFakeStore();
    await consumeRateLimit(store, KEY, CONFIG);

    await resetRateLimit(store, KEY);

    expect(store.delCalls).toEqual([KEY]);
    expect(store.counts.has(KEY)).toBe(false);
  });
});

describe("rate limit keys", () => {
  it("uses one login bucket per ip and normalized email", () => {
    expect(loginRateLimitKey("1.2.3.4", "User@Example.com")).toBe(
      loginRateLimitKey("1.2.3.4", "user@example.com"),
    );
    expect(loginRateLimitKey("1.2.3.4", "user@example.com")).not.toBe(
      loginRateLimitKey("5.6.7.8", "user@example.com"),
    );
    expect(loginRateLimitKey("1.2.3.4", "user@example.com")).not.toBe(
      loginRateLimitKey("1.2.3.4", "other@example.com"),
    );
  });

  it("routes malformed and missing emails into one shared bucket", () => {
    const malformed = loginRateLimitKey("1.2.3.4", "not-an-email");
    const missing = loginRateLimitKey("1.2.3.4", undefined);
    const empty = loginRateLimitKey("1.2.3.4", "");

    expect(malformed).toBe(missing);
    expect(malformed).toBe(empty);
    expect(malformed).not.toBe(loginRateLimitKey("1.2.3.4", "a@b.co"));
  });

  it("keys registrations by ip only", () => {
    expect(registerRateLimitKey("1.2.3.4")).toBe(
      registerRateLimitKey("1.2.3.4"),
    );
    expect(registerRateLimitKey("1.2.3.4")).not.toBe(
      registerRateLimitKey("5.6.7.8"),
    );
  });

  it("does not expose the raw email or ip in the key", () => {
    const loginKey = loginRateLimitKey("1.2.3.4", "user@example.com");
    const registerKey = registerRateLimitKey("1.2.3.4");

    expect(loginKey).not.toContain("user@example.com");
    expect(loginKey).not.toContain("1.2.3.4");
    expect(registerKey).not.toContain("1.2.3.4");
  });
});

describe("fail-open wrappers", () => {
  const consoleError = vi.spyOn(console, "error");

  afterEach(() => {
    consoleError.mockClear();
  });

  function brokenStore(): RateLimitStore {
    return {
      incr: vi.fn(async () => {
        throw new Error("valkey down");
      }),
      decr: vi.fn(async () => {
        throw new Error("valkey down");
      }),
      pttl: vi.fn(async () => {
        throw new Error("valkey down");
      }),
      pexpire: vi.fn(async () => {
        throw new Error("valkey down");
      }),
      del: vi.fn(async () => {
        throw new Error("valkey down");
      }),
    };
  }

  it("logs the degradation and reports no enforcement when valkey fails for login", async () => {
    const gate = await checkLoginRateLimit(brokenStore(), {
      ip: "1.2.3.4",
      email: "user@example.com",
    });

    expect(gate).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("rate-limit");
  });

  it("logs the degradation and reports no enforcement when valkey fails for registration", async () => {
    const gate = await checkRegisterRateLimit(brokenStore(), {
      ip: "1.2.3.4",
    });

    expect(gate).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("passes through allowed and blocked results when valkey is healthy", async () => {
    const store = makeFakeStore();

    const allowed = await checkLoginRateLimit(store, {
      ip: "1.2.3.4",
      email: "user@example.com",
    });

    expect(allowed).toEqual({ allowed: true, remaining: 4 });

    for (let i = 0; i < LOGIN_RATE_LIMIT.limit; i += 1) {
      await checkLoginRateLimit(store, {
        ip: "9.9.9.9",
        email: "user@example.com",
      });
    }
    const blocked = await checkLoginRateLimit(store, {
      ip: "9.9.9.9",
      email: "user@example.com",
    });

    expect(blocked).toEqual({
      allowed: false,
      retryAfterSeconds: LOGIN_RATE_LIMIT.windowSeconds,
    });
  });

  it("swallows failures when refunding a registration attempt", async () => {
    await expect(
      refundRegistrationRateLimit(brokenStore(), { ip: "1.2.3.4" }),
    ).resolves.toBeUndefined();
  });

  it("swallows failures when resetting the login counter", async () => {
    await expect(
      resetLoginRateLimit(brokenStore(), {
        ip: "1.2.3.4",
        email: "user@example.com",
      }),
    ).resolves.toBeUndefined();
  });
});
