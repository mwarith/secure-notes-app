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
 * Server-only helpers for two-factor recovery codes (PRD §5 "Recovery",
 * §8). Each code is drawn from 10 random bytes (80 bits) via base32-style
 * 5-bit groupings over an unambiguous alphabet, formatted "xxxxx-xxxxx".
 * Codes are stored ONLY as hashes and are returned to the client exactly
 * once at 2FA activation (ENG-31); they are never logged.
 */

/**
 * Hashes a recovery code for storage/lookup: sha256 hex of the trimmed,
 * lowercased code. Argon2id (used for passwords in ENG-3) is deliberately
 * NOT used here: password hashing exists to make low-entropy human-chosen
 * secrets expensive to brute-force offline. A recovery code is 10 uniform
 * random characters (~49 bits over the 30-char alphabet) — offline
 * cracking is already infeasible, and the database is only reachable
 * behind the Argon2id-hashed password. sha256 gives a deterministic,
 * indexable hash (the login consume query matches on equality) with no
 * key-management or parameter-tuning surface, which is the right
 * trade-off for high-entropy random secrets.
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
