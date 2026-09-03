import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, notes, users } from "@/db/schema";
import { pool as appPool } from "@/db";
import { valkey as appValkey } from "@/lib/valkey";
import { login } from "@/lib/auth/login";
import { createNoteForUser } from "@/lib/notes";
import { readCounter } from "@/lib/metrics";
import { captureLog } from "@/lib/__tests__/log-capture";
import { createNoteAction } from "@/app/actions";
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

vi.mock("@/lib/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes")>();
  return {
    ...actual,
    createNoteForUser: vi.fn(actual.createNoteForUser),
  };
});

import { redirect } from "next/navigation";

const pool = new Pool({ connectionString: resolveTestDatabaseUrl() });
const db = drizzle(pool);
const valkey = new Redis(resolveTestValkeyUrl());

const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";

function makeForm(title: FormDataEntryValue | null, content: FormDataEntryValue | null): FormData {
  const form = new FormData();
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
    sql`TRUNCATE users, sessions, notes, note_versions, audit_events, two_factor_recovery_codes`,
  );
  vi.mocked(cookieStore.get).mockReset();
  vi.mocked(redirect).mockReset();
  vi.mocked(revalidatePath).mockReset();
});

describe("createNoteAction (integration)", () => {
  it("redirects to /login and creates nothing without a session", async () => {
    vi.mocked(redirect).mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    });

    await expect(
      createNoteAction({ status: "idle" }, makeForm("Title", "Content")),
    ).rejects.toThrow("NEXT_REDIRECT:/login");

    expect(redirect).toHaveBeenCalledWith("/login");
    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("creates a note for the session user with an audit row and revalidates the workspace", async () => {
    const userId = await seedSession();

    const state = await createNoteAction(
      { status: "idle" },
      makeForm("My title", "My content"),
    );

    expect(state).toEqual({ status: "success" });
    expect(revalidatePath).toHaveBeenCalledWith("/");

    const [note] = await db.select().from(notes);
    expect(note.userId).toBe(userId);
    expect(note.title).toBe("My title");
    expect(note.content).toBe("My content");

    const [event] = await db.select().from(auditEvents);
    expect(event.action).toBe("note.created");
    expect(event.actorUserId).toBe(userId);
    expect(event.resourceType).toBe("note");
    expect(event.resourceId).toBe(note.id);
    expect(event.metadata).toEqual({});
  });

  it("returns a friendly error and creates nothing when both fields are blank", async () => {
    await seedSession();

    const state = await createNoteAction(
      { status: "idle" },
      makeForm("   ", "   "),
    );

    expect(state).toEqual({
      status: "error",
      message: "Add a title or some content before saving.",
    });
    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("captures an unexpected failure and returns the safe message without leaking raw error text", async () => {
    await seedSession();
    vi.mocked(createNoteForUser).mockRejectedValueOnce(
      new Error("notes table vanished mid-create"),
    );
    const logCapture = captureLog();
    try {
      const before = readCounter("errors.operational");

      const state = await createNoteAction(
        { status: "idle" },
        makeForm("My title", "My content"),
      );

      expect(state).toEqual({
        status: "error",
        message: "Unable to save the note right now. Please try again.",
      });
      expect(await db.select().from(notes)).toHaveLength(0);
      expect(await db.select().from(auditEvents)).toHaveLength(0);
      expect(readCounter("errors.operational")).toBe(before + 1);
      expect(logCapture.byLevel("warn")).toHaveLength(1);
      const parsed = logCapture.byLevel("warn")[0] as {
        level: string;
        event: string;
        class: string;
        detail?: string;
      };
      expect(parsed.level).toBe("warn");
      expect(parsed.event).toBe("error.captured");
      expect(parsed.class).toBe("operational");
      expect(parsed.detail).toBeUndefined();
    } finally {
      logCapture.restore();
    }
  });
});
