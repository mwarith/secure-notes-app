"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  confirmTotpSetupAction,
  startTotpSetupAction,
  type ConfirmTotpState,
} from "./actions";

const initialState: ConfirmTotpState = { ok: false, error: "" };

/**
 * Enable flow for two-factor authentication (PRD §8). Start generates a
 * fresh secret server-side and returns the otpauth:// URI as a QR data URL;
 * the QR step renders once per start, and "I need a new code" re-runs
 * start, replacing the pending secret (the backend already handles that).
 * Confirm verifies the 6-digit code through the rate-limited action; the
 * action's one-time-code input is never logged. On success the one-time
 * recovery codes (ENG-31) are rendered exactly once — dismissing the list
 * is purely client-side, the server keeps only their hashes.
 */

export function TotpSetup() {
  const router = useRouter();
  const [isStarting, startTransition] = useTransition();
  const [startError, setStartError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  const [savedAcknowledged, setSavedAcknowledged] = useState(false);
  const [state, formAction, isConfirming] = useActionState(
    confirmTotpSetupAction,
    initialState,
  );

  function handleStart() {
    setStartError(null);
    startTransition(async () => {
      try {
        const result = await startTotpSetupAction();
        if (!result.ok) {
          setStartError(result.error);
          return;
        }
        setQrDataUrl(result.qrDataUrl);
      } catch {
        setStartError("Couldn't start setup right now. Please try again.");
      }
    });
  }

  if (state.ok) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="font-medium">
            Two-factor authentication is now enabled.
          </p>
          <p className="text-muted-foreground text-sm">
            You&apos;ll be asked for an authentication code when you sign in.
          </p>
        </div>
        {!codesSaved && (
          <div className="space-y-3">
            <Alert>
              <AlertTitle>
                Save these codes now — they are shown only once and are your
                only way to sign in if you lose your device.
              </AlertTitle>
            </Alert>
            <ul className="space-y-1 font-mono text-sm">
              {state.recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <div className="flex items-center gap-2">
              <input
                id="recovery-codes-saved"
                type="checkbox"
                checked={savedAcknowledged}
                onChange={(event) => setSavedAcknowledged(event.target.checked)}
              />
              <Label htmlFor="recovery-codes-saved">
                I&apos;ve saved these codes somewhere safe
              </Label>
            </div>
            <Button
              type="button"
              disabled={!savedAcknowledged}
              onClick={() => {
                // Codes acknowledged — only now is it safe to let the
                // server re-render flip this card to the enabled state.
                setCodesSaved(true);
                router.refresh();
              }}
            >
              I&apos;ve saved them
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!qrDataUrl) {
    return (
      <div className="space-y-3">
        <Button type="button" onClick={handleStart} disabled={isStarting}>
          {isStarting ? "Starting…" : "Enable two-factor authentication"}
        </Button>
        {startError && (
          <p className="text-destructive text-sm">{startError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-start">
        {/* The QR step renders once per start; a new start regenerates the
            pending secret, which the backend already replaces. next/image
            cannot optimize a base64 data URL, so the plain img is correct
            here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrDataUrl}
          alt="Scan this QR code with your authenticator app"
          className="size-44 rounded-lg border"
        />
        <div className="space-y-2">
          <p className="text-sm">
            Scan this QR code with your authenticator app, then enter the
            6-digit code it shows.
          </p>
          <button
            type="button"
            onClick={handleStart}
            className="hover:underline"
            disabled={isStarting}
          >
            I need a new code
          </button>
        </div>
      </div>
      <form action={formAction} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="totp-code">Authentication code</Label>
          <Input
            id="totp-code"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            disabled={isConfirming}
            required
          />
        </div>
        {state.ok === false && state.error !== "" && (
          <p className="text-destructive text-sm">{state.error}</p>
        )}
        <Button type="submit" disabled={isConfirming}>
          {isConfirming ? "Confirming…" : "Confirm"}
        </Button>
      </form>
    </div>
  );
}
