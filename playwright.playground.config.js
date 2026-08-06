import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const fixtureRoot = path.resolve(".cache", "playground-map-test");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "playground.spec.js",
  timeout: 45_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4182", trace: "retain-on-failure" },
  projects: [{ name: "playground-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/prepare-playground-map-fixture.mjs && pnpm exec vite --mode playground --port 4182 --strictPort",
    url: "http://127.0.0.1:4182",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { GREENWAVE_PLAYGROUND_WEB_ROOT: fixtureRoot },
  },
});
