import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Server-only at-rest encryption for TOTP secrets (AES-256-GCM). The key
 * comes from APP_ENCRYPTION_KEY as base64 and is validated at first use —
 * a missing key or one that does not decode to exactly 32 bytes throws a
 * clear error rather than producing a silently weak key, since Buffer's
 * base64 decoding is lenient. Each encryption draws a fresh random 12-byte
 * IV (the 96-bit length NIST SP 800-38D §8.2.1 recommends for GCM) and
 * stores "iv:tag:ciphertext" as three base64 segments joined by ':'; the
 * 128-bit auth tag travels with the ciphertext so tampering fails
 * authentication on decrypt. Secrets and keys are never logged. Key
 * rotation is out of scope (ENG-32).
 */

function loadKey(): Buffer {
  const encoded = process.env.APP_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set; generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes for AES-256-GCM (got ${key.length}); generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

export function encryptTotpSecret(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((segment) => segment.toString("base64"))
    .join(":");
}

export function decryptTotpSecret(stored: string): string {
  const segments = stored.split(":");
  if (segments.length !== 3) {
    throw new Error(
      'Malformed encrypted value: expected "iv:tag:ciphertext" base64 segments',
    );
  }
  const [ivText, tagText, ciphertextText] = segments;
  const iv = Buffer.from(ivText, "base64");
  const tag = Buffer.from(tagText, "base64");
  const ciphertext = Buffer.from(ciphertextText, "base64");
  const key = loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
