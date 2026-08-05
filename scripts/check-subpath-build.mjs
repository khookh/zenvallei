import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(projectRoot, ".cache", "subpath-build");
const html = await fs.readFile(path.join(buildRoot, "index.html"), "utf8");
if (!html.includes('/greenwave/assets/')) throw new Error("Subpath build does not reference /greenwave/assets/.");
if (/\b(?:src|href)=["']\/assets\//.test(html)) throw new Error("Subpath build contains a root-relative asset URL.");
const mainAsset = /src=["']([^"']+\/assets\/[^"']+\.js)["']/.exec(html)?.[1];
if (!mainAsset) throw new Error("Could not locate the subpath JavaScript bundle.");
const script = await fs.readFile(path.join(buildRoot, mainAsset.replace(/^\/greenwave\//, "")), "utf8");
if (!script.includes("/greenwave/")) throw new Error("Runtime data URLs do not contain the configured Vite base path.");
console.log("Subpath build uses /greenwave/ for application and data assets.");
