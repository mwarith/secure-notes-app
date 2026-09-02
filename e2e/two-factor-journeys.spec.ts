import { expect, type Page } from "@playwright/test";
import {
  createAccount,
  registerAccount,
  signIn,
  signOut,
  test,
} from "./helpers/test-account";
import { freshTotpCode, readSecretFromQr, wrongTotpCode } from "./helpers/totp";

/**
 * The browser acts as the authenticator: it scans the QR the setup UI
 * exposes (decoding the otpauth:// URI from the image) and generates codes
 * at assertion time. Every test provisions its own account end-to-end
 * through the real UI, so specs are order-independent.
 */

async function enableTwoFactor(
  page: Page,
): Promise<{
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
}> {
  const account = createAccount();
  await registerAccount(page, account);
  await signIn(page, account);

  await page.goto("/settings/security");
  await page
    .getByRole("button", { name: "Enable two-factor authentication" })
    .click();
  const secret = await readSecretFromQr(page);

  await page.getByLabel("Authentication code").fill(await freshTotpCode(page, secret));
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(
    page.getByText("Two-factor authentication is now enabled."),
  ).toBeVisible();

  const codes = page.locator("ul.font-mono > li");
  await expect(codes).toHaveCount(8);
  const recoveryCodes = await codes.allTextContents();
  await page
    .getByLabel("I've saved these codes somewhere safe")
    .check();
  await page.getByRole("button", { name: "I've saved them" }).click();
  await expect(
    page.getByRole("heading", { name: "Security" }),
  ).toBeVisible();

  return { ...account, secret, recoveryCodes };
}

async function answerChallenge(
  page: Page,
  account: { email: string; password: string },
  code: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/login\/2fa$/);
  await page.getByLabel("Authentication code").fill(code);
  await page.getByRole("button", { name: "Confirm" }).click();
}

test.describe("two-factor setup journey", () => {
  test("enables two-factor authentication and shows one-time recovery codes", async ({
    page,
  }) => {
    const { secret } = await enableTwoFactor(page);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

test.describe("two-factor login journey", () => {
  test("accepts a fresh authenticator code at the challenge", async ({
    page,
  }) => {
    const { email, password, secret } = await enableTwoFactor(page);

    await page.goto("/");
    await signOut(page);
    await answerChallenge(
      page,
      { email, password },
      await freshTotpCode(page, secret),
    );

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Take a note/)).toBeVisible();
  });

  test("rejects a wrong authenticator code with the neutral message", async ({
    page,
  }) => {
    const { email, password, secret } = await enableTwoFactor(page);

    await page.goto("/");
    await signOut(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\/2fa$/);

    await page
      .getByLabel("Authentication code")
      .fill(wrongTotpCode(secret));
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(
      page.getByText("That code didn't match. Try again."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login\/2fa$/);
  });
});

test.describe("two-factor recovery journey", () => {
  test("signs in with a recovery code when the authenticator is lost", async ({
    page,
  }) => {
    const { email, password, recoveryCodes } = await enableTwoFactor(page);

    await page.goto("/");
    await signOut(page);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login\/2fa$/);

    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/Take a note/)).toBeVisible();
  });

  test("never accepts the same recovery code twice", async ({ page }) => {
    const { email, password, recoveryCodes } = await enableTwoFactor(page);

    await page.goto("/");
    await signOut(page);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/login\/2fa$/);

      await page
        .getByRole("button", { name: "Use a recovery code instead" })
        .click();
      await page.getByLabel("Recovery code").fill(recoveryCodes[0]);
      await page.getByRole("button", { name: "Confirm" }).click();

      if (attempt === 0) {
        await expect(page).toHaveURL(/\/$/);
      } else {
        await expect(
          page.getByText("That code didn't match. Try again."),
        ).toBeVisible();
        await expect(page).toHaveURL(/\/login\/2fa$/);
      }
    }
  });
});

test.describe("two-factor disable journey", () => {
  test("turns two-factor off after password and authenticator verification", async ({
    page,
  }) => {
    const { password, secret } = await enableTwoFactor(page);

    await expect(
      page.getByText("Turn off two-factor authentication"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Disable two-factor authentication" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(
      dialog.getByText("Disable two-factor authentication?"),
    ).toBeVisible();

    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog
      .getByLabel("Authentication code")
      .fill(await freshTotpCode(page, secret));
    await dialog
      .getByRole("button", { name: "Disable", exact: true })
      .click();

    await expect(
      page.getByRole("button", { name: "Enable two-factor authentication" }),
    ).toBeVisible();
    await expect(
      page.getByText("Turn off two-factor authentication"),
    ).toHaveCount(0);
  });
});

test.describe("destructive-action failure journey", () => {
  test("keeps two-factor authentication on when the password is wrong", async ({
    page,
  }) => {
    await enableTwoFactor(page);

    await expect(
      page.getByText("Turn off two-factor authentication"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Disable two-factor authentication" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(
      dialog.getByText("Disable two-factor authentication?"),
    ).toBeVisible();

    await dialog
      .getByLabel("Password", { exact: true })
      .fill("not the account password");
    await dialog.getByLabel("Authentication code").fill("654321");
    await dialog
      .getByRole("button", { name: "Disable", exact: true })
      .click();

    await expect(
      dialog.getByText("That password didn't match."),
    ).toBeVisible();
    await expect(
      dialog.getByText("Disable two-factor authentication?"),
    ).toBeVisible();
  });
});
