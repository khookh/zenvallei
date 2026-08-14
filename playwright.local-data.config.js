import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "local-data.spec.js",
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4191", trace: "retain-on-failure" },
  projects: [
    { name: "local-data-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "local-data-mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/run-local-layer-python.mjs processing/local-layers/tests/create_web_fixture.py && pnpm exec vite --mode local-data --port 4191 --strictPort",
    url: "http://127.0.0.1:4191",
    reuseExistingServer: process.env.GREENWAVE_REUSE_LOCAL_SERVER === "1",
    timeout: 120_000,
    env: {
      GREENWAVE_LOCAL_DATA_ROOT: path.resolve(".cache", "local-layers-test"),
      GREENWAVE_DISABLE_SCENARIO_WORKER: "1",
    },
  },
});
