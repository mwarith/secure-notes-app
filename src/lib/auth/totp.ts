import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";

const TOTP_ISSUER = "Secure Notes";
const TOTP_ALGORITHM = "SHA1";
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

/**
 * TOTP utilities for Google Authenticator–compatible 2FA (PRD §8). Secrets
 * are 20 random bytes (RFC 4226's recommended 160 bits) rendered as 32
 * unpadded Base32 chars. The otpauth:// URI carries both the issuer label
 * prefix and the issuer parameter — the pair GA recommends — with the
 * SHA1/6/30 defaults GA expects. Verification allows the ±1 time-step
 * window of RFC 6238 §5.2 (clock drift); anything outside it fails. Codes
 * are never logged. Replay protection (a code must not validate twice) is
 * the calling flow's responsibility (ENG-28).
 */

export function generateTotpSecret(): string {
  return new Secret({ size: SECRET_BYTES }).base32;
}

export function totpUri(secret: string, email: string): string {
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label: email,
    secret: Secret.fromBase32(secret),
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  });
  return totp.toString();
}

export function verifyTotpCode(secret: string, code: string): boolean {
  let totp: TOTP;
  try {
    totp = new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    });
  } catch {
    return false;
  }
  return totp.validate({ token: code, window: TOTP_WINDOW }) !== null;
}

export async function totpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri);
}
