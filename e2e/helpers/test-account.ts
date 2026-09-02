import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export interface TestAccount {
  email: string;
  password: string;
}

const PASSWORD = "correct horse battery staple e2e";

export function createAccount(): TestAccount {
  const suffix = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return { email: `e2e-${suffix}@example.com`, password: PASSWORD };
}

function randomClientIp(): string {
  return `10.221.${Math.floor(Math.random() * 256)}.${Math.floor(
    Math.random() * 256,
  )}`;
}

/**
 * Each test simulates its own client: a unique x-forwarded-for rotates the
 * IP-scoped rate-limit buckets so the suite is repeatable back-to-back and
 * order-independent. The app processes everything exactly as it would for
 * any user behind a proxy — no seeding, no bypass.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({
      "x-forwarded-for": randomClientIp(),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture finalizer, not a React hook
    await use(context);
  },
});

export { expect };

export async function registerAccount(
  page: Page,
  account: TestAccount,
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Account created")).toBeVisible();
}

export async function signIn(
  page: Page,
  account: TestAccount,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Take a note/)).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}
