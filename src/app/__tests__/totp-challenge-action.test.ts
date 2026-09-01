import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { createSession, hashSessionToken } from "@/lib/auth/session";
import { encryptTotpSecret } from "@/lib/auth/totp-crypto";
import { generateTotpSecret, totpUri } from "@/lib/auth/totp";
import { TOTP, URI } from "otpauth";
import { verifyTotpChallengeAction } from "@/app/(auth)/login/2fa/actions";
import {
  resolveTestDatabaseUrl,
  resolveTestValkeyUrl,
} from "../../../vitest.helpers";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

async function seedUser(): Promise<{ userId: string; secret: string }> {
  const { hashPassword } = await import("@/lib/auth/password");
  const secret = generateTotpSecret();
  const [user] = await db
    .insert(users)
    .values({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      totpSecretEncrypted: encryptTotpSecret(secret),
      totpEnabled: true,
    })
    .returning({ id: users.id });
  return { userId: user.id, secret };
}

function totpFromUri(uri: string): TOTP {
  const parsed = URI.parse(uri);
  if (!(parsed instanceof TOTP)) {
    throw new Error("expected the parsed URI to be a TOTP instance");
  }
  return parsed;
}

function wrongCode(uri: string): string {
  const totp = totpFromUri(uri);
  const nearby = new Set(
    [-1, 0, 1].map(
      (delta) => totp.generate({ timestamp: Date.now() + delta * 30_000 }),
    ),
  );
  for (let i = 0; i < 1_000_000; i += 1) {
    const candidate = i.toString().padStart(6, "0");
    if (!nearby.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("no wrong code found");
}

async function seedPendingSession(): Promise<string> {
  const result = await login({ email: EMAIL, password: PASSWORD });
  if (!result.ok) throw new Error("expected login to succeed");
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashSessionToken(result.token)));
  if (!row.pendingTwoFactor) {
    throw new Error("expected login to create a pending session");
  }
  await db.delete(auditEvents);
  vi.mocked(cookieStore.get).mockReturnValue({
    name: "session",
    value: result.token,
  } as never);
  return result.token;
}

const prevState: { ok: true } | { ok: false; error: string } = {
  ok: false,
  error: "",
};

function formData(code: string): FormData {
  const data = new FormData();
  data.set("code", code);
  return data;
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(redirect).mockReset();
});

describe("verifyTotpChallengeAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      verifyTotpChallengeAction(prevState, formData("123456")),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to / for a fully active (non-pending) session", async () => {
    const { userId } = await seedUser();
    const { token } = await createSession(userId);
    vi.mocked(cookieStore.get).mockReturnValue({
      name: "session",
      value: token,
    } as never);
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      verifyTotpChallengeAction(prevState, formData("123456")),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("rejects a wrong code with a login.failed audit and a consumed attempt", async () => {
    const { userId, secret } = await seedUser();
    await seedPendingSession();
    const uri = totpUri(secret, EMAIL);

    const result = await verifyTotpChallengeAction(
      prevState,
      formData(wrongCode(uri)),
    );

    expect(result).toEqual({
      ok: false,
      error: "That code didn't match. Try again.",
    });

    const [event] = await db.select().from(auditEvents);
    expect(event?.action).toBe("login.failed");
    expect(event?.actorUserId).toBe(userId);
    expect(event?.resourceType).toBe("user");
    expect(event?.resourceId).toBe(userId);
    expect(event?.metadata).toEqual({
      method: "password",
      outcome: "invalid_totp_code",
    });

    const [row] = await db.select().from(sessions);
    expect(row.pendingTwoFactor).toBe(true);
  });

  it("activates the session in both stores on a valid code", async () => {
    const { userId, secret } = await seedUser();
    const token = await seedPendingSession();
    const tokenHash = hashSessionToken(token);
    const code = currentTokenFromUri(totpUri(secret, EMAIL));

    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      verifyTotpChallengeAction(prevState, formData(code)),
    ).rejects.toThrow("NEXT_REDIRECT:/");
    expect(redirect).toHaveBeenCalledWith("/");

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash));
    expect(row.pendingTwoFactor).toBe(false);

    const stored = await appValkey.get(`session:${tokenHash}`);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("expected the session payload");
    const payload = JSON.parse(stored);
    expect(payload.userId).toBe(userId);
    expect(payload.pendingTwoFactor).toBe(false);

    const sessionAfter = await getSessionFromStores(token);
    expect(sessionAfter?.pendingTwoFactor).toBe(false);

    const events = await db.select().from(auditEvents);
    expect(events).toEqual([]);
  });

  it("blocks with a neutral error once the login limiter budget is spent", async () => {
    const { secret } = await seedUser();
    await seedPendingSession();
    const uri = totpUri(secret, EMAIL);

    for (let i = 0; i < 5; i += 1) {
      await verifyTotpChallengeAction(prevState, formData(wrongCode(uri)));
    }
    const eventsAfterFive = await db.select().from(auditEvents);
    expect(eventsAfterFive).toHaveLength(5);

    const blocked = await verifyTotpChallengeAction(
      prevState,
      formData(wrongCode(uri)),
    );

    expect(blocked).toEqual({
      ok: false,
      error: "Too many attempts. Try again later.",
    });
    expect(await db.select().from(auditEvents)).toHaveLength(5);

    const [row] = await db.select().from(sessions);
    expect(row.pendingTwoFactor).toBe(true);
  });
});

async function getSessionFromStores(token: string) {
  const { getSession } = await import("@/lib/auth/session");
  return getSession(token);
}

function currentTokenFromUri(uri: string): string {
  const totp = totpFromUri(uri);
  const token = totp.generate();
  if (!/^[0-9]{6}$/.test(token)) {
    throw new Error(`expected a 6-digit token, got: ${token}`);
  }
  return token;
}
