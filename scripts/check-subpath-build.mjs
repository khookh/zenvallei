import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const configuredRoot = argument("--root", ".cache/subpath-build");
const configuredBase = argument("--base", "/zenvallei/");
if (!configuredBase.startsWith("/") || !configuredBase.endsWith("/")) {
  throw new Error("The expected base must start and end with '/'.");
}
const buildRoot = path.resolve(projectRoot, configuredRoot);
const html = await fs.readFile(path.join(buildRoot, "index.html"), "utf8");
if (!html.includes(`${configuredBase}assets/`)) throw new Error(`Subpath build does not reference ${configuredBase}assets/.`);
if (/\b(?:src|href)=["']\/assets\//.test(html)) throw new Error("Subpath build contains a root-relative asset URL.");
const mainAsset = /src=["']([^"']+\/assets\/[^"']+\.js)["']/.exec(html)?.[1];
if (!mainAsset) throw new Error("Could not locate the subpath JavaScript bundle.");
const relativeAsset = mainAsset.startsWith(configuredBase) ? mainAsset.slice(configuredBase.length) : mainAsset.replace(/^\//, "");
const script = await fs.readFile(path.join(buildRoot, relativeAsset), "utf8");
if (!script.includes(configuredBase)) throw new Error("Runtime data URLs do not contain the configured Vite base path.");
for (const expected of ["sectors.geojson", "scores.json", "urban-atlas.json"]) {
  if (!script.includes(expected)) throw new Error(`Runtime bundle does not reference ${expected}.`);
}
console.log(`Subpath build uses ${configuredBase} for application and data assets.`);
