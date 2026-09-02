"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { login, logout } from "@/lib/auth/login";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { getClientIp } from "@/lib/client-ip";
import { AppError, reportError } from "@/lib/errors";
import { isNextRedirect } from "@/lib/next-redirect";
import {
  RATE_LIMITED_MESSAGE,
  checkLoginRateLimit,
  resetLoginRateLimit,
} from "@/lib/rate-limit";
import { valkey } from "@/lib/valkey";

export type LoginFormState =
  | { status: "idle" }
  | { status: "error"; message: string };

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const UNEXPECTED_ERROR_MESSAGE = "Something went wrong. Please try again.";

async function runLogin(formData: FormData): Promise<LoginFormState> {
  const ip = await getClientIp();
  const email = formData.get("email");

  const gate = await checkLoginRateLimit(valkey, { ip, email });
  if (gate && !gate.allowed) {
    await recordAuditEvent(db, {
      actorUserId: null,
      resourceType: null,
      resourceId: null,
      action: "login.rate_limited",
      metadata: { method: "password" },
    });
    throw new AppError({ class: "auth", userMessage: RATE_LIMITED_MESSAGE });
  }

  const result = await login({
    email,
    password: formData.get("password"),
  });

  if (!result.ok) {
    throw new AppError({
      class: "auth",
      userMessage: INVALID_CREDENTIALS_MESSAGE,
    });
  }

  await resetLoginRateLimit(valkey, { ip, email });

  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE_NAME,
    value: result.token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  redirect(result.pending2fa ? "/login/2fa" : "/");
}

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  try {
    return await runLogin(formData);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    const { message } = reportError(error, {
      message: UNEXPECTED_ERROR_MESSAGE,
    });
    return { status: "error", message };
  }
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  try {
    await logout(token);
  } catch {
    // Availability-first: a user leaving must never be trapped by a failed
    // teardown. Capture the operational failure and still clear the cookie.
    // The raw throw is deliberately not carried into the capture — the
    // operational classification is the capture's payload.
    reportError(
      new AppError({
        class: "operational",
        userMessage: UNEXPECTED_ERROR_MESSAGE,
      }),
      { message: UNEXPECTED_ERROR_MESSAGE },
    );
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}
