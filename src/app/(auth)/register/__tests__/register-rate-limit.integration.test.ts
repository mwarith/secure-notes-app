import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { RATE_LIMITED_MESSAGE } from "@/lib/rate-limit";
import { registerAction } from "@/app/(auth)/register/actions";
import {
  resolveTestDatabaseUrl,
  resolveTestValkeyUrl,
} from "../../../../../vitest.helpers";

const IP = "203.0.113.5";
const PASSWORD = "correct horse battery staple";

const DUPLICATE_MESSAGE =
  "Unable to create account with these details. If you already have an account, try signing in or resetting your password.";
const WEAK_PASSWORD_MESSAGE =
  "Password must be at least 12 characters and must not contain your email address.";

const { requestHeaders, valkeyRateLimitBroken } = vi.hoisted(() => ({
  requestHeaders: {
    value: new Headers({ "x-forwarded-for": "203.0.113.5" }),
  },
  valkeyRateLimitBroken: { value: false },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => requestHeaders.value),
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

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

function makeForm(email: FormDataEntryValue | null, password: FormDataEntryValue | null): FormData {
  const form = new FormData();
  if (email !== null) form.set("email", email);
  if (password !== null) form.set("password", password);
  return form;
}

async function registerFromIp(ip: string, email: string): Promise<{ status: string; message?: string }> {
  requestHeaders.value = new Headers({ "x-forwarded-for": ip });
  return registerAction({ status: "idle" }, makeForm(email, PASSWORD));
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
  requestHeaders.value = new Headers({ "x-forwarded-for": IP });
  valkeyRateLimitBroken.value = false;
});

describe("registerAction rate limiting (integration)", () => {
  it("blocks the 6th registration after 5 accounts were created from the same ip", async () => {
    for (let i = 0; i < 5; i += 1) {
      const state = await registerFromIp(IP, `user${i}@example.com`);
      expect(state).toEqual({ status: "success" });
    }

    const blocked = await registerFromIp(IP, "user5@example.com");

    expect(blocked).toEqual({ status: "error", message: RATE_LIMITED_MESSAGE });
    expect(await db.select().from(users)).toHaveLength(5);

    const events = await db.select().from(auditEvents);
    expect(events.filter((event) => event.action === "account.created")).toHaveLength(5);
    const rateLimited = events.filter((event) => event.action === "register.rate_limited");
    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0]?.actorUserId).toBeNull();
    expect(rateLimited[0]?.metadata).toEqual({ method: "password" });
  });

  it("counts duplicate-email attempts toward the limit", async () => {
    expect(await registerFromIp(IP, "user@example.com")).toEqual({ status: "success" });

    for (let i = 0; i < 4; i += 1) {
      const state = await registerFromIp(IP, "user@example.com");
      expect(state).toEqual({ status: "error", message: DUPLICATE_MESSAGE });
    }

    const blocked = await registerFromIp(IP, "other@example.com");
    expect(blocked).toEqual({ status: "error", message: RATE_LIMITED_MESSAGE });
  });

  it("does not count validation failures against the budget", async () => {
    for (let i = 0; i < 3; i += 1) {
      const weak = await registerAction(
        { status: "idle" },
        makeForm("user@example.com", "short"),
      );
      expect(weak).toEqual({ status: "error", message: WEAK_PASSWORD_MESSAGE });
    }

    for (let i = 0; i < 2; i += 1) {
      const malformed = await registerAction(
        { status: "idle" },
        makeForm("not-an-email", PASSWORD),
      );
      expect(malformed).toEqual({
        status: "error",
        message: "Please enter a valid email address.",
      });
    }

    expect(await registerFromIp(IP, "user@example.com")).toEqual({
      status: "success",
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("does not affect registrations from a different ip after one ip hits the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await registerFromIp(IP, `user${i}@example.com`)).toEqual({
        status: "success",
      });
    }
    expect(await registerFromIp(IP, "blocked@example.com")).toEqual({
      status: "error",
      message: RATE_LIMITED_MESSAGE,
    });

    expect(await registerFromIp("198.51.100.9", "unaffected@example.com")).toEqual({
      status: "success",
    });
  });

  it("fails open when rate limiting is unavailable and logs the degradation", async () => {
    valkeyRateLimitBroken.value = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(await registerFromIp(IP, "user@example.com")).toEqual({
      status: "success",
    });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("rate-limit"),
    );
    consoleError.mockRestore();
  });
});
