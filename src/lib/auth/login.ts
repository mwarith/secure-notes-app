import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { verifyPassword } from "./password";
import {
  createSession,
  destroySession,
  getSession,
} from "./session";
import { isValidEmail, normalizeEmail } from "./validation";

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$Z9NIRIIIuR+fZzA4hrrZyQ$GSrGd6dOroMRZCyl+2Poc648AddkinPOoXVjyjmZLrc";

export type LoginResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid_credentials" };

type CredentialCheck =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "invalid_credentials";
      outcome: "unknown_email" | "malformed_input" | "wrong_password";
      userId?: string;
    };

export async function verifyCredentials(input: {
  email: unknown;
  password: unknown;
}): Promise<CredentialCheck> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : null;

  if (email && password) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (user) {
      const valid = await verifyPassword(password, user.passwordHash);
      if (valid) {
        return { ok: true, userId: user.id };
      }
      return {
        ok: false,
        reason: "invalid_credentials",
        outcome: "wrong_password",
        userId: user.id,
      };
    }
  }

  await verifyPassword(password ?? "", DUMMY_PASSWORD_HASH);

  const outcome =
    email && isValidEmail(email) && password
      ? "unknown_email"
      : "malformed_input";
  return { ok: false, reason: "invalid_credentials", outcome };
}

export async function login(input: {
  email: unknown;
  password: unknown;
}): Promise<LoginResult> {
  const check = await verifyCredentials(input);

  if (check.ok) {
    const { token, expiresAt } = await createSession(check.userId);
    await recordAuditEvent(db, {
      actorUserId: check.userId,
      resourceType: "user",
      resourceId: check.userId,
      action: "login.success",
      metadata: { method: "password" },
    });
    return { ok: true, userId: check.userId, token, expiresAt };
  }

  await recordAuditEvent(db, {
    actorUserId: check.userId ?? null,
    resourceType: check.userId ? "user" : null,
    resourceId: check.userId ?? null,
    action: "login.failed",
    metadata: { method: "password", outcome: check.outcome },
  });

  return { ok: false, reason: "invalid_credentials" };
}

export async function logout(token: string | undefined | null): Promise<void> {
  if (!token) {
    return;
  }
  const session = await getSession(token);
  if (!session) {
    return;
  }
  await destroySession(token);
  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "logout.success",
    metadata: { method: "password" },
  });
}
