import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail, validatePassword } from "@/lib/auth/validation";

describe("normalizeEmail", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
  });

  it("returns null for empty or non-string input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe("isValidEmail", () => {
  it.each([
    "user@example.com",
    "user.name+tag@sub.example.co.uk",
    "USER@EXAMPLE.COM",
    "a@b.co",
  ])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    "no-at-sign",
    "missing-tld@",
    "@missing-local.org",
    "two@@at-signs.com",
    "space in@example.com",
    "user@-leading-hyphen.com",
    "user@example..com",
    `${"a".repeat(65)}@example.com`,
  ])("rejects %s", (email) => {
    expect(isValidEmail(email)).toBe(false);
  });

  it("rejects addresses longer than 254 characters", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(isValidEmail(`${local}@${domain}`)).toBe(false);
  });
});

describe("validatePassword", () => {
  const email = "user@example.com";

  it("accepts a password of exactly 12 characters", () => {
    expect(validatePassword("abcdefghijkl")).toBe(true);
  });

  it("accepts a password of exactly 128 characters", () => {
    expect(validatePassword("x".repeat(128))).toBe(true);
  });

  it("rejects a password of 11 characters", () => {
    expect(validatePassword("abcdefghijk")).toBe(false);
  });

  it("rejects a password longer than 128 characters", () => {
    expect(validatePassword("x".repeat(129))).toBe(false);
  });

  it("rejects empty and non-string input", () => {
    expect(validatePassword("")).toBe(false);
    expect(validatePassword(undefined)).toBe(false);
    expect(validatePassword(null)).toBe(false);
    expect(validatePassword(123)).toBe(false);
  });

  it("rejects a password containing the signup email, case-insensitively", () => {
    expect(validatePassword("MySecretPassword user@example.com", email)).toBe(
      false,
    );
    expect(validatePassword("MySecretPassword USER@EXAMPLE.COM", email)).toBe(
      false,
    );
  });

  it("accepts a strong passphrase unrelated to the email", () => {
    expect(validatePassword("correct horse battery staple", email)).toBe(true);
  });
});
