import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login, logout } from "@/lib/auth/login";
import { getSession } from "@/lib/auth/session";
import { readCounter } from "@/lib/metrics";
import { captureLog } from "@/lib/__tests__/log-capture";
import { loginAction, logoutAction } from "@/app/(auth)/login/actions";
import { resolveTestDatabaseUrl, resolveTestValkeyUrl } from "../../../../../vitest.helpers";

const { cookieStore, requestHeaders } = vi.hoisted(() => ({
  cookieStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  requestHeaders: {
    value: new Headers({ "x-forwarded-for": "203.0.113.5" }),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => requestHeaders.value),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth/login", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/login")>();
  return {
    ...actual,
    login: vi.fn(actual.login),
    logout: vi.fn(actual.logout),
  };
});

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

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
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(cookieStore.set).mockReset();
  vi.mocked(cookieStore.delete).mockReset();
  vi.mocked(redirect).mockReset();
  requestHeaders.value = new Headers({ "x-forwarded-for": "203.0.113.5" });
});

describe("loginAction (integration)", () => {
  it("sets the session cookie with the exact secure configuration and redirects on success", async () => {
    await seedUser();

    await loginAction(
      { status: "idle" },
      makeForm(EMAIL, PASSWORD),
    );

    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const config = vi.mocked(cookieStore.set).mock.calls[0][0] as {
      name: string;
      value: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
      path: string;
      maxAge: number;
    };
    expect(config.name).toBe("session");
    expect(config.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(config.httpOnly).toBe(true);
    expect(config.secure).toBe(process.env.NODE_ENV === "production");
    expect(config.sameSite).toBe("lax");
    expect(config.path).toBe("/");
    expect(config.maxAge).toBe(60 * 60 * 24);

    expect(redirect).toHaveBeenCalledWith("/");

    expect(await getSession(config.value)).not.toBeNull();
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("returns the identical generic message for unknown email and wrong password", async () => {
    await seedUser();

    const unknownEmail = await loginAction(
      { status: "idle" },
      makeForm("ghost@example.com", PASSWORD),
    );
    const wrongPassword = await loginAction(
      { status: "idle" },
      makeForm(EMAIL, "wrong password 123"),
    );

    const expected = { status: "error", message: "Invalid email or password." };
    expect(unknownEmail).toEqual(expected);
    expect(wrongPassword).toEqual(expected);

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("invalidates the session server-side and deletes the cookie on logout", async () => {
    const userId = await seedUser();
    const result = await login({ email: EMAIL, password: PASSWORD });
    if (!result.ok) throw new Error("expected login to succeed");
    const { token } = result;
    vi.mocked(cookieStore.get).mockReturnValue({ name: "session", value: token } as never);

    await logoutAction();

    expect(await getSession(token)).toBeNull();
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, userId)),
    ).toHaveLength(0);
    expect(cookieStore.delete).toHaveBeenCalledWith("session");

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(2);
    const logoutEvent = events.find((event) => event.action === "logout.success");
    expect(logoutEvent).toBeDefined();
    expect(logoutEvent?.actorUserId).toBe(userId);
    expect(logoutEvent?.resourceType).toBe("user");
    expect(logoutEvent?.resourceId).toBe(userId);
  });

  it("is a safe no-op when logging out without a session", async () => {
    vi.mocked(cookieStore.get).mockReturnValue(undefined as never);
    await logoutAction();

    expect(cookieStore.delete).toHaveBeenCalledWith("session");
    expect(await db.select().from(auditEvents)).toHaveLength(0);

    vi.mocked(cookieStore.get).mockReturnValue({
      name: "session",
      value: "bogus-token-value",
    } as never);
    await logoutAction();

    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("captures an unexpected login failure and returns the safe message without leaking raw error text", async () => {
    await seedUser();
    vi.mocked(login).mockRejectedValueOnce(
      new Error("ECONNREFUSED 10.1.2.3:5432 auth database"),
    );
    const logCapture = captureLog();
    try {
      const before = readCounter("errors.unexpected");

      const state = await loginAction(
        { status: "idle" },
        makeForm(EMAIL, PASSWORD),
      );

      expect(state).toEqual({
        status: "error",
        message: "Something went wrong. Please try again.",
      });
      expect(cookieStore.set).not.toHaveBeenCalled();
      expect(await db.select().from(auditEvents)).toHaveLength(0);
      expect(readCounter("errors.unexpected")).toBe(before + 1);
      expect(logCapture.byLevel("error")).toHaveLength(1);
      const parsed = logCapture.byLevel("error")[0] as {
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
      logCapture.restore();
    }
  });

  it("completes logout when the server-side session teardown fails, capturing the operational failure", async () => {
    vi.mocked(cookieStore.get).mockReturnValue(undefined as never);
    vi.mocked(logout).mockRejectedValueOnce(
      new Error("valkey connection lost during logout"),
    );
    const logCapture = captureLog();
    try {
      const before = readCounter("errors.operational");

      await expect(logoutAction()).resolves.toBeUndefined();

      expect(cookieStore.delete).toHaveBeenCalledWith("session");
      expect(readCounter("errors.operational")).toBe(before + 1);
      expect(logCapture.byLevel("warn")).toHaveLength(1);
      const parsed = logCapture.byLevel("warn")[0] as {
        level: string;
        event: string;
        class: string;
      };
      expect(parsed.level).toBe("warn");
      expect(parsed.event).toBe("error.captured");
      expect(parsed.class).toBe("operational");
    } finally {
      logCapture.restore();
    }
  });
});
