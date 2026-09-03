import { describe, expect, it } from "vitest";
import {
  AppError,
  PRD9_CHECKLIST,
  reportError,
  toActionError,
  type AppErrorClass,
  type Prd9CaseId,
} from "@/lib/errors";
import { readCounter } from "@/lib/metrics";
import { captureLog } from "@/lib/__tests__/log-capture";

describe("AppError", () => {
  it("classifies user_input as not retryable", () => {
    const error = new AppError({
      class: "user_input",
      userMessage: "Add a title or some content before saving.",
    });
    expect(error.retryable).toBe(false);
  });

  it("classifies auth as not retryable", () => {
    const error = new AppError({
      class: "auth",
      userMessage: "Too many attempts. Try again later.",
    });
    expect(error.retryable).toBe(false);
  });

  it("classifies operational as retryable", () => {
    const error = new AppError({
      class: "operational",
      userMessage: "Couldn't save right now. Try again.",
    });
    expect(error.retryable).toBe(true);
  });

  it("classifies unexpected as not retryable", () => {
    const error = new AppError({
      class: "unexpected",
      userMessage: "Something went wrong.",
    });
    expect(error.retryable).toBe(false);
  });
});

describe("toActionError", () => {
  it("keeps an AppError's class-derived retryability and userMessage", () => {
    const error = new AppError({
      class: "auth",
      userMessage: "Too many attempts. Try again later.",
      detail: "rate limiter says wait",
    });
    expect(toActionError(error, { message: "fallback" })).toEqual({
      message: "Too many attempts. Try again later.",
      retryable: false,
    });
  });

  it("normalizes an unknown Error instance to unexpected with the fallback message", () => {
    const result = toActionError(new Error("raw internal failure"), {
      message: "Something went wrong.",
    });
    expect(result).toEqual({ message: "Something went wrong.", retryable: false });
  });

  it("normalizes a non-Error thrown value to unexpected without crashing", () => {
    const throwAString = (): unknown => {
      throw "just a string";
    };
    let captured: unknown;
    try {
      captured = throwAString();
    } catch (error) {
      expect(
        toActionError(error, { message: "Something went wrong." }),
      ).toEqual({ message: "Something went wrong.", retryable: false });
    }
    expect(captured).toBeUndefined();
  });

  it("never leaks AppError detail into the returned message", () => {
    const error = new AppError({
      class: "operational",
      userMessage: "Couldn't save right now. Try again.",
      detail: "ECONNREFUSED 10.0.0.12:5432",
    });
    const result = toActionError(error, { message: "fallback" });
    expect(result.message).toBe("Couldn't save right now. Try again.");
    expect(result.message).not.toContain("ECONNREFUSED");
  });
});

describe("PRD9_CHECKLIST", () => {
  it("maps all ten error cases to their approved error classes", () => {
    const approved: Record<Prd9CaseId, AppErrorClass> = {
      "auth-fail": "auth",
      "twofa-fail": "auth",
      "unauthorized-action": "auth",
      "invalid-input": "user_input",
      "note-save-fail": "operational",
      "autosave-fail": "operational",
      timeout: "operational",
      "service-unavailable": "operational",
      "restore-fail": "operational",
      "destructive-action-fail": "operational",
    };
    expect(Object.keys(PRD9_CHECKLIST).sort()).toEqual(
      Object.keys(approved).sort(),
    );
    for (const id of Object.keys(approved) as Prd9CaseId[]) {
      expect(PRD9_CHECKLIST[id]).toBe(approved[id]);
    }
  });
});

describe("reportError", () => {
  it("captures unexpected failures via the seam and increments errors.unexpected", () => {
    const logCapture = captureLog();
    try {
      const before = readCounter("errors.unexpected");
      const result = reportError(new Error("raw internal failure"), {
        message: "Something went wrong.",
      });
      expect(result).toEqual({
        message: "Something went wrong.",
        retryable: false,
      });
      expect(logCapture.byLevel("error")).toHaveLength(1);
      const parsed = logCapture.byLevel("error")[0] as {
        level: string;
        event: string;
        class: string;
      };
      expect(parsed.level).toBe("error");
      expect(parsed.event).toBe("error.captured");
      expect(parsed.class).toBe("unexpected");
      expect(readCounter("errors.unexpected")).toBe(before + 1);
    } finally {
      logCapture.restore();
    }
  });
});
