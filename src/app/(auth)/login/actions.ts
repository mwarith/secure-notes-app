"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { login, logout } from "@/lib/auth/login";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@/lib/auth/session";

export type LoginFormState =
  | { status: "idle" }
  | { status: "error"; message: string };

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const result = await login({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!result.ok) {
    return { status: "error", message: INVALID_CREDENTIALS_MESSAGE };
  }

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
