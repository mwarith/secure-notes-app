import { users } from "@/db/schema";
import { db } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { hashPassword } from "./password";
import { isValidEmail, normalizeEmail, validatePassword } from "./validation";

export type RegisterFailureReason =
  | "invalid_email"
  | "weak_password"
  | "duplicate_email";

export type RegisterResult =
  | { ok: true; userId: string }
  | { ok: false; reason: RegisterFailureReason };

const UNIQUE_VIOLATION = "23505";
const USERS_EMAIL_UNIQUE_INDEX = "users_email_unique_idx";

function isPgUniqueViolationOnEmail(error: object): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === UNIQUE_VIOLATION &&
    candidate.constraint === USERS_EMAIL_UNIQUE_INDEX
  );
}

function isDuplicateEmailError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if (isPgUniqueViolationOnEmail(current)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function registerUser(input: {
  email: unknown;
  password: unknown;
}): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  if (!email || !isValidEmail(email)) {
    return { ok: false, reason: "invalid_email" };
  }

  const password = typeof input.password === "string" ? input.password : null;
  if (!password || !validatePassword(password, email)) {
    return { ok: false, reason: "weak_password" };
  }

  const passwordHash = await hashPassword(password);

  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash })
        .returning({ id: users.id });

      await recordAuditEvent(tx, {
        actorUserId: user.id,
        resourceType: "user",
        resourceId: user.id,
        action: "account.created",
        metadata: { method: "password" },
      });

      return { ok: true, userId: user.id };
    });
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      return { ok: false, reason: "duplicate_email" };
    }
    throw error;
  }
}
