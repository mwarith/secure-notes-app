import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessions, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import {
  createSession,
  destroySession,
  getSession,
  hashSessionToken,
} from "@/lib/auth/session";
import { resolveTestDatabaseUrl, resolveTestValkeyUrl } from "../../../../vitest.helpers";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

let userId: string;

function valkeyKeyFor(token: string): string {
  return `session:${createHash("sha256").update(token).digest("hex")}`;
}

afterAll(async () => {
  await Promise.all([
    pool.end(),
    appPool.end(),
    valkey.quit().catch(() => undefined),
    appValkey.quit().catch(() => undefined),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await valkey.flushdb();
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
  const [user] = await db
    .insert(users)
    .values({ email: "session-user@example.com", passwordHash: "not-checked-here" })
    .returning({ id: users.id });
  userId = user.id;
});

describe("session store (integration)", () => {
  it("round-trips a session from create through get", async () => {
    const { token, expiresAt } = await createSession(userId);

    const session = await getSession(token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(userId);
    expect(session?.expiresAt).toBe(expiresAt.toISOString());
  });

  it("keys the Valkey entry by sha256 of the token, not the raw token", async () => {
    const { token } = await createSession(userId);

    const stored = await valkey.get(valkeyKeyFor(token));
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(token);
  });

  it("writes a durable row in the sessions table on create", async () => {
    const { token } = await createSession(userId);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row).toBeDefined();
    expect(row.userId).toBe(userId);
  });

  it("rejects a destroyed session and removes the durable row", async () => {
    const { token } = await createSession(userId);
    await destroySession(token);

    expect(await getSession(token)).toBeNull();
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token))),
    ).toHaveLength(0);
  });

  it("rejects an expired session", async () => {
    const { token } = await createSession(userId);

    await valkey.set(
      valkeyKeyFor(token),
      JSON.stringify({ userId: userId, createdAt: new Date().toISOString(), expiresAt: "1970-01-01T00:00:00.000Z" }),
      "EX",
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await getSession(token)).toBeNull();
  });

  it("rejects an already-invalidated session when destroyed twice", async () => {
    const { token } = await createSession(userId);
    await destroySession(token);

    await expect(destroySession(token)).resolves.toBeUndefined();
    expect(await getSession(token)).toBeNull();
  });

  it("destroys nothing without throwing for a bogus or missing token", async () => {
    await expect(destroySession("bogus-token")).resolves.toBeUndefined();
    await expect(destroySession(undefined)).resolves.toBeUndefined();
    await expect(destroySession(null)).resolves.toBeUndefined();
  });

  it("returns null for a missing or empty token", async () => {
    expect(await getSession(undefined)).toBeNull();
    expect(await getSession(null)).toBeNull();
    expect(await getSession("")).toBeNull();
  });

  it("falls back to the durable Postgres row when Valkey is unreachable", async () => {
    const { token, expiresAt } = await createSession(userId);

    const getSpy = vi
      .spyOn(appValkey, "get")
      .mockRejectedValue(new Error("connection refused"));
    try {
      const session = await getSession(token);
      expect(session).not.toBeNull();
      expect(session?.userId).toBe(userId);
      expect(session?.expiresAt).toBe(expiresAt.toISOString());
    } finally {
      getSpy.mockRestore();
    }
  });

  it("returns null from the durable fallback when no valid row exists", async () => {
    const { token } = await createSession(userId);
    await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));

    const getSpy = vi
      .spyOn(appValkey, "get")
      .mockRejectedValue(new Error("connection refused"));
    try {
      expect(await getSession(token)).toBeNull();
    } finally {
      getSpy.mockRestore();
    }
  });

  it("keeps logout working when Valkey is unreachable (Valkey delete is best-effort)", async () => {
    const { token } = await createSession(userId);

    const delSpy = vi
      .spyOn(appValkey, "del")
      .mockRejectedValue(new Error("connection refused"));
    try {
      await expect(destroySession(token)).resolves.toBeUndefined();
      expect(
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.tokenHash, hashSessionToken(token))),
      ).toHaveLength(0);
    } finally {
      delSpy.mockRestore();
    }
  });
});

