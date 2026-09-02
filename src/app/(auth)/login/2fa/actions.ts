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
 * RFC 6238 §5.2 replay protection: the absolute time-step of the last
 * successfully validated code is stored per user (sha256 of the id, matching
 * the rate-limiter key convention) with a 90-second TTL — three 30-second
 * windows, the full life of any code the ±1 window could still accept. A
 * verification whose time-step is not strictly newer than the stored one is
 * rejected as a replay, so a code can never authenticate twice.
 */
const TOTP_REPLAY_TTL_SECONDS = 90;

function totpReplayKey(userId: string): string {
  return `totp-replay:v1:${createHash("sha256").update(userId).digest("hex")}`;
}

/**
 * The second step of a 2FA login (PRD §8). Only a session that is still
 * pending two-factor verification may confirm; everything else is bounced.
 * Two challenge modes share one flow (ENG-31): "totp" (default) verifies a
 * 6-digit authenticator code, "recovery" consumes one of the one-time
 * codes issued at activation — the input is normalized (trim, lowercase)
 * and hashed, then a single conditional UPDATE
 * (…WHERE user_id = … AND code_hash = … AND used_at IS NULL RETURNING id)
 * atomically marks the code used, so two concurrent logins can never spend
 * the same code. Both modes consume the userId-keyed TOTP limiter (5 per
 * 15 minutes, fail closed) rather than the IP-keyed login limiter — the
 * session's user id is unspoofable, so a directly exposed deployment
 * cannot rotate fresh attempt budgets by forging X-Forwarded-For, and
 * recovery codes are exactly as brute-forceable as TOTP codes, so the
 * same budget applies. A wrong, replayed, or already-used code is audited
 * as login.failed with outcome "invalid_totp_code" or
 * "invalid_recovery_code" — no secrets or codes ever reach the audit
 * record, and the neutral error is identical in both modes. On success
 * the limiter is reset, the pending flag is cleared in both session
 * stores (activateSession), a mode-specific audit event is recorded, and
 * the user is sent to the workspace.
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
