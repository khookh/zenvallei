import { build, preview } from "vite";
import fs from "node:fs/promises";
import path from "node:path";

const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4174;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid E2E preview port.");

// Browser tests must not depend on the public OSM tile service. A local,
// deterministic tile also avoids browser-specific routing stalls during map
// startup, while still exercising MapLibre's raster-source lifecycle.
process.env.VITE_TILE_URL = `http://127.0.0.1:${port}/__test-tile.png`;
await build({ logLevel: "warn", mode: "test" });
await fs.writeFile(
  path.resolve("dist/__test-tile.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==", "base64"),
);
await preview({
  logLevel: "warn",
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
});
