import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, noteVersions, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { listNoteVersionsAction } from "@/app/actions";
import {
  resolveTestDatabaseUrl,
  resolveTestValkeyUrl,
} from "../../../vitest.helpers";

const { cookieStore } = vi.hoisted(() => ({
  cookieStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

async function seedUser(email = EMAIL): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  return user.id;
}

async function seedSession(): Promise<string> {
  const userId = await seedUser();
  const result = await login({ email: EMAIL, password: PASSWORD });
  if (!result.ok) throw new Error("expected login to succeed");
  vi.mocked(cookieStore.get).mockReturnValue({
    name: "session",
    value: result.token,
  } as never);
  await db.delete(auditEvents);
  return userId;
}

async function seedNote(userId: string): Promise<string> {
  const [note] = await db
    .insert(notes)
    .values({ userId, title: "Original title", content: "Original content" })
    .returning({ id: notes.id });
  return note.id;
}

async function seedVersion(
  noteId: string,
  title: string,
  content: string,
  createdAt: Date,
): Promise<string> {
  const [version] = await db
    .insert(noteVersions)
    .values({ noteId, title, content, createdAt })
    .returning({ id: noteVersions.id });
  return version.id;
}

afterAll(async () => {
  await Promise.all([
    pool.end(),
    appPool.end(),
    valkey.quit().catch(() => undefined),
    appValkey.quit().catch(() => undefined),
  ]);
});

beforeEach(async () => {
  await valkey.flushdb();
  await db.execute(
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(redirect).mockReset();
});

describe("listNoteVersionsAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      listNoteVersionsAction("00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("returns the session user's own note versions newest-first", async () => {
    const userId = await seedSession();
    const noteId = await seedNote(userId);
    await seedVersion(
      noteId,
      "V1 title",
      "V1 content",
      new Date(Date.now() - 10 * 60 * 1000),
    );
    await seedVersion(noteId, "V2 title", "V2 content", new Date());

    const versions = await listNoteVersionsAction(noteId);

    expect(versions).toHaveLength(2);
    expect(versions[0]?.title).toBe("V2 title");
    expect(versions[0]?.content).toBe("V2 content");
    expect(versions[0]?.noteId).toBe(noteId);
    expect(versions[0]?.id).toEqual(expect.any(String));
    expect(versions[0]?.createdAt).toBeInstanceOf(Date);
    expect(versions[1]?.title).toBe("V1 title");
    expect(versions[1]?.content).toBe("V1 content");
    expect(versions[0]?.createdAt.getTime()).toBeGreaterThan(
      versions[1]?.createdAt.getTime() ?? Infinity,
    );
  });

  it("returns an empty list for another user's note", async () => {
    await seedSession();
    const otherUserId = await seedUser("other@example.com");
    const foreignNoteId = await seedNote(otherUserId);
    await seedVersion(
      foreignNoteId,
      "Foreign title",
      "Foreign content",
      new Date(),
    );

    expect(await listNoteVersionsAction(foreignNoteId)).toEqual([]);
  });
});
