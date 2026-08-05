import { build, preview } from "vite";

const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4174;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid E2E preview port.");

await build({ logLevel: "warn", mode: "test" });
await preview({
  logLevel: "warn",
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
});
