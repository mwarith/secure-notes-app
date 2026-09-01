import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, noteVersions, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { deleteNoteAction } from "@/app/actions";
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
    .values({ userId, title: "Doomed title", content: "Doomed content" })
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
  vi.mocked(revalidatePath).mockReset();
});

describe("deleteNoteAction (integration)", () => {
  it("redirects to /login without a session, deleting nothing", async () => {
    const userId = await seedUser();
    const noteId = await seedNote(userId);
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(deleteNoteAction(noteId)).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );

    expect(redirect).toHaveBeenCalledWith("/login");
    expect(
      await db.select().from(notes).where(eq(notes.id, noteId)),
    ).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("deletes the session user's own note, cascades its versions, revalidates, and audits", async () => {
    const userId = await seedSession();
    const noteId = await seedNote(userId);
    await seedVersion(
      noteId,
      "Old title",
      "Old content",
      new Date(Date.now() - 10 * 60 * 1000),
    );

    const result = await deleteNoteAction(noteId);

    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(
      await db.select().from(notes).where(eq(notes.id, noteId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.noteId, noteId)),
    ).toEqual([]);

    const [event] = await db.select().from(auditEvents);
    expect(event?.action).toBe("note.deleted");
    expect(event?.actorUserId).toBe(userId);
    expect(event?.resourceType).toBe("note");
    expect(event?.resourceId).toBe(noteId);
    expect(event?.metadata).toEqual({});
  });

  it("returns { ok: false } for another user's note and leaves it fully untouched", async () => {
    await seedSession();
    const otherUserId = await seedUser("other@example.com");
    const foreignNoteId = await seedNote(otherUserId);
    await seedVersion(
      foreignNoteId,
      "Foreign title",
      "Foreign content",
      new Date(),
    );

    expect(await deleteNoteAction(foreignNoteId)).toEqual({ ok: false });

    expect(
      await db.select().from(notes).where(eq(notes.id, foreignNoteId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(noteVersions)
        .where(eq(noteVersions.noteId, foreignNoteId)),
    ).toHaveLength(1);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });
});
