import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { logoutAction } from "../actions";
import { TotpChallenge } from "./totp-challenge";

export const metadata: Metadata = {
  title: "Two-factor authentication — Secure Notes",
};

export default async function TwoFactorChallengePage() {
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

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TotpChallenge />
          <form action={logoutAction} className="mt-4">
            <Button type="submit" variant="ghost" className="w-full">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
