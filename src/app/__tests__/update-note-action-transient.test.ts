import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { readCounter } from "@/lib/metrics";
import { updateNoteAction } from "@/app/actions";
import { revalidatePath } from "next/cache";
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

vi.mock("@/lib/notes", () => ({
  createNoteForUser: vi.fn(),
  updateNoteForUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, getSession: vi.fn() };
});

import { redirect } from "next/navigation";
import { updateNoteForUser } from "@/lib/notes";
import { getSession } from "@/lib/auth/session";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

function makeForm(
  noteId: FormDataEntryValue | null,
  title: FormDataEntryValue | null,
  content: FormDataEntryValue | null,
): FormData {
  const form = new FormData();
  if (noteId !== null) form.set("noteId", noteId);
  if (title !== null) form.set("title", title);
  if (content !== null) form.set("content", content);
  return form;
}

async function seedUser(): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, passwordHash: await hashPassword(PASSWORD) })
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
  vi.mocked(getSession).mockResolvedValue({
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await db.delete(auditEvents);
  return userId;
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
  vi.mocked(updateNoteForUser).mockReset();
  vi.mocked(getSession).mockReset();
});

describe("updateNoteAction transient failures (integration)", () => {
  it("returns a retryable error, logs the failure, counts it, and skips revalidation when the update throws", async () => {
    const userId = await seedSession();
    const noteId = "00000000-0000-0000-0000-0000000000ff";
    vi.mocked(updateNoteForUser).mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failuresBefore = readCounter("autosave_failures_total");

    try {
      const state = await updateNoteAction(
        { status: "idle" },
        makeForm(noteId, "Retried title", "Retried content"),
      );

      expect(state).toEqual({
        status: "error",
        retryable: true,
        message: "Couldn't save right now. Try again.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(await db.select().from(auditEvents)).toHaveLength(0);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = errorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line) as {
        level: string;
        event: string;
        userId: string;
        noteId: string;
      };
      expect(parsed.level).toBe("error");
      expect(parsed.event).toBe("autosave.save_failed");
      expect(parsed.userId).toBe(userId);
      expect(parsed.noteId).toBe(noteId);

      expect(readCounter("autosave_failures_total")).toBe(failuresBefore + 1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a retryable error, logs the failure, and counts it when the session store is unreachable", async () => {
    await seedSession();
    const noteId = "00000000-0000-0000-0000-0000000000fe";
    vi.mocked(getSession).mockRejectedValue(new Error("connection refused"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failuresBefore = readCounter("autosave_failures_total");

    try {
      const state = await updateNoteAction(
        { status: "idle" },
        makeForm(noteId, "Retried title", "Retried content"),
      );

      expect(state).toEqual({
        status: "error",
        retryable: true,
        message: "Couldn't save right now. Try again.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(await db.select().from(auditEvents)).toHaveLength(0);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = errorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line) as {
        level: string;
        event: string;
        userId: string | null;
        noteId: string;
      };
      expect(parsed.level).toBe("error");
      expect(parsed.event).toBe("autosave.save_failed");
      expect(parsed.userId).toBeNull();
      expect(parsed.noteId).toBe(noteId);

      expect(readCounter("autosave_failures_total")).toBe(failuresBefore + 1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
