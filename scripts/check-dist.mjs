import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const textExtensions = new Set([".css", ".geojson", ".html", ".js", ".json", ".map", ".txt"]);
const forbiddenPatterns = [
  { label: "access token", pattern: /Bearer\s+eyJ[A-Za-z0-9_-]+\./i },
  { label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "local Windows user path", pattern: /[A-Z]:\\Users\\[^\\\s]+/i },
  { label: "client secret", pattern: /client_secret\s*[=:]\s*["'][^"']+/i },
];
const forbiddenSecretFile = /(?:^|\/)(?:git_passphrase\.txt|credentials?\.(?:json|txt)|passphrases?\.(?:json|txt)|secrets?\.env)$/i;
const forbiddenExperimentalAsset = /(?:^|\/)(?:__playground__|notebook-test)(?:\/|$)|(?:^|\/)test(?:-[a-z0-9-]+)?\.png$/i;
const permittedOfficialAsset = /(?:^|\/)data\/(?:official-layers\/(?:[a-z0-9/_-]+\.(?:geojson|json|pmtiles|tif))|population\/population-density-2019\.tif)$/i;
const forbiddenLocalDataAsset = /(?:^|\/)__local-data__(?:\/|$)|(?:^|\/)\.cache(?:\/|$)/i;
const retiredPublicAsset = /(?:^|\/)data\/(?:land-cover(?:\.json|\/)|vegetation(?:\.json|\/))/i;

async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }))).flat();
}

const files = await filesBelow(distRoot);
for (const file of files) {
  const relativePath = path.relative(distRoot, file).replaceAll("\\", "/");
  if (forbiddenSecretFile.test(relativePath)) throw new Error(`${relativePath} is a forbidden secret filename.`);
  if (forbiddenExperimentalAsset.test(relativePath)) throw new Error(`${relativePath} is a local notebook export and must not be distributed.`);
  if (forbiddenLocalDataAsset.test(relativePath)) throw new Error(`${relativePath} references a private preparation cache.`);
  if (/\.(?:pmtiles|tif)$/i.test(relativePath) && !permittedOfficialAsset.test(relativePath)) {
    throw new Error(`${relativePath} is an unapproved binary data asset.`);
  }
  if (retiredPublicAsset.test(relativePath)) throw new Error(`${relativePath} belongs to a retired public layer.`);
}
for (const file of files.filter((entry) => textExtensions.has(path.extname(entry)))) {
  const contents = await fs.readFile(file, "utf8");
  forbiddenPatterns.forEach(({ label, pattern }) => {
    if (pattern.test(contents)) throw new Error(`${path.relative(distRoot, file)} contains a forbidden ${label}.`);
  });
  if (path.extname(file) === ".html" && /<script[^>]+src=["']https?:/i.test(contents)) {
    throw new Error(`${path.relative(distRoot, file)} loads an unexpected external script.`);
  }
  if (/\/__local-data(?:-query)?__\//.test(contents)) throw new Error(`${path.relative(distRoot, file)} references a local-data endpoint.`);
}

const budget = async (relativePath, maximumBytes) => {
  const stats = await fs.stat(path.join(distRoot, relativePath));
  if (stats.size > maximumBytes) throw new Error(`${relativePath} is ${stats.size} bytes; budget is ${maximumBytes}.`);
};
const assetFiles = files.filter((file) => file.includes(`${path.sep}assets${path.sep}`));
const mainJavaScript = assetFiles.find((file) => path.extname(file) === ".js" && !file.includes("maplibre-gl-worker"));
const workerJavaScript = assetFiles.find((file) => file.includes("maplibre-gl-worker") && path.extname(file) === ".js");
const stylesheet = assetFiles.find((file) => path.extname(file) === ".css");
if (!mainJavaScript || !workerJavaScript || !stylesheet) throw new Error("Expected built JavaScript, MapLibre worker and CSS assets.");
if ((await fs.stat(mainJavaScript)).size > 1_250_000) throw new Error("Initial JavaScript exceeded the 1.25 MB raw budget.");
if ((await fs.stat(workerJavaScript)).size > 550_000) throw new Error("MapLibre worker exceeded the 550 KB raw budget.");
if ((await fs.stat(stylesheet)).size > 150_000) throw new Error("Stylesheet exceeded the 150 KB raw budget.");
await budget("data/urban-atlas.geojson", 25_000_000);
const officialBytes = (await Promise.all(files
  .filter((file) => file.includes(`${path.sep}data${path.sep}official-layers${path.sep}`))
  .map(async (file) => (await fs.stat(file)).size))).reduce((sum, size) => sum + size, 0);
if (officialBytes > 550 * 1024 * 1024) throw new Error(`Published official layers exceed the 550 MiB budget (${officialBytes} bytes).`);
console.log("Distribution contains no detected secrets or external scripts and remains within asset budgets.");
