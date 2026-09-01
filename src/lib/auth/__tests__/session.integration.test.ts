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
  activateSession,
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

  it("round-trips a pending two-factor session through payload and DB row", async () => {
    const { token } = await createSession(userId, {
      pendingTwoFactor: true,
    });

    const session = await getSession(token);
    expect(session).not.toBeNull();
    expect(session?.pendingTwoFactor).toBe(true);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row.pendingTwoFactor).toBe(true);
  });

  it("creates non-pending sessions by default", async () => {
    const { token } = await createSession(userId);

    const session = await getSession(token);
    expect(session?.pendingTwoFactor).toBe(false);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row.pendingTwoFactor).toBe(false);
  });

  it("activateSession clears the pending flag in both stores and keeps every other field", async () => {
    const { token, expiresAt } = await createSession(userId, {
      pendingTwoFactor: true,
    });

    await activateSession(token);

    const session = await getSession(token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(userId);
    expect(session?.expiresAt).toBe(expiresAt.toISOString());
    expect(session?.pendingTwoFactor).toBe(false);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row).toBeDefined();
    expect(row.userId).toBe(userId);
    expect(row.pendingTwoFactor).toBe(false);
  });

  it("activateSession is a safe no-op for a non-pending, bogus, or missing token", async () => {
    const { token } = await createSession(userId);

    await expect(activateSession(token)).resolves.toBeUndefined();
    await expect(activateSession("bogus-token")).resolves.toBeUndefined();
    await expect(activateSession(undefined)).resolves.toBeUndefined();
    await expect(activateSession(null)).resolves.toBeUndefined();

    const session = await getSession(token);
    expect(session?.pendingTwoFactor).toBe(false);
  });

  it("activateSession cleans up an expired pending session instead of activating it", async () => {
    const { token } = await createSession(userId, {
      pendingTwoFactor: true,
    });
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashSessionToken(token)));

    await activateSession(token);

    expect(await getSession(token)).toBeNull();
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token))),
    ).toHaveLength(0);
    expect(await valkey.get(valkeyKeyFor(token))).toBeNull();
  });

  it("preserves the pending flag in the durable fallback during a Valkey outage", async () => {
    const { token } = await createSession(userId, {
      pendingTwoFactor: true,
    });

    const getSpy = vi
      .spyOn(appValkey, "get")
      .mockRejectedValue(new Error("connection refused"));
    try {
      const session = await getSession(token);
      expect(session).not.toBeNull();
      // A pending session must NOT be promoted to fully active by the
      // outage fallback — that would silently bypass the 2FA challenge.
      expect(session?.pendingTwoFactor).toBe(true);
    } finally {
      getSpy.mockRestore();
    }
  });

  it("activateSession repairs the wedge when the Valkey payload write fails first", async () => {
    const { token, expiresAt } = await createSession(userId, {
      pendingTwoFactor: true,
    });
    const tokenHash = hashSessionToken(token);

    const setSpy = vi
      .spyOn(appValkey, "set")
      .mockRejectedValueOnce(new Error("connection refused"));
    try {
      await expect(activateSession(token)).rejects.toThrow("connection refused");
      // The durable row must still be pending: the payload write failed
      // BEFORE the row flip, so the challenge stays enforceable.
      const [wedgeRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash));
      expect(wedgeRow.pendingTwoFactor).toBe(true);
    } finally {
      setSpy.mockRestore();
    }

    // Retry after Valkey recovers converges: both stores end up active.
    await activateSession(token);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash));
    expect(row.pendingTwoFactor).toBe(false);
    const session = await getSession(token);
    expect(session?.pendingTwoFactor).toBe(false);
    expect(session?.expiresAt).toBe(expiresAt.toISOString());
  });
});

