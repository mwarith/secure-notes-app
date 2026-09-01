"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { activateSession } from "@/lib/auth/session";
import { verifyTotpCode } from "@/lib/auth/totp";
import { decryptTotpSecret } from "@/lib/auth/totp-crypto";
import { checkLoginRateLimit, resetLoginRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { valkey } from "@/lib/valkey";
import { recordAuditEvent } from "@/lib/audit";
import { log } from "@/lib/logger";

export type ChallengeState = { ok: true } | { ok: false; error: string };

const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again later.";
const INVALID_CODE_MESSAGE = "That code didn't match. Try again.";

/**
 * The second step of a 2FA login (PRD §8). Only a session that is still
 * pending two-factor verification may confirm; everything else is bounced.
 * Attempts consume the same ENG-5 login limiter as the password step (IP +
 * email, 5 per 15 minutes), so an attacker holding a valid password gets 6
 * guesses per window against the 6-digit code, and the first wrong code is
 * audited as login.failed with outcome "invalid_totp_code" — no secrets or
 * codes ever reach the audit record. On success the limiter is reset, the
 * pending flag is cleared in both session stores (activateSession), and the
 * user is sent to the workspace.
 */

export async function verifyTotpChallengeAction(
  _prevState: ChallengeState,
  formData: FormData,
): Promise<ChallengeState> {
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

  const ip = await getClientIp();
  const gate = await checkLoginRateLimit(valkey, { ip, email: user.email });
  if (gate && !gate.allowed) {
    return { ok: false, error: TOO_MANY_ATTEMPTS_MESSAGE };
  }

  if (!user.totpSecretEncrypted) {
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEncrypted);
  } catch {
    log("error", "2fa.challenge_decrypt_failed", { userId: session.userId });
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  const code = formData.get("code");
  const codeText = typeof code === "string" ? code : "";

  if (!verifyTotpCode(secret, codeText)) {
    await recordAuditEvent(db, {
      actorUserId: session.userId,
      resourceType: "user",
      resourceId: session.userId,
      action: "login.failed",
      metadata: { method: "password", outcome: "invalid_totp_code" },
    });
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  await resetLoginRateLimit(valkey, { ip, email: user.email });

  await activateSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  redirect("/");
}
