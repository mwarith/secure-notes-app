import { expect, type Page } from "@playwright/test";
import {
  createAccount,
  registerAccount,
  signIn,
  signOut,
  test,
} from "./helpers/test-account";

function uniqueTitle(): string {
  return `Journey note ${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

async function createNoteViaDialog(
  page: Page,
  title: string,
  content: string,
): Promise<void> {
  await page.getByRole("button", { name: "Create a note" }).click();
  await expect(page.getByText("Add a title, some content, or both.")).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Content").fill(content);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Add a title, some content, or both."),
  ).toBeHidden();
  await expect(page.getByText(title)).toBeVisible();
}

async function openEditor(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(title) }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText("Edit note")).toBeVisible();
}

function editorContent(page: Page) {
  return page.getByRole("dialog").getByLabel("Content");
}

async function closeEditor(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByText("Edit note")).toBeHidden();
}

test.describe("create-note journey", () => {
  test("creates a note from the workspace and shows it on the grid", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "First journey content");

    await expect(
      page.getByRole("button", { name: new RegExp(title) }),
    ).toBeVisible();
  });

  test("explains that an empty note cannot be saved", async ({ page }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    await page.getByRole("button", { name: "Create a note" }).click();
    await expect(page.getByText("Add a title, some content, or both.")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(
      page.getByText("Add a title or some content before saving."),
    ).toBeVisible();
    await expect(
      page.getByText("Add a title, some content, or both."),
    ).toBeVisible();
  });
});

test.describe("privacy journey", () => {
  test("never shows one user's note to another user", async ({ page }) => {
    const author = createAccount();
    await registerAccount(page, author);
    await signIn(page, author);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Private journey content");
    await signOut(page);

    const intruder = createAccount();
    await registerAccount(page, intruder);
    await signIn(page, intruder);

    await expect(page.getByText(title)).toHaveCount(0);
    await expect(page.getByText(/Take a note/)).toBeVisible();
  });
});

test.describe("edit + autosave journeys", () => {
  test("shows the save states, persists the edit, and survives a refresh", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Original journey content");
    await openEditor(page, title);

    const editor = page.getByRole("dialog");
    const indicator = editor.getByRole("status");
    await expect(indicator).toHaveText(
      "Changes save when you close the editor.",
    );

    const edited = "Edited journey content";
    await editorContent(page).fill(edited);
    await expect(indicator).toHaveText("Saved");

    await closeEditor(page);
    await openEditor(page, title);
    await expect(editorContent(page)).toHaveValue(edited);

    await closeEditor(page);
    await page.reload();
    await openEditor(page, title);
    await expect(editorContent(page)).toHaveValue(edited);
  });

  test("flushes pending changes when the editor is closed mid-debounce", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Content before the quick close");
    await openEditor(page, title);

    await editorContent(page).fill("Typed and closed immediately");
    await closeEditor(page);

    await openEditor(page, title);
    await expect(editorContent(page)).toHaveValue(
      "Typed and closed immediately",
    );
  });

  test("closing a clean editor changes nothing", async ({ page }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Untouched content");
    await openEditor(page, title);

    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("status")).toHaveText(
      "Changes save when you close the editor.",
    );
    await closeEditor(page);

    await openEditor(page, title);
    await expect(editorContent(page)).toHaveValue("Untouched content");
  });
});

test.describe("version history journey", () => {
  test("lists captured versions and restores an earlier one", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Version one content");
    await openEditor(page, title);

    await editorContent(page).fill("Version two content");
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
      "Saved",
    );
    await closeEditor(page);

    await openEditor(page, title);
    const editor = page.getByRole("dialog");
    await editor.getByRole("button", { name: "History" }).click();

    const rows = editor.getByRole("listitem").getByRole("button");
    await expect(rows).toHaveCount(2);

    await rows.nth(1).click();
    await expect(editor.getByText("Version one content")).toBeVisible();

    await editor.getByRole("button", { name: "Restore" }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(
      confirmDialog.getByText("Restore this version?"),
    ).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Restore" }).click();

    await expect(page.getByText("Edit note")).toBeHidden();

    await openEditor(page, title);
    await expect(editorContent(page)).toHaveValue("Version one content");

    await editor.getByRole("button", { name: "History" }).click();
    await expect(rows).toHaveCount(3);
  });
});

test.describe("delete journey", () => {
  test("removes the note after an explicit confirmation", async ({ page }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    const title = uniqueTitle();
    await createNoteViaDialog(page, title, "Doomed journey content");
    await openEditor(page, title);

    await page.getByRole("button", { name: "Delete note" }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(
      confirmDialog.getByText("Delete this note?"),
    ).toBeVisible();
    await confirmDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();

    await expect(page.getByText("Edit note")).toBeHidden();
    await expect(page.getByText(title)).toHaveCount(0);
  });
});
