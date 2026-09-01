import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { users } from "@/db/schema";
import { verifyCredentials } from "@/lib/auth/login";
import { resolveTestDatabaseUrl } from "../../../../vitest.helpers";

vi.mock("@node-rs/argon2", () => ({
  hash: vi.fn(
    async () => "$argon2id$v=19$m=19456,t=2,p=1$Y2hhbmdlcmVhbHNhbHQ$Y2hhbmdlcmVhbGhhc2g",
  ),
  verify: vi.fn(async () => false),
}));

import { verify as argon2Verify } from "@node-rs/argon2";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);

beforeEach(async () => {
  vi.mocked(argon2Verify).mockClear();
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("verifyCredentials timing invariant", () => {
  it("performs exactly one argon2 verify against the dummy hash for an unknown email", async () => {
    const result = await verifyCredentials({
      email: "ghost@example.com",
      password: "correct horse battery staple",
    });

    expect(result.ok).toBe(false);
    expect(argon2Verify).toHaveBeenCalledTimes(1);
    expect(argon2Verify).toHaveBeenCalledWith(
      expect.stringMatching(/^\$argon2id\$/),
      "correct horse battery staple",
    );
  });

  it("performs exactly one argon2 verify against the stored hash for a known email with a wrong password", async () => {
    const { hashPassword } = await import("@/lib/auth/password");
    const storedHash = await hashPassword("correct horse battery staple");
    await db
      .insert(users)
      .values({ email: "user@example.com", passwordHash: storedHash });

    await verifyCredentials({
      email: "user@example.com",
      password: "wrong password 123",
    });

    expect(argon2Verify).toHaveBeenCalledTimes(1);
    expect(argon2Verify).toHaveBeenCalledWith(
      storedHash,
      "wrong password 123",
    );
  });

  it("uses the same pinned cost parameters for the dummy hash as for real hashes", async () => {
    const { DUMMY_PASSWORD_HASH } = await import("@/lib/auth/login");

    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(DUMMY_PASSWORD_HASH).toContain("$m=19456,t=2,p=1$");
  });

  it("verifies against the dummy hash even when input is malformed, so every failure path costs the same", async () => {
    await verifyCredentials({ email: "not-an-email", password: "whatever" });
    expect(argon2Verify).toHaveBeenCalledTimes(1);
    expect(argon2Verify).toHaveBeenCalledWith(
      expect.stringMatching(/^\$argon2id\$/),
      "whatever",
    );
  });
});
