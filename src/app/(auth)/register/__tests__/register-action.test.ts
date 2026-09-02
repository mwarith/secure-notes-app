import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/app/(auth)/register/actions";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { registerUser } from "@/lib/auth/register";
import { readCounter } from "@/lib/metrics";
import {
  resolveTestDatabaseUrl,
  resolveTestValkeyUrl,
} from "../../../../../vitest.helpers";

const { requestHeaders } = vi.hoisted(() => ({
  requestHeaders: {
    value: new Headers({ "x-forwarded-for": "203.0.113.5" }),
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => requestHeaders.value),
}));

vi.mock("@/lib/auth/register", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/register")>();
  return {
    ...actual,
    registerUser: vi.fn(actual.registerUser),
  };
});

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const DUPLICATE_MESSAGE =
  "Unable to create account with these details. If you already have an account, try signing in or resetting your password.";
const WEAK_PASSWORD_MESSAGE =
  "Password must be at least 12 characters and must not contain your email address.";

function makeForm(email: FormDataEntryValue | null, password: FormDataEntryValue | null): FormData {
  const form = new FormData();
  if (email !== null) form.set("email", email);
  if (password !== null) form.set("password", password);
  return form;
}

afterAll(async () => {
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
  requestHeaders.value = new Headers({ "x-forwarded-for": "203.0.113.5" });
});

describe("registerAction (integration)", () => {
  it("registers from FormData, writes user and audit event, and creates no session", async () => {
    const state = await registerAction(
      { status: "idle" },
      makeForm("User@Example.com", "correct horse battery staple"),
    );

    expect(state).toEqual({ status: "success" });

    const [user] = await db.select().from(users);
    expect(user.email).toBe("user@example.com");
    expect(await db.select().from(auditEvents)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("returns the neutral non-enumerating message for a duplicate email", async () => {
    await registerAction(
      { status: "idle" },
      makeForm("user@example.com", "correct horse battery staple"),
    );

    const state = await registerAction(
      { status: "idle" },
      makeForm("user@example.com", "another good password"),
    );

    expect(state).toEqual({ status: "error", message: DUPLICATE_MESSAGE });
  });

  it("returns the password requirements message for a weak password", async () => {
    const state = await registerAction(
      { status: "idle" },
      makeForm("user@example.com", "short"),
    );

    expect(state).toEqual({ status: "error", message: WEAK_PASSWORD_MESSAGE });
  });

  it("returns the invalid email message for a malformed email", async () => {
    const state = await registerAction(
      { status: "idle" },
      makeForm("not-an-email", "correct horse battery staple"),
    );

    expect(state).toEqual({
      status: "error",
      message: "Please enter a valid email address.",
    });
  });

  it("tolerates missing form fields", async () => {
    const state = await registerAction({ status: "idle" }, new FormData());

    expect(state).toEqual({
      status: "error",
      message: "Please enter a valid email address.",
    });
    expect(
      await db.select().from(users).where(eq(users.email, "")),
    ).toHaveLength(0);
  });

  it("captures an unexpected failure and returns the safe message without leaking raw error text", async () => {
    vi.mocked(registerUser).mockRejectedValueOnce(
      new Error("relation users disappeared mid-registration"),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const before = readCounter("errors.unexpected");

      const state = await registerAction(
        { status: "idle" },
        makeForm("user@example.com", "correct horse battery staple"),
      );

      expect(state).toEqual({
        status: "error",
        message: "Something went wrong. Please try again.",
      });
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(auditEvents)).toHaveLength(0);
      expect(readCounter("errors.unexpected")).toBe(before + 1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
        level: string;
        event: string;
        class: string;
        detail?: string;
      };
      expect(parsed.level).toBe("error");
      expect(parsed.event).toBe("error.captured");
      expect(parsed.class).toBe("unexpected");
      expect(parsed.detail).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
