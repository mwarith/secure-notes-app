import { createHash, randomBytes } from "node:crypto";

const RECOVERY_CODE_COUNT = 8;
const CODE_BYTES = 10;
const GROUP_LENGTH = 5;
const CODE_CHARACTERS = GROUP_LENGTH * 2;
// RFC 4648 base32 alphabet minus the visually ambiguous I and O (0 and 1
// never occur in base32, which only uses A-Z and 2-7), lowercased so users
// can type codes in any case — hashing normalizes before comparing.
const ALPHABET = "abcdefghjklmnpqrstuvwxyz234567";

/**
 * Server-only helpers for two-factor recovery codes. Each code is 10 random
 * bytes (~49 bits) over an unambiguous base32 alphabet, formatted
 * "xxxxx-xxxxx", stored ONLY as hashes, shown to the user exactly once at
 * 2FA activation, never logged.
 */

/**
 * sha256 of the trimmed, lowercased code. sha256 (not Argon2id) is
 * deliberate: the code is high-entropy random, so offline cracking is
 * already infeasible, and determinism keeps the login consume query a
 * simple indexed equality match.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

/**
 * Generates a fresh batch of RECOVERY_CODE_COUNT one-time codes, unique
 * within the batch. Every code carries ~49 bits of entropy (30-char
 * alphabet, 10 characters) drawn without modulo bias from 10 random
 * bytes: 5-bit base32-style chunks are rejected when they index past the
 * alphabet, so no character is overrepresented.
 */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(formatCode(randomCodeCharacters()));
  }
  return [...codes];
}

function formatCode(characters: string): string {
  return `${characters.slice(0, GROUP_LENGTH)}-${characters.slice(GROUP_LENGTH)}`;
}

function randomCodeCharacters(): string {
  let bytes = randomBytes(CODE_BYTES);
  let bitOffset = 0;
  let characters = "";
  while (characters.length < CODE_CHARACTERS) {
    if (bitOffset + 5 > bytes.length * 8) {
      bytes = randomBytes(CODE_BYTES);
      bitOffset = 0;
    }
    const byteIndex = Math.floor(bitOffset / 8);
    const shift = bitOffset % 8;
    const pair = (bytes[byteIndex] << 8) | bytes[byteIndex + 1];
    const chunk = (pair >> (11 - shift)) & 0b11111;
    bitOffset += 5;
    if (chunk >= ALPHABET.length) {
      continue;
    }
    characters += ALPHABET[chunk];
  }
  return characters;
}
