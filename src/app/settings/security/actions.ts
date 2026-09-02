"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { twoFactorRecoveryCodes, users } from "@/db/schema";
import { getActiveSession } from "@/lib/auth/active-session";
import { verifyPassword } from "@/lib/auth/password";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/recovery-codes";
import {
  generateTotpSecret,
  totpQrDataUrl,
  totpUri,
  verifyTotpCode,
  verifyTotpCodeDelta,
} from "@/lib/auth/totp";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/totp-crypto";
import { checkTotpConfirmLimit, resetTotpConfirmLimit } from "@/lib/rate-limit";
import { valkey } from "@/lib/valkey";
import { recordAuditEvent } from "@/lib/audit";
import { log } from "@/lib/logger";
import { AppError, reportError, toActionError } from "@/lib/errors";
import { isNextRedirect } from "@/lib/next-redirect";

export type StartTotpSetupResult =
  | { ok: true; uri: string; qrDataUrl: string }
  | { ok: false; error: string };

export type ConfirmTotpState =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string };

export type DisableTotpState =
  | { ok: true }
  | { ok: false; field: "password" | "code" | "form"; error: string };

export type RegenerateState =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string };

const ALREADY_ENABLED_MESSAGE =
  "Two-factor authentication is already enabled.";
const NOT_ENABLED_MESSAGE = "Two-factor authentication is not enabled.";
const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again later.";
const NO_PENDING_SETUP_MESSAGE = "Start setup first.";
const INVALID_CODE_MESSAGE = "That code didn't match. Try again.";
const PASSWORD_MISMATCH_MESSAGE = "That password didn't match.";
const ENABLE_FIRST_MESSAGE = "Enable two-factor authentication first.";
const UNEXPECTED_ERROR_MESSAGE = "Something went wrong. Please try again.";

function authError(userMessage: string): AppError {
  return new AppError({ class: "auth", userMessage });
}

/**
 * Classifies an expected disable-flow failure while preserving WHERE the
 * settings UI shows it (password field, code field, or form). The message
 * is produced via toActionError so the AppError stays the single source of
 * the user-visible text.
 */
function fieldError(
  field: "password" | "code" | "form",
  error: AppError,
): DisableTotpState {
  return {
    ok: false,
    field,
    error: toActionError(error, { message: UNEXPECTED_ERROR_MESSAGE })
      .message,
  };
}

/**
 * Two-factor setup actions (PRD §8). The plaintext secret exists only in
 * memory inside these functions: it is stored encrypted via the ENG-27
 * at-rest encryption, is never logged, and is returned to the client once —
 * embedded in the otpauth:// URI of the start response (ENG-29 renders it
 * as the QR the user scans). Confirmation consumes the ENG-5-style fixed
 * window limiter BEFORE verification, so online guessing of the 6-digit
 * code is bounded to 5 tries per 15 minutes per user; success resets the
 * window and writes exactly one 2fa.enabled audit event with no secrets in
 * metadata. Confirmation also issues the batch of 8 one-time recovery
 * codes (PRD §5 "Recovery", ENG-31): only sha256 hashes are stored; the
 * plaintexts ride back in this single response, are shown once by the
 * client, and are never logged. Recovery login consumes them via the
 * ENG-31 challenge flow.
 */

/**
 * Disabling and regenerating (ENG-32, PRD §8 "disable or reconfigure
 * after appropriate identity verification"): both actions demand the
 * account password first — the user is already signed in, so the password
 * is the anti-hijack step that keeps an stolen tab from silently tearing
 * down 2FA — then verify either a current TOTP code or consume one unused
 * recovery code (same atomic conditional UPDATE as the ENG-31 login
 * flow). The limiter runs BEFORE verification so a stolen session cannot
 * brute-force either factor; wrong-password and wrong-code attempts burn
 * the same budget and are never audited (a failed management attempt
 * leaks nothing the audit log needs, and the settings UI shows the
 * matching field error). Success tears down EVERYTHING the enable flow
 * created — enabled flag, encrypted secret (the encryption key is the
 * only key, so NULLing the column destroys the secret), every recovery
 * row — and writes a single 2fa.disabled audit event. Regeneration
 * replaces the whole batch atomically-ish (delete-then-insert in one
 * request; no concurrent login can consume a deleted row) and writes
 * 2fa.recovery_codes_regenerated. Codes and secrets are never logged.
 */

export async function disableTotpAction(
  _prevState: DisableTotpState,
  formData: FormData,
): Promise<DisableTotpState> {
  try {
    return await runDisable(formData);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { ok: false, field: "form", error: message };
  }
}

async function runDisable(formData: FormData): Promise<DisableTotpState> {
  const session = await getActiveSession();

  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      totpEnabled: users.totpEnabled,
      totpSecretEncrypted: users.totpSecretEncrypted,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect("/login");
  }

  if (!user.totpEnabled) {
    return fieldError("form", authError(NOT_ENABLED_MESSAGE));
  }

  const gate = await checkTotpConfirmLimit(valkey, {
    userId: session.userId,
  });
  if (gate && !gate.allowed) {
    return fieldError("form", authError(TOO_MANY_ATTEMPTS_MESSAGE));
  }

  const password = formData.get("password");
  const passwordText = typeof password === "string" ? password : "";
  if (!(await verifyPassword(passwordText, user.passwordHash))) {
    return fieldError("password", authError(PASSWORD_MISMATCH_MESSAGE));
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
          eq(twoFactorRecoveryCodes.codeHash, hashRecoveryCode(codeText)),
          isNull(twoFactorRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: twoFactorRecoveryCodes.id });

    if (consumed.length === 0) {
      return fieldError("code", authError(INVALID_CODE_MESSAGE));
    }

    await recordAuditEvent(db, {
      actorUserId: session.userId,
      resourceType: "user",
      resourceId: session.userId,
      action: "2fa.recovery_used",
      metadata: {},
    });
  } else {
    if (!user.totpSecretEncrypted) {
      return fieldError("code", authError(INVALID_CODE_MESSAGE));
    }

    let secret: string;
    try {
      secret = decryptTotpSecret(user.totpSecretEncrypted);
    } catch {
      log("error", "2fa.disable_decrypt_failed", { userId: session.userId });
      return fieldError("code", authError(INVALID_CODE_MESSAGE));
    }

    if (!verifyTotpCodeDelta(secret, codeText).valid) {
      return fieldError("code", authError(INVALID_CODE_MESSAGE));
    }
  }

  await db
    .update(users)
    .set({ totpEnabled: false, totpSecretEncrypted: null })
    .where(eq(users.id, session.userId));

  await db
    .delete(twoFactorRecoveryCodes)
    .where(eq(twoFactorRecoveryCodes.userId, session.userId));

  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "2fa.disabled",
    metadata: {},
  });

  revalidatePath("/settings/security");

  return { ok: true };
}

export async function regenerateRecoveryCodesAction(
  _prevState: RegenerateState,
  formData: FormData,
): Promise<RegenerateState> {
  try {
    return await runRegenerate(formData);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { ok: false, error: message };
  }
}

async function runRegenerate(formData: FormData): Promise<RegenerateState> {
  const session = await getActiveSession();

  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      totpEnabled: users.totpEnabled,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  if (!user) {
    redirect("/login");
  }

  if (!user.totpEnabled) {
    throw authError(ENABLE_FIRST_MESSAGE);
  }

  const gate = await checkTotpConfirmLimit(valkey, {
    userId: session.userId,
  });
  if (gate && !gate.allowed) {
    throw authError(TOO_MANY_ATTEMPTS_MESSAGE);
  }

  const password = formData.get("password");
  const passwordText = typeof password === "string" ? password : "";
  if (!(await verifyPassword(passwordText, user.passwordHash))) {
    throw authError(PASSWORD_MISMATCH_MESSAGE);
  }

  // Old codes become unusable the moment the new batch replaces them: the
  // delete-then-insert runs in this single action, and the login consume
  // only matches rows that still exist.
  await db
    .delete(twoFactorRecoveryCodes)
    .where(eq(twoFactorRecoveryCodes.userId, session.userId));

  // One-time recovery codes (PRD §5 "Recovery"): only their hashes are
  // persisted; the plaintext batch travels to the client exactly once in
  // this response and is never logged (ENG-31).
  const recoveryCodes = generateRecoveryCodes();
  await db.insert(twoFactorRecoveryCodes).values(
    recoveryCodes.map((code) => ({
      userId: session.userId,
      codeHash: hashRecoveryCode(code),
    })),
  );

  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "2fa.recovery_codes_regenerated",
    metadata: {},
  });

  revalidatePath("/settings/security");

  return { ok: true, recoveryCodes };
}

export async function startTotpSetupAction(): Promise<StartTotpSetupResult> {
  try {
    return await runStartSetup();
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { ok: false, error: message };
  }
}

async function runStartSetup(): Promise<StartTotpSetupResult> {
  const session = await getActiveSession();

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
    throw authError(ALREADY_ENABLED_MESSAGE);
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
  try {
    return await runConfirmSetup(formData);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { ok: false, error: message };
  }
}

async function runConfirmSetup(formData: FormData): Promise<ConfirmTotpState> {
  const session = await getActiveSession();

  const gate = await checkTotpConfirmLimit(valkey, {
    userId: session.userId,
  });
  if (gate && !gate.allowed) {
    throw authError(TOO_MANY_ATTEMPTS_MESSAGE);
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
    throw authError(ALREADY_ENABLED_MESSAGE);
  }

  if (!user.totpSecretEncrypted) {
    throw authError(NO_PENDING_SETUP_MESSAGE);
  }

  let secret: string;
  try {
    secret = decryptTotpSecret(user.totpSecretEncrypted);
  } catch {
    log("error", "2fa.confirm_decrypt_failed", { userId: session.userId });
    throw authError(INVALID_CODE_MESSAGE);
  }

  const code = formData.get("code");
  const codeText = typeof code === "string" ? code : "";

  if (!verifyTotpCode(secret, codeText)) {
    throw authError(INVALID_CODE_MESSAGE);
  }

  await db
    .update(users)
    .set({ totpEnabled: true })
    .where(eq(users.id, session.userId));

  // One-time recovery codes (PRD §5 "Recovery"): only their hashes are
  // persisted; the plaintext batch travels to the client exactly once in
  // this response and is never logged (ENG-31).
  const recoveryCodes = generateRecoveryCodes();
  await db.insert(twoFactorRecoveryCodes).values(
    recoveryCodes.map((code) => ({
      userId: session.userId,
      codeHash: hashRecoveryCode(code),
    })),
  );

  await resetTotpConfirmLimit(valkey, { userId: session.userId });

  await recordAuditEvent(db, {
    actorUserId: session.userId,
    resourceType: "user",
    resourceId: session.userId,
    action: "2fa.enabled",
    metadata: {},
  });

  // No revalidatePath here: the route revalidation would unmount this
  // response's client component before the user sees the one-time recovery
  // codes. The setup UI calls router.refresh() after the codes are
  // acknowledged instead.

  return { ok: true, recoveryCodes };
}
