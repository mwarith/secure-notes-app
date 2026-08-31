"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { login, logout } from "@/lib/auth/login";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { getClientIp } from "@/lib/client-ip";
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

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
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
    return { status: "error", message: RATE_LIMITED_MESSAGE };
  }

  const result = await login({
    email,
    password: formData.get("password"),
  });

  if (!result.ok) {
    return { status: "error", message: INVALID_CREDENTIALS_MESSAGE };
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

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  await logout(token);
  cookieStore.delete(SESSION_COOKIE_NAME);
}
