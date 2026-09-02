import { describe, expect, it } from "vitest";
import { resolveCreateClose } from "@/app/create-close-policy";

describe("resolveCreateClose", () => {
  it("dismisses when both fields are blank", () => {
    expect(resolveCreateClose({ title: "", content: "" })).toBe("dismiss");
  });

  it("dismisses when both fields are whitespace-only", () => {
    expect(
      resolveCreateClose({ title: "   ", content: "\t\n \u00a0" }),
    ).toBe("dismiss");
  });

  it("submits when only the title is non-blank", () => {
    expect(
      resolveCreateClose({ title: "Grocery list", content: "" }),
    ).toBe("submit");
  });

  it("submits when only the content is non-blank", () => {
    expect(resolveCreateClose({ title: "", content: "Milk, eggs" })).toBe(
      "submit",
    );
  });

  it("submits when only the title is non-blank after whitespace padding", () => {
    expect(
      resolveCreateClose({ title: "  Grocery list  ", content: "" }),
    ).toBe("submit");
  });

  it("submits when both fields are non-blank", () => {
    expect(
      resolveCreateClose({ title: "Grocery list", content: "Milk, eggs" }),
    ).toBe("submit");
  });
});
