import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { URI } from "otpauth";
import { decryptTotpSecret } from "@/lib/auth/totp-crypto";
import { verifyTotpCode } from "@/lib/auth/totp";
import {
  confirmTotpSetupAction,
  startTotpSetupAction,
} from "@/app/settings/security/actions";
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
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

async function seedUser(email = EMAIL): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  return user.id;
}

async function seedSession(): Promise<string> {
  const userId = await seedUser();
  const result = await login({ email: EMAIL, password: PASSWORD });
  if (!result.ok) throw new Error("expected login to succeed");
  vi.mocked(cookieStore.get).mockReturnValue({
    name: "session",
    value: result.token,
  } as never);
  await db.delete(auditEvents);
  return userId;
}

function currentTokenFromUri(uri: string): string {
  const parsed = URI.parse(uri);
  const token = (parsed as unknown as { generate: () => string }).generate();
  if (!/^[0-9]{6}$/.test(token)) {
    throw new Error(`expected a 6-digit token, got: ${token}`);
  }
  return token;
}

function wrongCode(uri: string): string {
  const parsed = URI.parse(uri) as unknown as {
    generate: (options?: { timestamp?: number }) => string;
  };
  const nearby = new Set(
    [-1, 0, 1].map(
      (delta) => parsed.generate({ timestamp: Date.now() + delta * 30_000 }),
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

describe("startTotpSetupAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(startTotpSetupAction()).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("rejects a user whose two-factor authentication is already enabled", async () => {
    const userId = await seedSession();
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));

    const result = await startTotpSetupAction();

    expect(result).toEqual({
      ok: false,
      error: "Two-factor authentication is already enabled.",
    });
  });

  it("stores an encrypted secret, returns a well-formed uri and QR, and leaves totp_enabled false", async () => {
    const userId = await seedSession();

    const result = await startTotpSetupAction();

    if (!result.ok) throw new Error("expected setup to start");
    expect(result.uri.startsWith("otpauth://totp/")).toBe(true);
    expect(result.uri).toContain("issuer=Secure");
    expect(result.uri).toContain("user%40example.com");
    expect(result.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.totpEnabled).toBe(false);
    expect(row?.totpSecretEncrypted).toBeTruthy();
    const secret = decryptTotpSecret(row?.totpSecretEncrypted ?? "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const token = currentTokenFromUri(result.uri);
    expect(verifyTotpCode(secret, token)).toBe(true);
  });
});

describe("confirmTotpSetupAction (integration)", () => {
  const prevState = { ok: false, error: "" };

  function formData(code: string): FormData {
    const data = new FormData();
    data.set("code", code);
    return data;
  }

  it("redirects to /login without a session", async () => {
    await seedUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      confirmTotpSetupAction(prevState, formData("123456")),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("counts attempts, blocks the 6th before verification, and changes nothing", async () => {
    const userId = await seedSession();
    const start = await startTotpSetupAction();
    if (!start.ok) throw new Error("expected setup to start");
    const code = wrongCode(start.uri);

    for (let i = 0; i < 5; i += 1) {
      expect(await confirmTotpSetupAction(prevState, formData(code))).toEqual({
        ok: false,
        error: "That code didn't match. Try again.",
      });
    }
    expect(
      await confirmTotpSetupAction(prevState, formData(code)),
    ).toEqual({
      ok: false,
      error: "Too many attempts. Try again later.",
    });

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.totpEnabled).toBe(false);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("enables two-factor authentication on a valid code with one audit event", async () => {
    const userId = await seedSession();
    const start = await startTotpSetupAction();
    if (!start.ok) throw new Error("expected setup to start");
    const token = currentTokenFromUri(start.uri);

    const result = await confirmTotpSetupAction(prevState, formData(token));

    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row?.totpEnabled).toBe(true);

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("2fa.enabled");
    expect(events[0]?.actorUserId).toBe(userId);
    expect(events[0]?.resourceType).toBe("user");
    expect(events[0]?.resourceId).toBe(userId);
    expect(events[0]?.metadata).toEqual({});
  });

  it("rejects a further confirmation once two-factor authentication is enabled", async () => {
    await seedSession();
    const start = await startTotpSetupAction();
    if (!start.ok) throw new Error("expected setup to start");
    const token = currentTokenFromUri(start.uri);
    expect(await confirmTotpSetupAction(prevState, formData(token))).toEqual({
      ok: true,
    });

    const again = await confirmTotpSetupAction(prevState, formData(token));

    expect(again).toEqual({
      ok: false,
      error: "Two-factor authentication is already enabled.",
    });
  });

  it("tells a user without a pending setup to start first", async () => {
    await seedSession();

    const result = await confirmTotpSetupAction(
      prevState,
      formData("123456"),
    );

    expect(result).toEqual({ ok: false, error: "Start setup first." });
  });
});
