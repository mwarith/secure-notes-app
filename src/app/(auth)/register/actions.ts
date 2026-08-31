"use server";

import { db } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { getClientIp } from "@/lib/client-ip";
import {
  RATE_LIMITED_MESSAGE,
  checkRegisterRateLimit,
  refundRegistrationRateLimit,
} from "@/lib/rate-limit";
import { valkey } from "@/lib/valkey";
import {
  registerUser,
  type RegisterFailureReason,
} from "@/lib/auth/register";

export type RegisterFormState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "error"; message: string };

const ERROR_MESSAGES: Record<RegisterFailureReason, string> = {
  invalid_email: "Please enter a valid email address.",
  weak_password:
    "Password must be at least 12 characters and must not contain your email address.",
  duplicate_email:
    "Unable to create account with these details. If you already have an account, try signing in or resetting your password.",
};

export async function registerAction(
  _prevState: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  const ip = await getClientIp();

  const gate = await checkRegisterRateLimit(valkey, { ip });
  if (gate && !gate.allowed) {
    await recordAuditEvent(db, {
      actorUserId: null,
      resourceType: null,
      resourceId: null,
      action: "register.rate_limited",
      metadata: { method: "password" },
    });
    return { status: "error", message: RATE_LIMITED_MESSAGE };
  }

  const result = await registerUser({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (result.ok) {
    return { status: "success" };
  }

  if (
    result.reason === "invalid_email" ||
    result.reason === "weak_password"
  ) {
    await refundRegistrationRateLimit(valkey, { ip });
  }

  return { status: "error", message: ERROR_MESSAGES[result.reason] };
}
