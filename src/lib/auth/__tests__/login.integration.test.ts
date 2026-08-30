import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { resolveTestDatabaseUrl, resolveTestValkeyUrl } from "../../../../vitest.helpers";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
});

describe("login (integration)", () => {
  it("issues a session and writes login.success on valid credentials", async () => {
    const userId = await seedUser();

    const result = await login({ email: EMAIL, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(userId);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const session = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(session).toHaveLength(1);

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("login.success");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("user");
    expect(event.resourceId).toBe(userId);
    expect(event.metadata).toEqual({ method: "password" });
  });

  it("returns generic invalid_credentials and fully-NULL audit columns for a nonexistent email", async () => {
    const result = await login({
      email: "ghost@example.com",
      password: PASSWORD,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("login.failed");
    expect(event.actorUserId).toBeNull();
    expect(event.resourceType).toBeNull();
    expect(event.resourceId).toBeNull();
    expect(event.metadata).toEqual({
      method: "password",
      outcome: "unknown_email",
    });

    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("returns generic invalid_credentials and attributes the failure to the user for a wrong password", async () => {
    const userId = await seedUser();

    const result = await login({
      email: EMAIL,
      password: "wrong password 123",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_credentials" });

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("login.failed");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("user");
    expect(event.resourceId).toBe(userId);
    expect(event.metadata).toEqual({
      method: "password",
      outcome: "wrong_password",
    });

    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("keeps passwords, tokens, and emails out of audit metadata on every path", async () => {
    await seedUser();

    await login({ email: EMAIL, password: PASSWORD });
    await login({ email: "ghost@example.com", password: PASSWORD });
    await login({ email: EMAIL, password: "wrong password 123" });

    const events = await db.select().from(auditEvents);
    expect(events).toHaveLength(3);
    for (const event of events) {
      const serialized = JSON.stringify(event.metadata).toLowerCase();
      expect(serialized).not.toContain(PASSWORD.toLowerCase());
      expect(serialized).not.toContain(EMAIL);
      expect(serialized).not.toContain("token");
    }
  });

  it("treats a malformed email or missing password as generic invalid_credentials", async () => {
    await seedUser();

    expect(
      await login({ email: "not-an-email", password: PASSWORD }),
    ).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await login({ email: EMAIL, password: undefined })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    expect(await login({ email: undefined, password: undefined })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });

    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});
