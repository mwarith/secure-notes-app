import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions } from "@/db/schema";
import { db } from "@/db";
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
  const raw = await valkey.get(sessionKey(hashSessionToken(token)));
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

export async function destroySession(
  token: string | undefined | null,
): Promise<void> {
  if (!token) {
    return;
  }
  const tokenHash = hashSessionToken(token);
  await valkey.del(sessionKey(tokenHash));
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
