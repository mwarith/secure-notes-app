import { createAccount, expect, registerAccount, signIn, signOut, test } from "./helpers/test-account";

test.describe("registration journey", () => {
  test("creates an account and hands the user to sign-in", async ({
    page,
  }) => {
    const account = createAccount();

    await registerAccount(page, account);

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByText("Sign in with your email address and password."),
    ).toBeVisible();
  });
});

test.describe("registration validation journey", () => {
  test("explains password requirements and existing-account conflicts", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);

    await page.goto("/register");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill("too short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText(
        "Password must be at least 12 characters and must not contain your email address.",
      ),
    ).toBeVisible();

    // The form clears its uncontrolled fields when the action completes, so
    // the retry refills both, like a real user would.
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText(
        "Unable to create account with these details. If you already have an account, try signing in or resetting your password.",
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });
});

test.describe("login journey", () => {
  test("signs in with valid credentials and reaches the workspace", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);

    await signIn(page, account);

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole("banner").getByText("Secure Notes", { exact: true }),
    ).toBeVisible();
  });

  test("rejects a wrong password with the neutral message", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);

    await page.goto("/login");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill("totally wrong password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByText("Invalid email or password."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("logout journey", () => {
  test("signs out and the revoked session cannot reach the workspace", async ({
    page,
  }) => {
    const account = createAccount();
    await registerAccount(page, account);
    await signIn(page, account);

    await signOut(page);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("unauthorized access", () => {
  test("redirects visitors without a session away from protected pages", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);

    await page.goto("/settings/security");
    await expect(page).toHaveURL(/\/login$/);
  });
});
