import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { RATE_LIMITED_MESSAGE, loginRateLimitKey } from "@/lib/rate-limit";
import { loginAction } from "@/app/(auth)/login/actions";
import {
  resolveTestDatabaseUrl,
  resolveTestValkeyUrl,
} from "../../../../../vitest.helpers";

const IP = "203.0.113.5";
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";

const { cookieStore, requestHeaders, valkeyRateLimitBroken } = vi.hoisted(() => ({
  cookieStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  requestHeaders: {
    value: new Headers({ "x-forwarded-for": "203.0.113.5" }),
  },
  valkeyRateLimitBroken: { value: false },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => requestHeaders.value),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/valkey", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/valkey")>();
  return {
    get valkey() {
      if (!valkeyRateLimitBroken.value) {
        return actual.valkey;
      }
      return {
        set: actual.valkey.set.bind(actual.valkey),
        get: actual.valkey.get.bind(actual.valkey),
        del: actual.valkey.del.bind(actual.valkey),
        incr: async () => {
          throw new Error("VALKEY_RATE_LIMIT_UNAVAILABLE");
        },
        decr: async () => {
          throw new Error("VALKEY_RATE_LIMIT_UNAVAILABLE");
        },
        pttl: async () => {
          throw new Error("VALKEY_RATE_LIMIT_UNAVAILABLE");
        },
        pexpire: async () => {
          throw new Error("VALKEY_RATE_LIMIT_UNAVAILABLE");
        },
      };
    },
  };
});

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "wrong password 123";

function makeForm(email: FormDataEntryValue | null, password: FormDataEntryValue | null): FormData {
  const form = new FormData();
  if (email !== null) form.set("email", email);
  if (password !== null) form.set("password", password);
  return form;
}

async function seedUser(): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  return user.id;
}

async function failedLogins(count: number, email: string = EMAIL): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const state = await loginAction(
      { status: "idle" },
      makeForm(email, WRONG_PASSWORD),
    );
    expect(state).toEqual({ status: "error", message: INVALID_CREDENTIALS_MESSAGE });
  }
}

afterAll(async () => {
  valkeyRateLimitBroken.value = false;
  await Promise.all([
    pool.end(),
    appPool.end(),
    valkey.quit().catch(() => undefined),
    appValkey.quit().catch(() => undefined),
  ]);
});

beforeEach(async () => {
  await valkey.flushdb();
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(cookieStore.set).mockReset();
  vi.mocked(cookieStore.delete).mockReset();
  vi.mocked(redirect).mockReset();
  requestHeaders.value = new Headers({ "x-forwarded-for": IP });
  valkeyRateLimitBroken.value = false;
});

describe("loginAction rate limiting (integration)", () => {
  it("blocks the 6th attempt after 5 failed logins, even with correct credentials", async () => {
    await seedUser();
    await failedLogins(5);

    const blocked = await loginAction(
      { status: "idle" },
      makeForm(EMAIL, PASSWORD),
    );

    expect(blocked).toEqual({ status: "error", message: RATE_LIMITED_MESSAGE });
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(await db.select().from(sessions)).toHaveLength(0);

    const events = await db.select().from(auditEvents);
    expect(events.filter((event) => event.action === "login.failed")).toHaveLength(5);
    const rateLimited = events.filter((event) => event.action === "login.rate_limited");
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0]?.actorUserId).toBeNull();
    expect(rateLimited[0]?.metadata).toEqual({ method: "password" });
  });

  it("returns the identical blocked message for unknown emails so account existence is not leaked", async () => {
    await failedLogins(5, "ghost@example.com");

    const blocked = await loginAction(
      { status: "idle" },
      makeForm("ghost@example.com", PASSWORD),
    );

    expect(blocked).toEqual({ status: "error", message: RATE_LIMITED_MESSAGE });

    const events = await db.select().from(auditEvents);
    const rateLimited = events.filter((event) => event.action === "login.rate_limited");
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0]?.actorUserId).toBeNull();
    expect(rateLimited[0]?.resourceType).toBeNull();
    expect(rateLimited[0]?.resourceId).toBeNull();

    const serialized = JSON.stringify(events.map((event) => event.metadata)).toLowerCase();
    expect(serialized).not.toContain("ghost@example.com");
  });

  it("resets the failed-attempt counter on successful login", async () => {
    await seedUser();
    await failedLogins(4);

    await loginAction({ status: "idle" }, makeForm(EMAIL, PASSWORD));
    expect(redirect).toHaveBeenCalledTimes(1);
    vi.mocked(redirect).mockReset();
    vi.mocked(cookieStore.set).mockReset();

    await failedLogins(4);

    await loginAction({ status: "idle" }, makeForm(EMAIL, PASSWORD));
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("sets a fixed-window TTL on the counter and the limit expires with it", async () => {
    await seedUser();
    await failedLogins(5);

    const key = loginRateLimitKey(IP, EMAIL);
    const ttl = await valkey.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900_000);

    expect(
      await loginAction({ status: "idle" }, makeForm(EMAIL, PASSWORD)),
    ).toEqual({ status: "error", message: RATE_LIMITED_MESSAGE });

    await valkey.pexpire(key, 50);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await loginAction({ status: "idle" }, makeForm(EMAIL, PASSWORD));
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("fails open when rate limiting is unavailable and logs the degradation", async () => {
    valkeyRateLimitBroken.value = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await seedUser();

    const failure = await loginAction(
      { status: "idle" },
      makeForm(EMAIL, WRONG_PASSWORD),
    );
    expect(failure).toEqual({
      status: "error",
      message: INVALID_CREDENTIALS_MESSAGE,
    });

    await loginAction({ status: "idle" }, makeForm(EMAIL, PASSWORD));
    expect(redirect).toHaveBeenCalledTimes(1);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("rate-limit"),
    );
    consoleError.mockRestore();
  });
});
