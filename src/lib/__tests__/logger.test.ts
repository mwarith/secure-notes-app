import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";

/**
 * ENG-16: the seam now writes via pino to process.stdout (a plain stream
 * destination, no transports/worker threads). Each log() call must emit
 * exactly one JSON line on process.stdout with the pre-pino shape
 * { ts: ISO string, level: string label, event, ...fields } — the
 * downstream contract of the ENG-40 Loki panels and the drill doc greps.
 */

type LogLine = Record<string, unknown> & {
  ts?: unknown;
  level?: unknown;
  event?: unknown;
};

describe("logger (pino seam, ENG-16)", () => {
  let chunks: string[];

  beforeEach(() => {
    chunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lines(): string[] {
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }

  function parsed(): LogLine[] {
    return lines().map((line) => JSON.parse(line) as LogLine);
  }

  it("emits exactly one parseable JSON line per call", () => {
    log("info", "some.event");
    expect(lines()).toHaveLength(1);
    expect(parsed()).toHaveLength(1);
  });

  it("keeps the shape: ts ISO, level string, event verbatim, fields top-level", () => {
    log("info", "cache.valkey_failed", {
      operation: "get",
      detail: "Stream isn't writeable",
    });

    const [entry] = parsed();
    expect(entry).toBeDefined();
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("cache.valkey_failed");
    expect(entry.operation).toBe("get");
    expect(entry.detail).toBe("Stream isn't writeable");
  });

  it("maps info/warn/error to their string labels", () => {
    log("info", "evt.info");
    log("warn", "evt.warn");
    log("error", "evt.error");

    const entries = parsed();
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("censors secret-shaped fields with the [redacted] censor", () => {
    log("warn", "auth.probe", {
      password: "hunter2",
      token: "tok",
      secret: "s3cret",
      code: "123456",
      recoveryCode: "abcd-efgh",
      totp: "654321",
    });

    const [entry] = parsed();
    expect(entry.password).toBe("[redacted]");
    expect(entry.token).toBe("[redacted]");
    expect(entry.secret).toBe("[redacted]");
    expect(entry.code).toBe("[redacted]");
    expect(entry.recoveryCode).toBe("[redacted]");
    expect(entry.totp).toBe("[redacted]");
  });

  it("censors secrets nested one level under any key", () => {
    log("warn", "auth.probe", {
      auth: { token: "x", password: "y" },
    });

    const [entry] = parsed();
    const auth = entry.auth as Record<string, unknown>;
    expect(auth.token).toBe("[redacted]");
    expect(auth.password).toBe("[redacted]");
  });

  it("does not censor non-secret fields", () => {
    log("warn", "cache.valkey_failed", {
      outcome: "degraded",
      noteId: "note-1",
      operation: "del",
      event: "cache.valkey_failed",
      code: "000000",
    });

    const [entry] = parsed();
    expect(entry.event).toBe("cache.valkey_failed");
    expect(entry.outcome).toBe("degraded");
    expect(entry.noteId).toBe("note-1");
    expect(entry.operation).toBe("del");
    expect(entry.code).toBe("[redacted]");
  });

  it("does not throw or corrupt the line on an Error field value", () => {
    log("error", "evt.error_field", {
      detail: new Error("boom"),
    });

    const [entry] = parsed();
    expect("detail" in entry).toBe(true);
  });

  it("does not throw or corrupt the line on an undefined field value", () => {
    log("info", "evt.undefined_field", {
      detail: undefined,
    });

    const [entry] = parsed();
    expect(entry.event).toBe("evt.undefined_field");
  });

  it("does not throw or corrupt the line on a circular structure", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => log("warn", "evt.circular", { detail: circular })).not.toThrow();
    const [entry] = parsed();
    expect(entry.event).toBe("evt.circular");
    expect(entry.level).toBe("warn");
  });
});
