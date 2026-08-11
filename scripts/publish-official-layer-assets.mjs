import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, ".cache", "local-layers");
const outputRoot = path.join(projectRoot, "public", "data", "official-layers");
const datasetIds = ["jaarbak", "groenkaart", "landgebruik", "landsat-temperature"];
const comparisonIds = [
  "landsat-urban-atlas", "landsat-jaarbak", "landsat-groenkaart",
  "groenkaart-income", "landsat-income",
  "groenkaart-population",
  "landsat-population",
];
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

async function publishComparison(comparisonId, descriptor) {
  const sourceManifestPath = path.join(sourceRoot, safeRelativeAsset(descriptor.manifestUrl, ".json"));
  const manifest = await readJson(sourceManifestPath);
  if (manifest.comparisonId !== comparisonId) throw new Error(`${comparisonId}: manifest identifier mismatch.`);

  if (comparisonId === "groenkaart-income") {
    await copyAsset(manifest.densityGridUrl, ".png");
    await copyAsset(manifest.densityNonGreenUrl, ".png");
    await copyAsset(manifest.scopeIndexUrl, ".png");
    await copyAsset(manifest.statisticsUrl, ".json");
    await copyAsset(manifest.urbanAtlasClassMaskUrl, ".pmtiles");
  } else if (comparisonId === "groenkaart-population") {
    await copyAsset(manifest.statisticsUrl, ".json");
    await copyAsset(manifest.urbanAtlasClassMaskUrl, ".pmtiles");
  } else if (comparisonId === "landsat-groenkaart") {
    await copyAsset(manifest.densityGridUrl, ".png");
    await copyAsset(manifest.densityNonGreenUrl, ".png");
    await copyAsset(manifest.scopeIndexUrl, ".png");
    await copyAsset(manifest.urbanFabricMaskUrl, ".pmtiles");
    await copyAsset(manifest.urbanAtlasClassMaskUrl, ".pmtiles");
  } else if (["landsat-income", "landsat-population"].includes(comparisonId)) {
    await copyAsset(manifest.urbanAtlasClassMaskUrl, ".pmtiles");
  } else if (comparisonId === "landsat-jaarbak") {
    await copyAsset(manifest.scopeIndexUrl, ".png");
    await copyAsset(manifest.analysisScopeIndexUrl, ".png");
  } else if (manifest.scopeIndexUrl) {
    await copyAsset(manifest.scopeIndexUrl, ".png");
  }
  if (comparisonId === "landsat-urban-atlas") {
    await copyAsset(manifest.urbanAtlasClassMaskUrl, ".pmtiles");
  }
  for (const observation of Object.values(manifest.observations ?? {})) {
    if (comparisonId === "landsat-urban-atlas") {
      await copyAsset(observation.displayDataUrl, ".png");
    } else if (comparisonId === "landsat-jaarbak") {
      await copyAsset(observation.densityPointDataUrl, ".png");
      await copyAsset(observation.densityDataUrl, ".png");
    } else if (comparisonId === "landsat-groenkaart") {
      await copyAsset(observation.displayDataUrl, ".png");
      await copyAsset(observation.pointDataUrl, ".json.gz");
    } else if (["landsat-income", "landsat-population"].includes(comparisonId)) {
      await copyAsset(observation.displayDataUrl, ".png");
    } else {
      await copyAsset(observation.pointDataUrl ?? observation.pixelDataUrl, ".png");
    }
    await copyAsset(observation.statisticsUrl ?? observation.distributionUrl,
      ["landsat-urban-atlas", "landsat-population"].includes(comparisonId) ? ".json.gz" : ".json");
  }
  await writeJson(path.join(outputRoot, comparisonId, "manifest.json"), manifest);
}

const index = await readJson(path.join(sourceRoot, "index.json"));
if (![2, 3].includes(index.schemaVersion)) throw new Error("The prepared official-layer catalogue must use schema version 2 or 3.");
const missing = datasetIds.filter((id) => !index.datasets?.[id]);
if (missing.length) throw new Error(`Prepared datasets are missing: ${missing.join(", ")}.`);
const missingComparisons = comparisonIds.filter((id) => !index.comparisons?.[id]);
if (missingComparisons.length) throw new Error(`Prepared comparisons are missing: ${missingComparisons.join(", ")}.`);

await fs.rm(outputRoot, { recursive: true, force: true });
const publishedIndex = {
  schemaVersion: 3,
  distribution: "public-static",
  datasets: Object.fromEntries(datasetIds.map((id) => [id, {
    ...index.datasets[id],
    manifestUrl: `${id}/manifest.json`,
    available: true,
  }])),
  comparisons: Object.fromEntries(comparisonIds.map((id) => [id, {
    ...index.comparisons[id],
    manifestUrl: `${id}/manifest.json`,
    available: true,
  }])),
};
for (const id of datasetIds) await publishDataset(id, publishedIndex.datasets[id]);
for (const id of comparisonIds) await publishComparison(id, publishedIndex.comparisons[id]);
await writeJson(path.join(outputRoot, "index.json"), publishedIndex);

const comparisonBytes = (await Promise.all(comparisonIds.map(async (comparisonId) => {
  const comparisonRoot = path.join(outputRoot, comparisonId);
  const entries = [];
  async function collectComparison(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectComparison(target);
      else entries.push(target);
    }
  }
  await collectComparison(comparisonRoot);
  return (await Promise.all(entries.map(async (file) => (await fs.stat(file)).size)))
    .reduce((sum, size) => sum + size, 0);
}))).reduce((sum, size) => sum + size, 0);
// Nine public comparisons, including the lossless population-cell indexes,
// currently require 34.2 MiB. Keep a narrow independent ceiling as well as
// the stricter 550 MiB complete-bundle ceiling below.
if (comparisonBytes > 36 * 1024 * 1024) {
  throw new Error(`Comparison derivatives exceed the 36 MiB budget (${(comparisonBytes / 1024 / 1024).toFixed(1)} MiB).`);
}

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
if (bytes > 550 * 1024 * 1024) {
  throw new Error(`Official browser bundle exceeds the 550 MiB budget (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
}
console.log(`Published ${files.length} browser-ready official-layer assets (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
