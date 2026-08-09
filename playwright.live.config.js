import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "live-pages.smoke.js",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.LIVE_PAGES_URL ?? "https://khookh.github.io/zenvallei/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "live-pages", use: { ...devices["Desktop Chrome"] } }],
});
