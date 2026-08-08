import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, ".cache", "local-layers");
const outputRoot = path.join(projectRoot, "public", "data", "official-layers");
const datasetIds = ["jaarbak", "groenkaart", "landgebruik", "landsat-temperature"];
const forbiddenText = /(?:Bearer\s+eyJ|client_secret|[A-Z]:\\Users\\|se=\d{4}-\d{2}-\d{2}T)/i;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJson(file, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (forbiddenText.test(serialized)) throw new Error(`${path.relative(projectRoot, file)} contains private or signed source information.`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serialized, "utf8");
}

function safeRelativeAsset(value, extension) {
  if (typeof value !== "string" || value.includes("..") || path.isAbsolute(value)
    || !value.toLowerCase().endsWith(extension)) {
    throw new Error(`Unsafe generated asset path: ${value}`);
  }
  return value.replaceAll("/", path.sep);
}

async function copyAsset(relative, extension = ".pmtiles") {
  const normalized = safeRelativeAsset(relative, extension);
  const source = path.join(sourceRoot, normalized);
  const destination = path.join(outputRoot, normalized);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function referencedPmtiles(manifest) {
  const variants = [];
  for (const year of Object.values(manifest.years ?? {})) {
    variants.push(...Object.values(year.pmtilesVariants ?? {}));
  }
  for (const observation of Object.values(manifest.observations ?? {})) {
    variants.push(...Object.values(observation.pmtilesVariants ?? {}));
  }
  return [...new Set(variants)];
}

async function publishDataset(datasetId, descriptor) {
  const sourceManifestPath = path.join(sourceRoot, safeRelativeAsset(descriptor.manifestUrl, ".json"));
  const manifest = await readJson(sourceManifestPath);
  if (manifest.datasetId !== datasetId) throw new Error(`${datasetId}: manifest identifier mismatch.`);

  if (datasetId === "landsat-temperature") {
    const allowedIds = new Set((descriptor.timelineItems ?? [])
      .filter((item) => item.kind === "heatwave" && item.status === "available")
      .map((item) => item.value));
    manifest.timelineItems = (manifest.timelineItems ?? []).filter((item) => allowedIds.has(item.value));
    manifest.observations = Object.fromEntries(Object.entries(manifest.observations ?? {})
      .filter(([id]) => allowedIds.has(id))
      .map(([id, observation]) => [id, {
        ...observation,
        queryRaster: `landsat-temperature/query/${id}.tif`,
      }]));
    for (const id of allowedIds) {
      const source = path.join(sourceRoot, "landsat-temperature", "analysis", `${id}.tif`);
      const destination = path.join(outputRoot, "landsat-temperature", "query", `${id}.tif`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
  }

  for (const asset of referencedPmtiles(manifest)) await copyAsset(asset);
  if (manifest.density) {
    await copyAsset(manifest.density.scopeIndexUrl, ".png");
    for (const year of Object.values(manifest.density.years ?? {})) {
      await copyAsset(year.dataUrl, ".tif");
    }
  }
  if (datasetId === "landgebruik") {
    await copyAsset(manifest.agriculturalDetail.geojsonUrl, ".geojson");
  }
  await writeJson(path.join(outputRoot, datasetId, "manifest.json"), manifest);
}

const index = await readJson(path.join(sourceRoot, "index.json"));
if (![2, 3].includes(index.schemaVersion)) throw new Error("The prepared official-layer catalogue must use schema version 2 or 3.");
const missing = datasetIds.filter((id) => !index.datasets?.[id]);
if (missing.length) throw new Error(`Prepared datasets are missing: ${missing.join(", ")}.`);

await fs.rm(outputRoot, { recursive: true, force: true });
const publishedIndex = {
  schemaVersion: 2,
  distribution: "public-static",
  datasets: Object.fromEntries(datasetIds.map((id) => [id, {
    ...index.datasets[id],
    manifestUrl: `${id}/manifest.json`,
    available: true,
  }])),
};
for (const id of datasetIds) await publishDataset(id, publishedIndex.datasets[id]);
await writeJson(path.join(outputRoot, "index.json"), publishedIndex);

const densityBytes = (await Promise.all(
  ["jaarbak", "groenkaart"].flatMap((datasetId) => {
    const descriptor = publishedIndex.datasets[datasetId];
    return descriptor?.density?.availableYears?.map((year) => path.join(
      outputRoot, datasetId, "density", `${datasetId}-${year}-density.tif`,
    )) ?? [];
  }).map(async (file) => (await fs.stat(file)).size),
)).reduce((sum, size) => sum + size, 0);
if (densityBytes > 80 * 1024 * 1024) {
  throw new Error(`Density derivatives exceed the 80 MiB budget (${(densityBytes / 1024 / 1024).toFixed(1)} MiB).`);
}

const files = [];
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target);
    else files.push(target);
  }
}
await collect(outputRoot);
const bytes = (await Promise.all(files.map(async (file) => (await fs.stat(file)).size)))
  .reduce((sum, size) => sum + size, 0);
console.log(`Published ${files.length} browser-ready official-layer assets (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
