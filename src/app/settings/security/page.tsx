import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { TotpSetup } from "./totp-setup";

export const metadata: Metadata = {
  title: "Security — Secure Notes",
};

export default async function SecuritySettingsPage() {
  const cookieStore = await cookies();
  const session = await getSession(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
  );

  if (!session) {
    redirect("/login");
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

  const status = user.totpEnabled
    ? "enabled"
    : user.totpSecretEncrypted
      ? "pending"
      : "not set up";
  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">
            Secure Notes
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-12">
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Security</h1>

        <section className="mt-4 space-y-2">
          <p className="text-sm">
            Two-factor authentication adds a second step when you sign in.
            After entering your password, you enter a 6-digit code from an
            authenticator app (such as Google Authenticator) on your phone.
            Even if someone learns your password, they still can&apos;t get in
            without that code.
          </p>
          <p className="text-muted-foreground text-sm">
            To turn it on, connect an authenticator app by scanning a QR code,
            then verify a code from the app before activation. You&apos;ll be
            asked for a code at sign-in from then on.
          </p>
        </section>

        <section className="border-border/70 mt-6 rounded-xl border p-4 shadow-sm">
          {status === "enabled" ? (
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-5" aria-hidden />
              <div>
                <p className="font-medium">
                  Two-factor authentication is enabled
                </p>
                <p className="text-muted-foreground text-sm">
                  You&apos;ll be asked for an authentication code when you
                  sign in.
                </p>
              </div>
            </div>
          ) : (
            <>
              {status === "pending" && (
                <p className="text-muted-foreground mb-4 text-sm">
                  You started setup but haven&apos;t confirmed a code yet.
                  Scan the code and confirm to finish turning it on.
                </p>
              )}
              <TotpSetup />
            </>
          )}
        </section>
      </main>
    </div>
  );
}
