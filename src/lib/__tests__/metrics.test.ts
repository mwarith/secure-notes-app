import { describe, expect, it, vi } from "vitest";
import { incrementCounter, readCounter } from "@/lib/metrics";
import { log } from "@/lib/logger";

describe("metrics counters", () => {
  it("reads zero for names that were never incremented", () => {
    expect(readCounter("never_touched_total")).toBe(0);
  });

  it("increments each name independently and honors the step", () => {
    incrementCounter("metrics_test.a_total");
    incrementCounter("metrics_test.a_total");
    incrementCounter("metrics_test.a_total");
    incrementCounter("metrics_test.b_total", 5);
    expect(readCounter("metrics_test.a_total")).toBe(3);
    expect(readCounter("metrics_test.b_total")).toBe(5);
  });
});

describe("log", () => {
  it("emits one JSON line with ts, level, event, and fields", () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      log("error", "autosave.save_failed", {
        userId: "user-1",
        noteId: "note-1",
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = errorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(line) as {
        ts: string;
        level: string;
        event: string;
        userId: string;
        noteId: string;
      };
      expect(typeof parsed.ts).toBe("string");
      expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
      expect(parsed.level).toBe("error");
      expect(parsed.event).toBe("autosave.save_failed");
      expect(parsed.userId).toBe("user-1");
      expect(parsed.noteId).toBe("note-1");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("emits without a fields object when none is given", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      log("info", "some.event");
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as {
        ts: string;
        level: string;
        event: string;
      };
      expect(parsed.level).toBe("info");
      expect(parsed.event).toBe("some.event");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
