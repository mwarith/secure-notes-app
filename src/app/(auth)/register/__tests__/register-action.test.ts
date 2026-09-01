import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/app/(auth)/register/actions";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
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
});
