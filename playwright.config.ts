import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config. Specs live in `e2e/` and each user story names
 * the spec that proves it. Failed runs leave traces and screenshots in
 * `test-results/` so CI can upload them.
 */
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
