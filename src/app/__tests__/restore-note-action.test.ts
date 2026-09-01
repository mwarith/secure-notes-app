import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, noteVersions, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { restoreNoteVersionAction } from "@/app/actions";
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
import { revalidatePath } from "next/cache";

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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(redirect).mockReset();
  vi.mocked(revalidatePath).mockReset();
});

describe("restoreNoteVersionAction (integration)", () => {
  it("redirects to /login without a session", async () => {
    await seedUser();
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      restoreNoteVersionAction(
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("restores the session user's own version, revalidates, and audits the restore", async () => {
    const userId = await seedSession();
    const noteId = await seedNote(userId);
    const versionId = await seedVersion(
      noteId,
      "Old title",
      "Old content",
      new Date(Date.now() - 10 * 60 * 1000),
    );

    const result = await restoreNoteVersionAction(noteId, versionId);

    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/");

    const [event] = await db.select().from(auditEvents);
    expect(event?.action).toBe("note.version_restored");
    expect(event?.actorUserId).toBe(userId);
    expect(event?.resourceType).toBe("note");
    expect(event?.resourceId).toBe(noteId);
    expect(event?.metadata).toEqual({ restoredVersionId: versionId });
  });

  it("returns { ok: false } for another user's version", async () => {
    await seedSession();
    const otherUserId = await seedUser("other@example.com");
    const foreignNoteId = await seedNote(otherUserId);
    const foreignVersionId = await seedVersion(
      foreignNoteId,
      "Foreign title",
      "Foreign content",
      new Date(),
    );

    expect(
      await restoreNoteVersionAction(foreignNoteId, foreignVersionId),
    ).toEqual({ ok: false });
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});
