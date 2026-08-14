import { build, preview } from "vite";
import path from "node:path";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4182;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid playground preview port.");

process.env.GREENWAVE_PLAYGROUND_WEB_ROOT ||= path.resolve(".cache", "playground-map-test");
process.env.VITE_TILE_URL = `http://127.0.0.1:${port}/__playground__/test.png`;
process.env.VITE_E2E_DEBUG = "1";
await import("./prepare-playground-map-fixture.mjs");
await build({ logLevel: "warn", mode: "playground" });
await preview({
  logLevel: "warn",
  mode: "playground",
  preview: { host: "127.0.0.1", port, strictPort: true },
});
