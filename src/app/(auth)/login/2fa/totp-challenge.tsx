"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  verifyTotpChallengeAction,
  type ChallengeState,
} from "./actions";

const initialState: ChallengeState = { ok: false, error: "not-started" };

/**
 * Two-factor challenge form (PRD §8). The user answers either with a
 * 6-digit authenticator code or — via the toggle — with one of the
 * one-time recovery codes issued at activation (ENG-31). The chosen mode
 * rides the form as a hidden input; error messages are identical in both
 * modes so the response never leaks which kind of code was attempted.
 */

export function TotpChallenge() {
  const [state, formAction, pending] = useActionState(
    verifyTotpChallengeAction,
    initialState,
  );
  const [mode, setMode] = useState<"totp" | "recovery">("totp");
  const isRecovery = mode === "recovery";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      {state.ok === false && state.error !== "" && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="totp-code">
          {isRecovery ? "Recovery code" : "Authentication code"}
        </Label>
        <Input
          id="totp-code"
          name="code"
          autoComplete={isRecovery ? "off" : "one-time-code"}
          inputMode={isRecovery ? "text" : "numeric"}
          maxLength={isRecovery ? undefined : 6}
          placeholder={isRecovery ? "xxxxx-xxxxx" : undefined}
          disabled={pending}
          required
        />
        <button
          type="button"
          onClick={() => setMode(isRecovery ? "totp" : "recovery")}
          className="text-muted-foreground hover:underline"
          disabled={pending}
        >
          {isRecovery
            ? "Use an authenticator code instead"
            : "Use a recovery code instead"}
        </button>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Verifying…" : "Confirm"}
      </Button>
    </form>
  );
}
