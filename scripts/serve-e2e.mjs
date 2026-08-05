import { build, preview } from "vite";

await build({ logLevel: "warn", mode: "test" });
await preview({
  logLevel: "warn",
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
