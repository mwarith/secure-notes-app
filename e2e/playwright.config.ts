import { defineConfig, devices } from "@playwright/test";

/**
 * Browser automation for the PRD §14 journeys, run against the real
 * dockerized compose stack (the web service on localhost:3000).
 *
 * The suite is serial on purpose: one worker keeps every test's
 * registration/login limiter budget predictable, and each test simulates
 * its own client IP via a random x-forwarded-for (the app's documented,
 * trusted-proxy header) so rate-limit windows are per-test and the whole
 * suite is repeatable back-to-back with no manual cleanup.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "docker compose up -d web",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    cwd: "..",
    timeout: 180_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
