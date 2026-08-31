import { describe, expect, it } from "vitest";
import { resolveSaveIndicator } from "@/app/save-indicator";

describe("resolveSaveIndicator", () => {
  it("reports saving while pending, even with an error and a recent save", () => {
    expect(
      resolveSaveIndicator({
        pending: true,
        status: "error",
        savedRecently: true,
      }),
    ).toBe("saving");
  });

  it("reports failed on error, even with a recent save", () => {
    expect(
      resolveSaveIndicator({
        pending: false,
        status: "error",
        savedRecently: true,
      }),
    ).toBe("failed");
  });

  it("reports saved while savedRecently holds", () => {
    expect(
      resolveSaveIndicator({
        pending: false,
        status: "success",
        savedRecently: true,
      }),
    ).toBe("saved");
  });

  it("reports idle otherwise", () => {
    expect(
      resolveSaveIndicator({
        pending: false,
        status: "idle",
        savedRecently: false,
      }),
    ).toBe("idle");
    expect(
      resolveSaveIndicator({
        pending: false,
        status: "success",
        savedRecently: false,
      }),
    ).toBe("idle");
  });
});
