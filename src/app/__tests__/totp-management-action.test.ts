import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, twoFactorRecoveryCodes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { createSession } from "@/lib/auth/session";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/totp-crypto";
import { generateTotpSecret, totpUri } from "@/lib/auth/totp";
import { TOTP, URI } from "otpauth";
import {
  disableTotpAction,
  regenerateRecoveryCodesAction,
  type DisableTotpState,
  type RegenerateState,
} from "@/app/settings/security/actions";
import { readCounter } from "@/lib/metrics";
import { captureLog } from "@/lib/__tests__/log-capture";
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

vi.mock("@/lib/auth/active-session", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/auth/active-session")
  >();
  return {
    ...actual,
    getActiveSession: vi.fn(actual.getActiveSession),
  };
});

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

async function seedEnabledUser(): Promise<{ userId: string; secret: string }> {
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

async function seedNotEnabledUser(): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  return user.id;
}

async function seedActiveSession(userId: string): Promise<void> {
  const { token } = await createSession(userId);
  vi.mocked(cookieStore.get).mockReturnValue({
    name: "session",
    value: token,
  } as never);
}

async function seedSessionForEnabledUser(): Promise<{
  userId: string;
  secret: string;
}> {
  const { userId, secret } = await seedEnabledUser();
  await seedActiveSession(userId);
  return { userId, secret };
}

function totpFromUri(uri: string): TOTP {
  const parsed = URI.parse(uri);
  if (!(parsed instanceof TOTP)) {
    throw new Error("expected the parsed URI to be a TOTP instance");
  }
  return parsed;
}

function currentTokenFromUri(uri: string): string {
  const token = totpFromUri(uri).generate();
  if (!/^[0-9]{6}$/.test(token)) {
    throw new Error(`expected a 6-digit token, got: ${token}`);
  }
  return token;
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

async function seedRecoveryCodes(
  userId: string,
  codes: { code: string; used?: boolean }[],
): Promise<void> {
  await db.insert(twoFactorRecoveryCodes).values(
    codes.map(({ code, used }) => ({
      userId,
      codeHash: hashRecoveryCode(code),
      usedAt: used ? new Date() : null,
    })),
  );
}

async function enabledUserRow(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row;
}

async function recoveryRowCount(userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(twoFactorRecoveryCodes)
    .where(eq(twoFactorRecoveryCodes.userId, userId));
  return rows.length;
}

const disablePrevState: DisableTotpState = {
  ok: false,
  field: "form",
  error: "",
};
const regeneratePrevState: RegenerateState = { ok: false, error: "" };

function disableFormData(
  password: string,
  code: string,
  mode?: "recovery",
): FormData {
  const data = new FormData();
  data.set("password", password);
  data.set("code", code);
  if (mode) data.set("mode", mode);
  return data;
}

function regenerateFormData(password: string): FormData {
  const data = new FormData();
  data.set("password", password);
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(redirect).mockReset();
  vi.mocked(revalidatePath).mockReset();
});

describe("disableTotpAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedEnabledUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      disableTotpAction(disablePrevState, disableFormData(PASSWORD, "123456")),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("rejects a user whose two-factor authentication is not enabled", async () => {
    const userId = await seedNotEnabledUser();
    await seedActiveSession(userId);

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, "123456"),
    );

    expect(result).toEqual({
      ok: false,
      field: "form",
      error: "Two-factor authentication is not enabled.",
    });
  });

  it("rejects a wrong password with a field error and changes nothing", async () => {
    const { userId, secret } = await seedSessionForEnabledUser();

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData("not the password", "123456"),
    );

    expect(result).toEqual({
      ok: false,
      field: "password",
      error: "That password didn't match.",
    });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(true);
    expect(decryptTotpSecret(row?.totpSecretEncrypted ?? "")).toBe(secret);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("rejects a wrong totp code with a field error and changes nothing", async () => {
    const { userId, secret } = await seedSessionForEnabledUser();

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, wrongCode(totpUri(secret, EMAIL))),
    );

    expect(result).toEqual({
      ok: false,
      field: "code",
      error: "That code didn't match. Try again.",
    });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(true);
    expect(row?.totpSecretEncrypted).toBeTruthy();
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("disables two-factor authentication on a valid password and totp code", async () => {
    const { userId, secret } = await seedSessionForEnabledUser();
    await seedRecoveryCodes(userId, [
      { code: "abcde-fghij" },
      { code: "klmno-pqrst" },
    ]);
    const code = currentTokenFromUri(totpUri(secret, EMAIL));

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, code),
    );

    expect(result).toEqual({ ok: true });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(false);
    expect(row?.totpSecretEncrypted).toBeNull();

    expect(await recoveryRowCount(userId)).toBe(0);

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("2fa.disabled");
    expect(events[0]?.actorUserId).toBe(userId);
    expect(events[0]?.resourceType).toBe("user");
    expect(events[0]?.resourceId).toBe(userId);
    expect(events[0]?.metadata).toEqual({});

    expect(revalidatePath).toHaveBeenCalledWith("/settings/security");
  });

  it("disables via a valid unused recovery code with both audit events", async () => {
    const { userId } = await seedSessionForEnabledUser();
    await seedRecoveryCodes(userId, [
      { code: "abcde-fghij" },
      { code: "klmno-pqrst" },
    ]);

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, "abcde-fghij", "recovery"),
    );

    expect(result).toEqual({ ok: true });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(false);
    expect(row?.totpSecretEncrypted).toBeNull();
    expect(await recoveryRowCount(userId)).toBe(0);

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.action).sort()).toEqual([
      "2fa.disabled",
      "2fa.recovery_used",
    ]);
    for (const event of events) {
      expect(event.metadata).toEqual({});
      expect(event.actorUserId).toBe(userId);
    }
  });

  it("rejects an already-used recovery code with a field error and changes nothing", async () => {
    const { userId } = await seedSessionForEnabledUser();
    await seedRecoveryCodes(userId, [
      { code: "abcde-fghij", used: true },
      { code: "klmno-pqrst" },
    ]);

    const result = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, "abcde-fghij", "recovery"),
    );

    expect(result).toEqual({
      ok: false,
      field: "code",
      error: "That code didn't match. Try again.",
    });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(true);
    expect(row?.totpSecretEncrypted).toBeTruthy();
    expect(await recoveryRowCount(userId)).toBe(2);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("blocks the 6th disable attempt before verification once the budget is spent", async () => {
    const { userId, secret } = await seedSessionForEnabledUser();
    const wrong = wrongCode(totpUri(secret, EMAIL));

    for (let i = 0; i < 5; i += 1) {
      await disableTotpAction(
        disablePrevState,
        disableFormData(PASSWORD, wrong),
      );
    }
    expect(await db.select().from(auditEvents)).toHaveLength(0);

    const blocked = await disableTotpAction(
      disablePrevState,
      disableFormData(PASSWORD, wrong),
    );

    expect(blocked).toEqual({
      ok: false,
      field: "form",
      error: "Too many attempts. Try again later.",
    });

    const row = await enabledUserRow(userId);
    expect(row?.totpEnabled).toBe(true);
    expect(row?.totpSecretEncrypted).toBeTruthy();
  });

  it("fails closed when the limiter store is unavailable", async () => {
    const { userId, secret } = await seedSessionForEnabledUser();
    const consoleError = vi.spyOn(console, "error").mockClear();
    const incr = vi.spyOn(appValkey, "incr").mockRejectedValue(
      new Error("valkey down"),
    );

    try {
      const result = await disableTotpAction(
        disablePrevState,
        disableFormData(PASSWORD, currentTokenFromUri(totpUri(secret, EMAIL))),
      );

      expect(result).toEqual({
        ok: false,
        field: "form",
        error: "Too many attempts. Try again later.",
      });

      const row = await enabledUserRow(userId);
      expect(row?.totpEnabled).toBe(true);
      expect(await db.select().from(auditEvents)).toEqual([]);
    } finally {
      incr.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("captures an unexpected failure and returns the safe form error without leaking raw error text", async () => {
    const { getActiveSession } = await import("@/lib/auth/active-session");
    await seedSessionForEnabledUser();
    vi.mocked(getActiveSession).mockRejectedValueOnce(
      new Error("session table corrupted during management"),
    );
    const logCapture = captureLog();
    try {
      const before = readCounter("errors.unexpected");

      const result = await disableTotpAction(
        disablePrevState,
        disableFormData(PASSWORD, "123456"),
      );

      expect(result).toEqual({
        ok: false,
        field: "form",
        error: "Something went wrong. Please try again.",
      });
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
});

describe("regenerateRecoveryCodesAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedEnabledUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      regenerateRecoveryCodesAction(
        regeneratePrevState,
        regenerateFormData(PASSWORD),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("rejects regeneration when two-factor authentication is not enabled", async () => {
    const userId = await seedNotEnabledUser();
    await seedActiveSession(userId);

    const result = await regenerateRecoveryCodesAction(
      regeneratePrevState,
      regenerateFormData(PASSWORD),
    );

    expect(result).toEqual({
      ok: false,
      error: "Enable two-factor authentication first.",
    });
  });

  it("rejects a wrong password and leaves the codes unchanged", async () => {
    const { userId } = await seedSessionForEnabledUser();
    await seedRecoveryCodes(userId, [
      { code: "abcde-fghij" },
      { code: "klmno-pqrst" },
    ]);

    const result = await regenerateRecoveryCodesAction(
      regeneratePrevState,
      regenerateFormData("not the password"),
    );

    expect(result).toEqual({
      ok: false,
      error: "That password didn't match.",
    });

    expect(await recoveryRowCount(userId)).toBe(2);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("replaces the batch with 8 fresh hashed codes on a valid password", async () => {
    const { userId } = await seedSessionForEnabledUser();
    await seedRecoveryCodes(userId, [
      { code: "abcde-fghij" },
      { code: "klmno-pqrst" },
    ]);

    const result = await regenerateRecoveryCodesAction(
      regeneratePrevState,
      regenerateFormData(PASSWORD),
    );

    if (!result.ok) throw new Error("expected regeneration to succeed");
    expect(result.recoveryCodes).toHaveLength(8);
    for (const code of result.recoveryCodes) {
      expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    }

    const stored = await db
      .select()
      .from(twoFactorRecoveryCodes)
      .where(eq(twoFactorRecoveryCodes.userId, userId));
    expect(stored).toHaveLength(8);
    const hashes = new Set(stored.map((row) => row.codeHash));
    for (const row of stored) {
      expect(row.usedAt).toBeNull();
    }
    for (const plaintext of result.recoveryCodes) {
      expect(hashes.has(plaintext)).toBe(false);
      expect(hashes.has(hashRecoveryCode(plaintext))).toBe(true);
    }

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("2fa.recovery_codes_regenerated");
    expect(events[0]?.actorUserId).toBe(userId);
    expect(events[0]?.resourceType).toBe("user");
    expect(events[0]?.resourceId).toBe(userId);
    expect(events[0]?.metadata).toEqual({});

    expect(revalidatePath).toHaveBeenCalledWith("/settings/security");
  });
});
