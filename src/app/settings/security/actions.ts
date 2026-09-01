"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  generateTotpSecret,
  totpQrDataUrl,
  totpUri,
  verifyTotpCode,
} from "@/lib/auth/totp";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/totp-crypto";
import { checkTotpConfirmLimit, resetTotpConfirmLimit } from "@/lib/rate-limit";
import { valkey } from "@/lib/valkey";
import { recordAuditEvent } from "@/lib/audit";
import { log } from "@/lib/logger";

export type StartTotpSetupResult =
  | { ok: true; uri: string; qrDataUrl: string }
  | { ok: false; error: string };

export type ConfirmTotpState = { ok: true } | { ok: false; error: string };

const ALREADY_ENABLED_MESSAGE =
  "Two-factor authentication is already enabled.";
const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again later.";
const NO_PENDING_SETUP_MESSAGE = "Start setup first.";
const INVALID_CODE_MESSAGE = "That code didn't match. Try again.";

/**
 * Two-factor setup actions (PRD §8). The plaintext secret exists only in
 * memory inside these functions: it is stored encrypted via the ENG-27
 * at-rest encryption, is never logged, and is returned to the client once —
 * embedded in the otpauth:// URI of the start response (ENG-29 renders it
 * as the QR the user scans). Confirmation consumes the ENG-5-style fixed
 * window limiter BEFORE verification, so online guessing of the 6-digit
 * code is bounded to 5 tries per 15 minutes per user; success resets the
 * window and writes exactly one 2fa.enabled audit event with no secrets in
 * metadata.
 */

export async function startTotpSetupAction(): Promise<StartTotpSetupResult> {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      totpEnabled: users.totpEnabled,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect("/login");
  }

  if (user.totpEnabled) {
    return { ok: false, error: ALREADY_ENABLED_MESSAGE };
  }

  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret);

  await db
    .update(users)
    .set({ totpSecretEncrypted: encrypted })
    .where(eq(users.id, session.userId));

  const uri = totpUri(secret, user.email);
  const qrDataUrl = await totpQrDataUrl(uri);

  return { ok: true, uri, qrDataUrl };
}

export async function confirmTotpSetupAction(
  _prevState: ConfirmTotpState,
  formData: FormData,
): Promise<ConfirmTotpState> {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  const gate = await checkTotpConfirmLimit(valkey, {
    userId: session.userId,
  });
  if (gate && !gate.allowed) {
    return { ok: false, error: TOO_MANY_ATTEMPTS_MESSAGE };
  }

  const [user] = await db
    .select({
      totpEnabled: users.totpEnabled,
      totpSecretEncrypted: users.totpSecretEncrypted,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect("/login");
  }

  if (user.totpEnabled) {
    return { ok: false, error: ALREADY_ENABLED_MESSAGE };
  }

  if (!user.totpSecretEncrypted) {
    return { ok: false, error: NO_PENDING_SETUP_MESSAGE };
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEncrypted);
  } catch {
    log("error", "2fa.confirm_decrypt_failed", { userId: session.userId });
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  const code = formData.get("code");
  const codeText = typeof code === "string" ? code : "";

  if (!verifyTotpCode(secret, codeText)) {
    return { ok: false, error: INVALID_CODE_MESSAGE };
  }

  await db
    .update(users)
    .set({ totpEnabled: true })
    .where(eq(users.id, session.userId));

  await resetTotpConfirmLimit(valkey, { userId: session.userId });

  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "2fa.enabled",
    metadata: {},
  });

  return { ok: true };
}
