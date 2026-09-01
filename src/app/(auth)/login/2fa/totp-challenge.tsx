"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  verifyTotpChallengeAction,
  type ChallengeState,
} from "./actions";

const initialState: ChallengeState = { ok: false, error: "not-started" };

export function TotpChallenge() {
  const [state, formAction, pending] = useActionState(
    verifyTotpChallengeAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.ok === false && state.error !== "" && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="totp-code">Authentication code</Label>
        <Input
          id="totp-code"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          disabled={pending}
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Verifying…" : "Confirm"}
      </Button>
    </form>
  );
}
