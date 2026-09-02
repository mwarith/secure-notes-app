import jsQR from "jsqr";
import { PNG } from "pngjs";
import { Secret, TOTP, URI } from "otpauth";
import type { Page } from "@playwright/test";

const QR_IMAGE_ALT = "Scan this QR code with your authenticator app";
const TOTP_PERIOD_SECONDS = 30;
const CODE_STEAL_MARGIN_SECONDS = 3;

/**
 * Reads the TOTP secret the setup UI exposes as its QR image: the img's
 * data URL is decoded exactly like an authenticator app would scan it, and
 * the otpauth:// URI inside yields the secret. No codes are ever hardcoded.
 */
export async function readSecretFromQr(page: Page): Promise<string> {
  const dataUrl = await page
    .getByAltText(QR_IMAGE_ALT)
    .getAttribute("src");
  if (dataUrl === null) {
    throw new Error("the setup UI did not show the QR image");
  }

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const png = PNG.sync.read(Buffer.from(base64, "base64"));
  const decoded = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  );
  if (decoded === null) {
    throw new Error("could not decode the QR image");
  }

  const parsed = URI.parse(decoded.data);
  if (!(parsed instanceof TOTP)) {
    throw new Error("the QR did not contain a TOTP URI");
  }
  return parsed.secret.base32;
}

/**
 * Generates the current 6-digit code at assertion time. If the window is
 * about to roll, waits past the boundary first so the code is verifiable
 * for the whole round-trip that follows.
 */
export async function freshTotpCode(
  page: Page,
  secretBase32: string,
): Promise<string> {
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  const elapsed = Math.floor(Date.now() / 1000) % TOTP_PERIOD_SECONDS;
  const remaining = TOTP_PERIOD_SECONDS - elapsed;
  if (remaining < CODE_STEAL_MARGIN_SECONDS) {
    await page.waitForTimeout((remaining + 0.25) * 1000);
  }
  return totp.generate();
}

/**
 * A 6-digit code that the verifier's ±1 window cannot accept: everything
 * at or adjacent to the current step is excluded by construction.
 */
export function wrongTotpCode(secretBase32: string): string {
  const totp = new TOTP({ secret: Secret.fromBase32(secretBase32) });
  const now = Date.now();
  const nearby = new Set([
    totp.generate({ timestamp: now }),
    totp.generate({ timestamp: now - 30_000 }),
    totp.generate({ timestamp: now + 30_000 }),
  ]);
  for (let i = 0; i < 1_000_000; i += 1) {
    const candidate = i.toString().padStart(6, "0");
    if (!nearby.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("no wrong code found");
}
