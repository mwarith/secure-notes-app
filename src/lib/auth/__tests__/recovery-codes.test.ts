import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/recovery-codes";

// The alphabet strips the visually ambiguous 0/O and 1/I (base32 never
// emits 0/1/8/9; I and O are removed from the letters).
const CODE_FORMAT = /^[abcdefghjklmnpqrstuvwxyz234567]{5}-[abcdefghjklmnpqrstuvwxyz234567]{5}$/;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("generateRecoveryCodes", () => {
  it("returns exactly 8 codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
  });

  it("formats every code as unambiguous base32 in xxxxx-xxxxx groups", () => {
    const codes = generateRecoveryCodes();
    for (const code of codes) {
      expect(code).toMatch(CODE_FORMAT);
    }
  });

  it("never repeats a code within a batch", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("draws fresh randomness on every call", () => {
    const first = generateRecoveryCodes();
    const second = generateRecoveryCodes();
    expect(first).not.toEqual(second);
  });
});

describe("hashRecoveryCode", () => {
  it("is the sha256 hex of the trimmed, lowercased code", () => {
    expect(hashRecoveryCode("abcde-fghij")).toBe(
      sha256Hex("abcde-fghij"),
    );
  });

  it("is deterministic across case and surrounding whitespace", () => {
    const plain = "abcde-fghij";
    expect(hashRecoveryCode("  ABCDE-FGHIJ  ")).toBe(
      hashRecoveryCode(plain),
    );
    expect(hashRecoveryCode("AbCdE-FgHiJ")).toBe(hashRecoveryCode(plain));
  });

  it("hashes different codes differently", () => {
    expect(hashRecoveryCode("abcde-fghij")).not.toBe(
      hashRecoveryCode("abcde-fghjk"),
    );
  });

  it("never leaks the plaintext into the hash output", () => {
    const code = "zzzzz-zzzzz";
    const hash = hashRecoveryCode(code);
    expect(hash).not.toContain(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
