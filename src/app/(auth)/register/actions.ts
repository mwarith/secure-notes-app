"use server";

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
  const result = await registerUser({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (result.ok) {
    return { status: "success" };
  }
  return { status: "error", message: ERROR_MESSAGES[result.reason] };
}
