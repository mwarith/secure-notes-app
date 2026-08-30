import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  hashSessionToken,
} from "@/lib/auth/session";

describe("createSessionToken", () => {
  it("returns a 43-character base64url token (256 bits of entropy)", () => {
    const token = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates a unique token on every call", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => createSessionToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("hashSessionToken", () => {
  it("returns a 64-character lowercase hex sha256 digest", () => {
    const digest = hashSessionToken(createSessionToken());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same token", () => {
    const token = createSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("differs for different tokens", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });
});
