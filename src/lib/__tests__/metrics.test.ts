import { describe, expect, it, vi } from "vitest";
import {
  incrementCounter,
  processStartedAtEpochMs,
  readCounter,
} from "@/lib/metrics";
import { captureLog } from "@/lib/__tests__/log-capture";
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

describe("process start epoch (ENG-54)", () => {
  it("is stable across module re-instantiations within a process (globalThis anchor)", async () => {
    const first = processStartedAtEpochMs();
    vi.resetModules();
    const reimported = (await import("@/lib/metrics"))
      .processStartedAtEpochMs;
    expect(reimported()).toBe(first);
  });

  it("is a sane epoch in milliseconds (finite, not in the future)", () => {
    const epoch = processStartedAtEpochMs();
    expect(Number.isFinite(epoch)).toBe(true);
    expect(epoch).toBeLessThanOrEqual(Date.now());
  });

  it("does not change the counter seam behavior (increments/reads unchanged)", () => {
    const before = readCounter("metrics_test.epoch_probe_total");
    incrementCounter("metrics_test.epoch_probe_total", 2);
    expect(readCounter("metrics_test.epoch_probe_total")).toBe(before + 2);
  });
});

describe("log", () => {
  it("emits one JSON line with ts, level, event, and fields", () => {
    const logCapture = captureLog();
    try {
      log("error", "autosave.save_failed", {
        userId: "user-1",
        noteId: "note-1",
      });

      expect(logCapture.byLevel("error")).toHaveLength(1);
      const parsed = logCapture.byLevel("error")[0] as {
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
      logCapture.restore();
    }
  });

  it("emits without a fields object when none is given", () => {
    const logCapture = captureLog();
    try {
      log("info", "some.event");
      expect(logCapture.byLevel("info")).toHaveLength(1);
      const parsed = logCapture.byLevel("info")[0] as {
        ts: string;
        level: string;
        event: string;
      };
      expect(parsed.level).toBe("info");
      expect(parsed.event).toBe("some.event");
    } finally {
      logCapture.restore();
    }
  });
});
