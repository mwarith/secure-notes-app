import { describe, expect, it } from "vitest";
import { resolveEditorSave } from "@/app/editor-save-policy";

type ResolveInput = Parameters<typeof resolveEditorSave>[0];

const saved = { title: "Saved title", content: "Saved content" };

function makeInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    trigger: "close",
    pending: false,
    status: "idle",
    fields: { ...saved },
    lastSaved: { ...saved },
    failedAttempt: null,
    ...overrides,
  };
}

describe("resolveEditorSave", () => {
  it("ignores every trigger while a save is pending", () => {
    const fields = { title: "Typed title", content: "Typed content" };
    expect(
      resolveEditorSave(makeInput({ trigger: "close", pending: true, fields })),
    ).toBe("ignore");
    expect(
      resolveEditorSave(
        makeInput({ trigger: "debounce", pending: true, fields }),
      ),
    ).toBe("ignore");
    expect(
      resolveEditorSave(makeInput({ trigger: "blur", pending: true, fields })),
    ).toBe("ignore");
  });

  it("closes cleanly when closing with no changes", () => {
    expect(resolveEditorSave(makeInput({ trigger: "close" }))).toBe("close");
  });

  it("submits when closing with changed fields", () => {
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "close",
          fields: { title: "New title", content: saved.content },
        }),
      ),
    ).toBe("submit");
  });

  it("submits on debounce and blur when dirty, ignores when clean", () => {
    const fields = { title: "New title", content: saved.content };
    expect(
      resolveEditorSave(makeInput({ trigger: "debounce", fields })),
    ).toBe("submit");
    expect(resolveEditorSave(makeInput({ trigger: "blur", fields }))).toBe(
      "submit",
    );
    expect(resolveEditorSave(makeInput({ trigger: "debounce" }))).toBe(
      "ignore",
    );
    expect(resolveEditorSave(makeInput({ trigger: "blur" }))).toBe("ignore");
  });

  it("abandons on close after a failed attempt when nothing changed since", () => {
    const failedAttempt = { title: "Attempted", content: "Attempted" };
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "close",
          status: "error",
          fields: { ...failedAttempt },
          failedAttempt,
        }),
      ),
    ).toBe("abandon");
  });

  it("retries on close when the user typed more after a failed attempt", () => {
    const failedAttempt = { title: "Attempted", content: "Attempted" };
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "close",
          status: "error",
          fields: { title: "Attempted!", content: "Attempted" },
          failedAttempt,
        }),
      ),
    ).toBe("submit");
  });

  it("treats blank-but-different fields as dirty so blank autosave is allowed", () => {
    const fields = { title: "", content: "" };
    expect(resolveEditorSave(makeInput({ trigger: "debounce", fields }))).toBe(
      "submit",
    );
    expect(resolveEditorSave(makeInput({ trigger: "close", fields }))).toBe(
      "submit",
    );
  });

  it("abandons on close when the failure has no outstanding snapshot", () => {
    expect(
      resolveEditorSave(
        makeInput({ trigger: "close", status: "error", fields: { ...saved } }),
      ),
    ).toBe("abandon");
  });

  it("does not consult the save status for debounce or blur triggers", () => {
    const failedAttempt = { ...saved };
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "blur",
          status: "error",
          fields: { title: "New title", content: saved.content },
          failedAttempt,
        }),
      ),
    ).toBe("submit");
    expect(
      resolveEditorSave(
        makeInput({ trigger: "debounce", status: "error", failedAttempt }),
      ),
    ).toBe("ignore");
  });

  it("submits on retry unless pending, bypassing dirty and unchanged-since-failure checks", () => {
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "retry",
          fields: { ...saved },
          failedAttempt: { ...saved },
        }),
      ),
    ).toBe("submit");
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "retry",
          status: "error",
          fields: { ...saved },
          failedAttempt: { ...saved },
        }),
      ),
    ).toBe("submit");
    expect(
      resolveEditorSave(
        makeInput({
          trigger: "retry",
          pending: true,
          fields: { title: "Typed", content: "Typed" },
        }),
      ),
    ).toBe("ignore");
  });
});
