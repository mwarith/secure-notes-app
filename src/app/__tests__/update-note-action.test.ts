import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
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

import { redirect } from "next/navigation";

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

describe("updateNoteAction (integration)", () => {
  it("redirects to /login and updates nothing without a session", async () => {
    const userId = await seedUser();
    const noteId = await seedNote(userId);
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      updateNoteAction(
        { status: "idle" },
        makeForm(noteId, "Hijacked title", "Hijacked content"),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");

    const [note] = await db.select().from(notes);
    expect(note.title).toBe("Original title");
    expect(note.content).toBe("Original content");
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("updates the owned note verbatim, writes the audit row, and revalidates the workspace", async () => {
    const userId = await seedSession();
    const noteId = await seedNote(userId);

    const state = await updateNoteAction(
      { status: "idle" },
      makeForm(noteId, "  Spaced title  ", "Body\nwith trailing spaces  "),
    );

    expect(state).toEqual({ status: "success" });
    expect(revalidatePath).toHaveBeenCalledWith("/");

    const [note] = await db.select().from(notes);
    expect(note.title).toBe("  Spaced title  ");
    expect(note.content).toBe("Body\nwith trailing spaces  ");

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("note.updated");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("note");
    expect(event.resourceId).toBe(noteId);
    expect(event.metadata).toEqual({});
  });

  it("returns an error, writes no audit, and changes nothing for another user's note", async () => {
    await seedSession();
    const otherUserId = await seedUser("other@example.com");
    const foreignNoteId = await seedNote(otherUserId);

    const state = await updateNoteAction(
      { status: "idle" },
      makeForm(foreignNoteId, "Hijacked title", "Hijacked content"),
    );

    expect(state).toEqual({
      status: "error",
      message: "This note is no longer available.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/");

    const [note] = await db.select().from(notes);
    expect(note.title).toBe("Original title");
    expect(note.content).toBe("Original content");
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("returns an error and changes nothing for a malformed or missing note id", async () => {
    const userId = await seedSession();
    await seedNote(userId);

    const malformed = await updateNoteAction(
      { status: "idle" },
      makeForm("not-a-uuid", "Updated title", "Updated content"),
    );
    expect(malformed).toEqual({
      status: "error",
      message: "This note is no longer available.",
    });

    const missing = await updateNoteAction(
      { status: "idle" },
      makeForm(null, "Updated title", "Updated content"),
    );
    expect(missing).toEqual({
      status: "error",
      message: "This note is no longer available.",
    });

    expect(revalidatePath).toHaveBeenCalledWith("/");

    const [note] = await db.select().from(notes);
    expect(note.title).toBe("Original title");
    expect(note.content).toBe("Original content");
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("allows editing a note down to fully blank title and content", async () => {
    const userId = await seedSession();
    const noteId = await seedNote(userId);

    const state = await updateNoteAction(
      { status: "idle" },
      makeForm(noteId, "   ", ""),
    );

    expect(state).toEqual({ status: "success" });

    const [note] = await db.select().from(notes);
    expect(note.title).toBe("   ");
    expect(note.content).toBe("");

    const events = await db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(["note.updated"]);
  });
});
