import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateApplicationData } from "../src/data-validation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const dataRoot = path.join(publicRoot, "data");

async function readJson(fileName) {
  return JSON.parse(await fs.readFile(path.join(dataRoot, fileName), "utf8"));
}

function browserAssetPath(assetUrl) {
  if (!assetUrl || /^(?:https?:)?\/\//i.test(assetUrl)) throw new Error(`Expected a local browser asset, received '${assetUrl}'.`);
  return path.join(publicRoot, assetUrl.replace(/^\//, ""));
}

const [geojson, scorePayload, methodology, provenance, urbanAtlas, income] = await Promise.all([
  readJson("sectors.geojson"),
  readJson("scores.json"),
  readJson("methodology.json"),
  readJson("provenance.json"),
  readJson("urban-atlas.json"),
  readJson("income.json"),
]);

const { sectorIds } = validateApplicationData({
  geojson,
  scorePayload,
  methodology,
  provenance,
  urbanAtlas,
  income,
});

if (sectorIds.size !== 154) throw new Error(`Expected 154 Zennevallei sectors, received ${sectorIds.size}.`);
for (const [name, stats] of [["Urban Atlas", urbanAtlas.sectorStats]]) {
  const ids = Object.keys(stats ?? {});
  if (ids.length !== sectorIds.size || ids.some((sectorId) => !sectorIds.has(sectorId))) {
    throw new Error(`${name} statistics do not match the 154 sector identifiers.`);
  }
}

for (const year of income.availableYears) {
  const stats = income.years[year].sectorStats;
  const available = Object.values(stats).filter(({ sourceStatus }) => sourceStatus === "available").length;
  const matched = Object.values(stats).filter(({ sourceStatus }) => sourceStatus !== "sector-unmatched").length;
  if (available !== 141 || matched !== 150) {
    throw new Error(`Statbel income ${year} expected 141 medians and 150 joins; received ${available} and ${matched}.`);
  }
}

await fs.access(browserAssetPath(urbanAtlas.geojsonUrl));

const officialRoot = path.join(dataRoot, "official-layers");
const officialIndex = JSON.parse(await fs.readFile(path.join(officialRoot, "index.json"), "utf8"));
const officialIds = Object.keys(officialIndex.datasets ?? {});
const expectedOfficialIds = ["groenkaart", "jaarbak", "landgebruik", "landsat-temperature"];
if (officialIndex.schemaVersion !== 2
  || JSON.stringify(officialIds.sort()) !== JSON.stringify(expectedOfficialIds)) {
  throw new Error(`Published official-layer catalogue is incomplete: ${officialIds.join(", ")}.`);
}
for (const datasetId of officialIds) {
  const descriptor = officialIndex.datasets[datasetId];
  const manifestPath = path.join(officialRoot, descriptor.manifestUrl);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.datasetId !== datasetId) throw new Error(`${datasetId}: published manifest identifier mismatch.`);
  const referencedAssets = [];
  Object.values(manifest.years ?? {}).forEach((year) => referencedAssets.push(...Object.values(year.pmtilesVariants ?? {})));
  Object.values(manifest.observations ?? {}).forEach((observation) => {
    referencedAssets.push(...Object.values(observation.pmtilesVariants ?? {}));
    if (observation.queryRaster) referencedAssets.push(observation.queryRaster);
  });
  if (manifest.agriculturalDetail?.geojsonUrl) referencedAssets.push(manifest.agriculturalDetail.geojsonUrl);
  for (const asset of referencedAssets) {
    if (typeof asset !== "string" || asset.includes("..") || path.isAbsolute(asset)) {
      throw new Error(`${datasetId}: invalid published asset path '${asset}'.`);
    }
    await fs.access(path.join(officialRoot, asset));
  }
}
const landsat = JSON.parse(await fs.readFile(path.join(officialRoot, "landsat-temperature", "manifest.json"), "utf8"));
if (landsat.timelineItems.some(({ kind, value }) => kind !== "heatwave" || value === "landsat-2020-08-16")) {
  throw new Error("Published Landsat timeline contains a reference or withdrawn 16 August 2020 observation.");
}
if (landsat.timelineItems.length !== 8 || Object.keys(landsat.observations).length !== 8) {
  throw new Error("Published Landsat timeline must contain the eight approved heatwave observations.");
}

console.log(`Validated ${sectorIds.size} sectors, seven application layers and all prepared browser assets.`);
