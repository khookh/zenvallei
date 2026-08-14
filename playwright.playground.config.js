import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const fixtureRoot = path.resolve(".cache", "playground-map-test");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "playground.spec.js",
  // Cold Windows Vite and MapLibre startup can approach one minute in this
  // isolated notebook mode. Public startup has a separate strict performance
  // gate; this developer-only smoke test still fails immediately on errors.
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4182", trace: "retain-on-failure" },
  projects: [{ name: "playground-chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/serve-playground-e2e.mjs --port 4182",
    url: "http://127.0.0.1:4182",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { GREENWAVE_PLAYGROUND_WEB_ROOT: fixtureRoot },
  },
});
