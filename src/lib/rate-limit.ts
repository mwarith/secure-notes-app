import { createHash } from "node:crypto";
import { isValidEmail, normalizeEmail } from "./auth/validation";

/**
 * Valkey-backed fixed-window rate limiting for the auth endpoints.
 *
 * Login: 5 failed attempts / 15 min per IP+email, reset on success.
 * Registration: 5 attempts / hour per IP (IP-only so rotating emails cannot
 * evade the bucket); rejected-by-validation attempts are refunded.
 * TOTP confirmation: 5 / 15 min per user, FAIL-CLOSED — it is the only
 * throttle on a 6-digit code; login and registration fail OPEN so a Valkey
 * outage cannot block the core journey.
 *
 * Keys are SHA-256 hashes, so raw emails/IPs never appear in Valkey. The
 * fixed window can admit up to 2x the limit across a boundary — an accepted
 * trade-off at these rates. Fail-open degradations log loudly.
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

export const TOTP_CONFIRM_RATE_LIMIT: RateLimitConfig = {
  limit: 5,
  windowSeconds: 15 * 60,
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

export function totpConfirmRateLimitKey(userId: string): string {
  return `rl:totp-confirm:v1:${sha256(userId)}`;
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
    `[rate-limit] valkey unavailable while limiting ${flow} - failing open (rate limiting disabled): ${message}`,
  );
}

function logFailClosed(flow: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[rate-limit] valkey unavailable while limiting ${flow} - failing closed (verification blocked): ${message}`,
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

export async function checkTotpConfirmLimit(
  store: RateLimitStore,
  input: { userId: string },
  config: RateLimitConfig = TOTP_CONFIRM_RATE_LIMIT,
): Promise<RateLimitGate> {
  try {
    return await consumeRateLimit(
      store,
      totpConfirmRateLimitKey(input.userId),
      config,
    );
  } catch (error) {
    // Fail CLOSED: see the module doc — this limiter guards 6-digit codes.
    logFailClosed("totp confirmation", error);
    return {
      allowed: false,
      retryAfterSeconds: config.windowSeconds,
    };
  }
}

export async function resetTotpConfirmLimit(
  store: RateLimitStore,
  input: { userId: string },
): Promise<void> {
  try {
    await resetRateLimit(store, totpConfirmRateLimitKey(input.userId));
  } catch (error) {
    logFailOpen("totp confirmation", error);
  }
}
