import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  getSession,
  SESSION_COOKIE_NAME,
  type SessionData,
} from "./session";

/**
 * The central gate for every protected surface. A valid session that is
 * still mid-login (pendingTwoFactor) is redirected to the challenge route;
 * a missing session to /login; only a fully active session is returned.
 *
 * It delegates to getSession, so per-file test mocks of "@/lib/auth/session"
 * cascade through here naturally.
 */
export async function getActiveSession(): Promise<SessionData> {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  if (session.pendingTwoFactor) {
    redirect("/login/2fa");
  }

  return session;
}

/**
 * True for the errors redirect() throws. Production redirect errors carry a
 * NEXT_REDIRECT digest; the test harnesses' redirect mocks throw plain
 * Errors with the same marker in the message. Callers that wrap
 * getActiveSession in their own try/catch (outage UX, transient-save
 * failures) use this to re-throw redirects instead of swallowing them.
 */
export function isRedirectError(error: unknown): boolean {
  if (error && typeof error === "object" && "digest" in error) {
    const digest = (error as { digest: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return true;
    }
  }
  return error instanceof Error && error.message.startsWith("NEXT_REDIRECT");
}
