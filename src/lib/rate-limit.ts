import { createHash } from "node:crypto";
import { isValidEmail, normalizeEmail } from "./auth/validation";

/**
 * Valkey-backed fixed-window rate limiting for the authentication endpoints
 * (PRD §15 "repeated authentication abuse can be controlled").
 *
 * Design decisions (deliberate, documented trade-offs):
 *
 * - Thresholds: 5 failed login attempts per 15 minutes per IP+email, and 5
 *   registration attempts per hour per IP. A legitimate user who mistypes
 *   their password rarely needs more than 3 tries before recovering, so 5
 *   gives headroom while 5 tries/15min keeps online guessing pointless
 *   against Argon2id-hashed 12+ character passwords. Registration is keyed by
 *   IP only because an attacker rotating emails would trivially evade an
 *   email-scoped bucket; 5/hour is far above any human pattern.
 *
 * - Fixed window, not sliding: the counter is INCR'd and the TTL is set once
 *   when the key is first created (never refreshed), so the window is a
 *   fixed wall-clock slice. This costs two cheap commands instead of the
 *   sorted-set bookkeeping a sliding window needs. The known trade-offs are
 *   accepted: a burst spanning a window boundary can admit up to 2x the
 *   limit, and a perfectly paced attacker gets 5 guesses per window — both
 *   irrelevant at this rate against the password policy.
 *
 * - Fail-open on Valkey unavailability for BOTH login and registration
 *   (PRD §17 vs §15 resolution): PRD §4 lists account creation as step 1 of
 *   the core user journey, and §17 says supporting services must not become
 *   single points of failure for core functionality. Valkey is a supporting
 *   service, so a transient outage must not block login or registration.
 *   The cost is accepted: while Valkey is down there is no rate-limit
 *   protection on either endpoint. The degradation is logged loudly via
 *   console.error on every failure so operators can see rate limiting is
 *   disabled and mitigate manually during prolonged outages. Note that a
 *   production system facing targeted adversarial abuse might fail closed
 *   for registration specifically (spam rows are durable); for this
 *   project's scope and threat model, availability of the core
 *   account-creation journey wins.
 *
 * - Keys are SHA-256 hashes of "ip|email" (or "ip"), so raw emails and IPs
 *   never appear in Valkey keys — keeping with PRD §15's requirement that
 *   sensitive information stay out of logs/inspection surfaces.
 *
 * - Counter semantics per flow: login consumes (INCRs) BEFORE processing and
 *   resets (DELs) on success, so the counter holds failed attempts and a
 *   successful login always gives the user a clean slate. Registration also
 *   consumes before processing, but refunds (DECRs) when the submission was
 *   rejected by local validation (invalid email / weak password) so typo
 *   retries never burn the budget; only outcomes that reach the database
 *   (created or duplicate) keep their slot. Admission itself stays atomic:
 *   the INCR decides the limit before any DB work happens.
 */

export interface RateLimitStore {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

export type RateLimitConfig = { limit: number; windowSeconds: number };

export const LOGIN_RATE_LIMIT: RateLimitConfig = {
  limit: 5,
  windowSeconds: 15 * 60,
};

export const REGISTER_RATE_LIMIT: RateLimitConfig = {
  limit: 5,
  windowSeconds: 60 * 60,
};

export const RATE_LIMITED_MESSAGE = "Too many attempts. Please try again later.";

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Null means enforcement was unavailable (fail-open): the request proceeds
 * without rate limiting and the degradation has been logged.
 */
export type RateLimitGate = RateLimitResult | null;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function loginRateLimitKey(ip: string, email: unknown): string {
  const normalized = normalizeEmail(email);
  const bucket =
    normalized && isValidEmail(normalized) ? normalized : "invalid";
  return `rl:login:v1:${sha256(`${ip}|${bucket}`)}`;
}

export function registerRateLimitKey(ip: string): string {
  return `rl:register:v1:${sha256(ip)}`;
}

export async function consumeRateLimit(
  store: RateLimitStore,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const count = await store.incr(key);
  let ttlMilliseconds = await store.pttl(key);

  if (ttlMilliseconds < 0) {
    // Fresh key (or a TTL lost mid-flight): establish the fixed window.
    ttlMilliseconds = config.windowSeconds * 1000;
    await store.pexpire(key, ttlMilliseconds);
  }

  if (count > config.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(ttlMilliseconds / 1000),
    };
  }

  return { allowed: true, remaining: Math.max(0, config.limit - count) };
}

export async function refundRateLimit(
  store: RateLimitStore,
  key: string,
): Promise<void> {
  await store.decr(key);
}

export async function resetRateLimit(
  store: RateLimitStore,
  key: string,
): Promise<void> {
  await store.del(key);
}

function logFailOpen(flow: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[rate-limit] valkey unavailable while limiting ${flow} — failing open (rate limiting disabled): ${message}`,
  );
}

export async function checkLoginRateLimit(
  store: RateLimitStore,
  input: { ip: string; email: unknown },
  config: RateLimitConfig = LOGIN_RATE_LIMIT,
): Promise<RateLimitGate> {
  try {
    return await consumeRateLimit(
      store,
      loginRateLimitKey(input.ip, input.email),
      config,
    );
  } catch (error) {
    logFailOpen("login", error);
    return null;
  }
}

export async function checkRegisterRateLimit(
  store: RateLimitStore,
  input: { ip: string },
  config: RateLimitConfig = REGISTER_RATE_LIMIT,
): Promise<RateLimitGate> {
  try {
    return await consumeRateLimit(
      store,
      registerRateLimitKey(input.ip),
      config,
    );
  } catch (error) {
    logFailOpen("registration", error);
    return null;
  }
}

export async function refundRegistrationRateLimit(
  store: RateLimitStore,
  input: { ip: string },
): Promise<void> {
  try {
    await refundRateLimit(store, registerRateLimitKey(input.ip));
  } catch (error) {
    logFailOpen("registration", error);
  }
}

export async function resetLoginRateLimit(
  store: RateLimitStore,
  input: { ip: string; email: unknown },
): Promise<void> {
  try {
    await resetRateLimit(store, loginRateLimitKey(input.ip, input.email));
  } catch (error) {
    logFailOpen("login", error);
  }
}
