// @ts-check
import { defineConfig } from "@playwright/test";

/**
 * Playwright config for end-to-end tests against a real ProQyz instance.
 * These tests are tagged @e2e and run on demand — never on every save.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: false, // Headed for transparency during development
    viewport: { width: 1440, height: 900 },
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
