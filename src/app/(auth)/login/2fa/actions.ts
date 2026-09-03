"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { twoFactorRecoveryCodes, users } from "@/db/schema";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { activateSession } from "@/lib/auth/session";
import { hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { TOTP_PERIOD, verifyTotpCodeDelta } from "@/lib/auth/totp";
import { decryptTotpSecret } from "@/lib/auth/totp-crypto";
import { checkTotpConfirmLimit, resetTotpConfirmLimit } from "@/lib/rate-limit";
import { valkey } from "@/lib/valkey";
import { recordAuditEvent } from "@/lib/audit";
import { log } from "@/lib/logger";
import { AppError, reportError } from "@/lib/errors";
import { isNextRedirect } from "@/lib/next-redirect";

export type ChallengeState = { ok: true } | { ok: false; error: string };

const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again later.";
const INVALID_CODE_MESSAGE = "That code didn't match. Try again.";
const UNEXPECTED_ERROR_MESSAGE = "Something went wrong. Please try again.";

function authError(userMessage: string): AppError {
  return new AppError({ class: "auth", userMessage });
}

/**
 * RFC 6238 §5.2 replay protection: the time-step of the last accepted code
 * is stored per user with a 90-second TTL (the full life of any code the
 * ±1 window could still accept). A code can therefore never authenticate
 * twice.
 */
const TOTP_REPLAY_TTL_SECONDS = 90;

function totpReplayKey(userId: string): string {
  return `totp-replay:v1:${createHash("sha256").update(userId).digest("hex")}`;
}

/**
 * Second step of a 2FA login: only a still-pending session may confirm.
 * Two modes share one flow — "totp" verifies a 6-digit code, "recovery"
 * atomically consumes one single-use code (conditional UPDATE, so
 * concurrent logins cannot spend it twice). Both use the userId-keyed
 * limiter (fail closed) — the user id is unspoofable and recovery codes
 * are as brute-forceable as TOTP codes. Wrong/replayed codes audit as
 * login.failed with a neutral, identical error; success resets the
 * limiter, activates the session in both stores, and audits the mode.
 */

export async function verifyTotpChallengeAction(
  _prevState: ChallengeState,
  formData: FormData,
): Promise<ChallengeState> {
  try {
    return await runChallenge(formData);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { ok: false, error: message };
  }
}

async function runChallenge(formData: FormData): Promise<ChallengeState> {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  if (!session.pendingTwoFactor) {
    redirect("/");
  }

  const [user] = await db
    .select({
      email: users.email,
      totpEnabled: users.totpEnabled,
      totpSecretEncrypted: users.totpSecretEncrypted,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect("/login");
  }

  if (!user.totpEnabled) {
    redirect("/");
  }

  const gate = await checkTotpConfirmLimit(valkey, {
    userId: session.userId,
  });
  if (gate && !gate.allowed) {
    throw authError(TOO_MANY_ATTEMPTS_MESSAGE);
  }

  const code = formData.get("code");
  const codeText = typeof code === "string" ? code : "";
  const mode = formData.get("mode") === "recovery" ? "recovery" : "totp";

  if (mode === "recovery") {
    const consumed = await db
      .update(twoFactorRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(twoFactorRecoveryCodes.userId, session.userId),
          eq(
            twoFactorRecoveryCodes.codeHash,
            hashRecoveryCode(codeText),
          ),
          isNull(twoFactorRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: twoFactorRecoveryCodes.id });

    if (consumed.length === 0) {
      await recordAuditEvent(db, {
        actorUserId: session.userId,
        resourceType: "user",
        resourceId: session.userId,
        action: "login.failed",
        metadata: { method: "password", outcome: "invalid_recovery_code" },
      });
      throw authError(INVALID_CODE_MESSAGE);
    }

    await resetTotpConfirmLimit(valkey, { userId: session.userId });

    await activateSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);

    await recordAuditEvent(db, {
      actorUserId: session.userId,
      resourceType: "user",
      resourceId: session.userId,
      action: "2fa.recovery_used",
      metadata: {},
    });

    redirect("/");
  }

  if (!user.totpSecretEncrypted) {
    throw authError(INVALID_CODE_MESSAGE);
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEncrypted);
  } catch {
    log("error", "2fa.challenge_decrypt_failed", { userId: session.userId });
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  const { valid, delta } = verifyTotpCodeDelta(secret, codeText);
  const timestep =
    valid && delta !== null
      ? Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta
      : null;

  const replayKey = totpReplayKey(session.userId);
  const lastUsedStep =
    timestep !== null ? Number((await valkey.get(replayKey)) ?? -1) : null;
  if (timestep !== null && lastUsedStep !== null && timestep <= lastUsedStep) {
    // RFC 6238 §5.2 replay: this exact code (or an older one) already
    // authenticated — reject it exactly like a wrong code.
    await recordAuditEvent(db, {
      actorUserId: session.userId,
      resourceType: "user",
      resourceId: session.userId,
      action: "login.failed",
      metadata: { method: "password", outcome: "invalid_totp_code" },
    });
    throw authError(INVALID_CODE_MESSAGE);
  }

  if (!valid) {
    await recordAuditEvent(db, {
      actorUserId: session.userId,
      resourceType: "user",
      resourceId: session.userId,
      action: "login.failed",
      metadata: { method: "password", outcome: "invalid_totp_code" },
    });
    throw authError(INVALID_CODE_MESSAGE);
  }

  await valkey.set(replayKey, String(timestep), "EX", TOTP_REPLAY_TTL_SECONDS);

  await resetTotpConfirmLimit(valkey, { userId: session.userId });

  await activateSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "2fa.challenge_passed",
    metadata: {},
  });

  redirect("/");
}
