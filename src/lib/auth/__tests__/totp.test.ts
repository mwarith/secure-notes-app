import { describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";

const FIXED_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const EMAIL = "user@example.com";

describe("totp (integration)", () => {
  it("generates 20-byte secrets as 32 unpadded base32 chars", async () => {
    const { generateTotpSecret } = await import("@/lib/auth/totp");

    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it("verifies the current code and rejects a wrong code", async () => {
    const { verifyTotpCode } = await import("@/lib/auth/totp");
    const totp = new TOTP({
      secret: Secret.fromBase32(FIXED_SECRET),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });

    const current = totp.generate();
    expect(verifyTotpCode(FIXED_SECRET, current)).toBe(true);

    const nearby = new Set(
      [-1, 0, 1].map((delta) =>
        totp.generate({ timestamp: Date.now() + delta * 30_000 }),
      ),
    );
    let wrongCode = "";
    for (let i = 0; i < 1_000_000; i += 1) {
      const candidate = i.toString().padStart(6, "0");
      if (!nearby.has(candidate)) {
        wrongCode = candidate;
        break;
      }
    }
    expect(verifyTotpCode(FIXED_SECRET, wrongCode)).toBe(false);
  });

  it("accepts a code from one time step away (window ±1)", async () => {
    const { verifyTotpCode } = await import("@/lib/auth/totp");
    const totp = new TOTP({
      secret: Secret.fromBase32(FIXED_SECRET),
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });

    const previousStepCode = totp.generate({ timestamp: Date.now() - 30_000 });

    expect(verifyTotpCode(FIXED_SECRET, previousStepCode)).toBe(true);
  });

  it("builds a GA-compatible otpauth:// URI with issuer, label, and secret", async () => {
    const { totpUri } = await import("@/lib/auth/totp");

    const uri = totpUri(FIXED_SECRET, EMAIL);

    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${FIXED_SECRET}`);
    expect(uri).toContain("issuer=Secure");
    expect(uri).toContain("user%40example.com");
  });

  it("renders the URI as a PNG data URL", async () => {
    const { totpQrDataUrl, totpUri } = await import("@/lib/auth/totp");

    const dataUrl = await totpQrDataUrl(totpUri(FIXED_SECRET, EMAIL));

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});
