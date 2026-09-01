import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { sessions } from "@/db/schema";
import { db } from "@/db";
import { log } from "@/lib/logger";
import { valkey } from "@/lib/valkey";

export const SESSION_TTL_SECONDS = 60 * 60 * 24;
export const SESSION_COOKIE_NAME = "session";

export type SessionData = {
  userId: string;
  createdAt: string;
  expiresAt: string;
  pendingTwoFactor?: boolean;
};

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

export async function createSession(
  userId: string,
  options?: { pendingTwoFactor?: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1000);
  const pendingTwoFactor = options?.pendingTwoFactor === true;

  const payload: SessionData = {
    userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    pendingTwoFactor,
  };
  await valkey.set(
    sessionKey(tokenHash),
    JSON.stringify(payload),
    "EX",
    SESSION_TTL_SECONDS,
  );

  await db
    .insert(sessions)
    .values({ userId, tokenHash, expiresAt, pendingTwoFactor });

  return { token, expiresAt };
}

export async function getSession(
  token: string | undefined | null,
): Promise<SessionData | null> {
  if (!token) {
    return null;
  }
  const tokenHash = hashSessionToken(token);
  let raw: string | null;
  try {
    raw = await valkey.get(sessionKey(tokenHash));
  } catch {
    // Valkey unreachable: verify against the durable Postgres row instead
    // (PRD §18 — the cache must not become a single point of failure for
    // durable data). A Valkey MISS above stays authoritative (null); only
    // an ERROR falls back here.
    log("warn", "session.valkey_unavailable_durable_fallback");
    return getSessionFromDurableRow(tokenHash);
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SessionData;
    if (typeof parsed.userId !== "string") {
      return null;
    }
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function getSessionFromDurableRow(
  tokenHash: string,
): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function destroySession(
  token: string | undefined | null,
): Promise<void> {
  if (!token) {
    return;
  }
  const tokenHash = hashSessionToken(token);
  try {
    await valkey.del(sessionKey(tokenHash));
  } catch {
    // Best-effort: the Valkey entry is TTL-bounded, so a dangling entry
    // expires on its own. The durable row and the cleared cookie are what
    // actually end the session.
  }
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Clears a session's pending-two-factor flag in BOTH stores once the login
 * challenge succeeds, promoting it to a fully active session. The durable
 * sessions row is the source of truth; a non-pending token is a safe no-op,
 * so replaying the activation can never revive anything.
 *
 * The Valkey payload is re-written (not patched) because ioredis has no
 * partial JSON update — the original remaining TTL is preserved and the
 * rewritten payload only ever carries the fields createSession wrote. An
 * expired or expiring-imminently session is cleaned up rather than
 * activated.
 */
export async function activateSession(
  token: string | undefined | null,
): Promise<void> {
  if (!token) {
    return;
  }
  const tokenHash = hashSessionToken(token);

  const [row] = await db
    .select({
      userId: sessions.userId,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        eq(sessions.pendingTwoFactor, true),
      ),
    )
    .limit(1);

  if (!row) {
    return;
  }

  await db
    .update(sessions)
    .set({ pendingTwoFactor: false })
    .where(eq(sessions.tokenHash, tokenHash));

  const remainingTtlSeconds = Math.ceil(
    (row.expiresAt.getTime() - Date.now()) / 1000,
  );
  if (remainingTtlSeconds <= 0) {
    try {
      await valkey.del(sessionKey(tokenHash));
    } catch {
      // The TTL-bounded entry is already gone or unreachable; the durable
      // row state is what governs future access.
    }
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return;
  }

  const payload: SessionData = {
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    pendingTwoFactor: false,
  };
  await valkey.set(
    sessionKey(tokenHash),
    JSON.stringify(payload),
    "EX",
    remainingTtlSeconds,
  );
}
