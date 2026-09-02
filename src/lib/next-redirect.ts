/**
 * Detects the control-flow error Next.js throws to perform a redirect
 * (redirect()/permanentRedirect(); see
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md).
 *
 * Real redirect errors carry a "NEXT_REDIRECT;…" digest — the same signal
 * Next's own isRedirectError checks. The message-prefix fallback also
 * recognizes test doubles that emulate redirects with a plain
 * "NEXT_REDIRECT:…" Error; genuine infrastructure failures never begin with
 * that marker, so real errors are never mistaken for redirects.
 *
 * Auth actions wrap their body in try/catch to classify failures; this
 * predicate lets a redirect escape that catch so navigation keeps working.
 */
export function isNextRedirect(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "digest" in error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return true;
    }
  }
  return error instanceof Error && error.message.startsWith("NEXT_REDIRECT");
}
