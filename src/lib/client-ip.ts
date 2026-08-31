import { headers } from "next/headers";

/**
 * Best-effort client IP for rate limiting from a server action.
 *
 * Trust caveat: these proxy headers are only meaningful when the app runs
 * behind a trusted reverse proxy that sets them. A directly exposed app can
 * have them spoofed by the client, which would let an attacker rotate
 * apparent IPs to evade IP-scoped limits (the email-scoped login bucket
 * still applies). Documented limitation for this project's demo scale;
 * a production deployment must derive the IP from the trusted proxy layer.
 *
 * When no proxy headers are present (local development), every request
 * collapses into the shared "unknown" bucket, which the fixed windows are
 * sized to tolerate.
 */
export async function getClientIp(): Promise<string> {
  const headerList = await headers();

  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = headerList.get("x-real-ip");
  if (realIp && realIp.trim()) {
    return realIp.trim();
  }

  return "unknown";
}
