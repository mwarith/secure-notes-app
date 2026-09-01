import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("totp-crypto (integration)", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENCRYPTION_KEY", VALID_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a plaintext through encrypt/decrypt", async () => {
    const { decryptTotpSecret, encryptTotpSecret } = await import(
      "@/lib/auth/totp-crypto"
    );
    const plain = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

    const stored = encryptTotpSecret(plain);

    const segments = stored.split(":");
    expect(segments).toHaveLength(3);
    expect(Buffer.from(segments[0], "base64")).toHaveLength(12);
    expect(Buffer.from(segments[1], "base64")).toHaveLength(16);
    expect(decryptTotpSecret(stored)).toBe(plain);
  });

  it("throws when the stored value has been tampered with", async () => {
    const { decryptTotpSecret, encryptTotpSecret } = await import(
      "@/lib/auth/totp-crypto"
    );
    const stored = encryptTotpSecret("some secret");
    const [iv, tag, ciphertext] = stored.split(":");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] = flipped[0] ^ 0x01;

    expect(() =>
      decryptTotpSecret(`${iv}:${tag}:${flipped.toString("base64")}`),
    ).toThrow();
  });

  it("throws with a clear message when APP_ENCRYPTION_KEY is missing", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    const { encryptTotpSecret } = await import("@/lib/auth/totp-crypto");

    expect(() => encryptTotpSecret("secret")).toThrow(/APP_ENCRYPTION_KEY/i);
  });

  it("throws when APP_ENCRYPTION_KEY does not decode to 32 bytes", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    const { encryptTotpSecret } = await import("@/lib/auth/totp-crypto");

    expect(() => encryptTotpSecret("secret")).toThrow(/32 bytes/);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const { encryptTotpSecret } = await import("@/lib/auth/totp-crypto");
    const plain = "same plaintext";

    expect(encryptTotpSecret(plain)).not.toBe(encryptTotpSecret(plain));
  });
});
