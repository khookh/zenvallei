import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "pages.smoke.js",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4181/zenvallei/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve-pages-e2e.mjs --port 4181",
    url: "http://127.0.0.1:4181/zenvallei/",
    reuseExistingServer: process.env.GREENWAVE_REUSE_PAGES_SERVER === "1",
    timeout: 120_000,
  },
  projects: [
    { name: "pages-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "pages-mobile", use: { ...devices["Pixel 7"] } },
  ],
});
