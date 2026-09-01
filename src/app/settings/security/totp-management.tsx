"use client";

import { useRouter } from "next/navigation";
import { useEffect, useActionState, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  disableTotpAction,
  regenerateRecoveryCodesAction,
  type DisableTotpState,
  type RegenerateState,
} from "./actions";

const initialDisableState: DisableTotpState = {
  ok: false,
  field: "form",
  error: "",
};
const initialRegenerateState: RegenerateState = { ok: false, error: "" };

const RECOVERY_CODES_WARNING =
  "Save these codes now — they are shown only once and are your only way to sign in if you lose your device.";

/**
 * The enabled-state management section (ENG-32, PRD §8 "disable or
 * reconfigure two-factor authentication after appropriate identity
 * verification"). Both sub-flows demand the account password alongside
 * the second factor. Regenerated codes render exactly once and are
 * dismissed through the same acknowledgment gate as the activation batch
 * (ENG-31); the refresh afterwards re-renders the server card with the
 * new batch in place. Disabling lives behind a confirmation dialog; its
 * field-tagged errors render next to the offending input so the user can
 * fix the right factor, and success refreshes so the server flips this
 * card back to the not-set-up state. Plaintext codes and passwords are
 * never logged.
 */

export function TotpManagement() {
  const router = useRouter();

  const [
    regenerateState,
    regenerateFormAction,
    isRegenerating,
  ] = useActionState(regenerateRecoveryCodesAction, initialRegenerateState);
  const [regeneratedSaved, setRegeneratedSaved] = useState(false);
  const [regeneratedAcknowledged, setRegeneratedAcknowledged] = useState(false);

  const [disableState, disableFormAction, isDisabling] = useActionState(
    disableTotpAction,
    initialDisableState,
  );
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const isRecovery = mode === "recovery";

  useEffect(() => {
    if (disableState.ok) {
      router.refresh();
    }
  }, [disableState, router]);

  const passwordError =
    disableState.ok === false && disableState.field === "password"
      ? disableState.error
      : null;
  const codeError =
    disableState.ok === false && disableState.field === "code"
      ? disableState.error
      : null;
  const formError =
    disableState.ok === false && disableState.field === "form"
      ? disableState.error
      : null;

  return (
    <div className="border-border/70 mt-4 space-y-6 border-t pt-4">
      <section className="space-y-3">
        <h3 className="font-medium">Recovery codes</h3>
        <p className="text-muted-foreground text-sm">
          Lost your codes or used some up? Generate a new set — the old ones
          stop working immediately.
        </p>
        {regenerateState.ok ? (
          regeneratedSaved ? null : (
            <div className="space-y-3">
              <Alert>
                <AlertTitle>{RECOVERY_CODES_WARNING}</AlertTitle>
              </Alert>
              <ul className="space-y-1 font-mono text-sm">
                {regenerateState.recoveryCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <input
                  id="regenerated-codes-saved"
                  type="checkbox"
                  checked={regeneratedAcknowledged}
                  onChange={(event) =>
                    setRegeneratedAcknowledged(event.target.checked)
                  }
                />
                <Label htmlFor="regenerated-codes-saved">
                  I&apos;ve saved these codes somewhere safe
                </Label>
              </div>
              <Button
                type="button"
                disabled={!regeneratedAcknowledged}
                onClick={() => {
                  setRegeneratedSaved(true);
                  router.refresh();
                }}
              >
                I&apos;ve saved them
              </Button>
            </div>
          )
        ) : (
          <form action={regenerateFormAction} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="regenerate-password">Password</Label>
              <Input
                id="regenerate-password"
                name="password"
                type="password"
                autoComplete="current-password"
                disabled={isRegenerating}
                required
              />
              {regenerateState.ok === false &&
                regenerateState.error !== "" && (
                  <p className="text-destructive text-sm">
                    {regenerateState.error}
                  </p>
                )}
            </div>
            <Button type="submit" disabled={isRegenerating}>
              {isRegenerating ? "Regenerating…" : "Regenerate codes"}
            </Button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-medium">Turn off two-factor authentication</h3>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              Disable two-factor authentication
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Disable two-factor authentication?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Your authenticator app and recovery codes will stop working,
                and sign-in will only require your password. You can turn
                two-factor authentication back on afterwards.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <form action={disableFormAction} className="space-y-3">
              <input type="hidden" name="mode" value={mode} />
              {formError && (
                <p className="text-destructive text-sm">{formError}</p>
              )}
              <div className="space-y-2">
                <Label htmlFor="disable-password">Password</Label>
                <Input
                  id="disable-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  disabled={isDisabling}
                  required
                />
                {passwordError && (
                  <p className="text-destructive text-sm">{passwordError}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="disable-code">
                  {isRecovery ? "Recovery code" : "Authentication code"}
                </Label>
                <Input
                  id="disable-code"
                  name="code"
                  autoComplete={isRecovery ? "off" : "one-time-code"}
                  inputMode={isRecovery ? "text" : "numeric"}
                  maxLength={isRecovery ? undefined : 6}
                  placeholder={isRecovery ? "xxxxx-xxxxx" : undefined}
                  disabled={isDisabling}
                  required
                />
                <button
                  type="button"
                  onClick={() => setMode(isRecovery ? "totp" : "recovery")}
                  className="text-muted-foreground hover:underline"
                  disabled={isDisabling}
                >
                  {isRecovery
                    ? "Use an authenticator code instead"
                    : "Use a recovery code instead"}
                </button>
                {codeError && (
                  <p className="text-destructive text-sm">{codeError}</p>
                )}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isDisabling}>
                  Cancel
                </AlertDialogCancel>
                <Button type="submit" variant="destructive" disabled={isDisabling}>
                  {isDisabling ? "Disabling…" : "Disable"}
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  );
}
