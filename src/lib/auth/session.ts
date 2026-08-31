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
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1000);

  const payload: SessionData = {
    userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await valkey.set(
    sessionKey(tokenHash),
    JSON.stringify(payload),
    "EX",
    SESSION_TTL_SECONDS,
  );

  await db.insert(sessions).values({ userId, tokenHash, expiresAt });

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
