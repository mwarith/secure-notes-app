import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { registerUser } from "@/lib/auth/register";
import { resolveTestDatabaseUrl } from "../../../../vitest.helpers";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);

afterAll(async () => {
  await Promise.all([pool.end(), appPool.end()]);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
});

describe("registerUser (integration)", () => {
  it("creates the user with a hashed password and writes the account_created audit event", async () => {
    const result = await registerUser({
      email: "User@Example.com",
      password: "correct horse battery staple",
    });

    expect(result).toEqual({ ok: true, userId: expect.any(String) });

    const [user] = await db.select().from(users);
    expect(user.email).toBe("user@example.com");
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain("correct horse battery staple");

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("account.created");
    expect(event.resourceType).toBe("user");
    expect(event.resourceId).toBe(user.id);
    expect(event.actorUserId).toBe(user.id);
    expect(event.metadata).toEqual({ method: "password" });
  });

  it("rejects a duplicate email with a neutral result and creates nothing new", async () => {
    const first = await registerUser({
      email: "user@example.com",
      password: "correct horse battery staple",
    });
    expect(first.ok).toBe(true);

    const second = await registerUser({
      email: "user@example.com",
      password: "another good password",
    });
    expect(second).toEqual({ ok: false, reason: "duplicate_email" });

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("treats a different case of a registered email as a duplicate", async () => {
    await registerUser({
      email: "user@example.com",
      password: "correct horse battery staple",
    });

    const result = await registerUser({
      email: "USER@EXAMPLE.COM",
      password: "another good password",
    });

    expect(result).toEqual({ ok: false, reason: "duplicate_email" });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("rejects a weak password without touching the database", async () => {
    const result = await registerUser({
      email: "user@example.com",
      password: "short",
    });

    expect(result).toEqual({ ok: false, reason: "weak_password" });
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("rejects a malformed email without touching the database", async () => {
    const result = await registerUser({
      email: "not-an-email",
      password: "correct horse battery staple",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_email" });
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("rejects empty and missing fields instead of crashing", async () => {
    expect(
      await registerUser({
        email: "",
        password: "correct horse battery staple",
      }),
    ).toEqual({ ok: false, reason: "invalid_email" });

    expect(
      await registerUser({ email: "user@example.com", password: "" }),
    ).toEqual({ ok: false, reason: "weak_password" });

    expect(await registerUser({ email: undefined, password: undefined })).toEqual({
      ok: false,
      reason: "invalid_email",
    });

    expect(
      await registerUser({ email: "user@example.com", password: undefined }),
    ).toEqual({ ok: false, reason: "weak_password" });

    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });
});
