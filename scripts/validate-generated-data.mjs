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

const [geojson, scorePayload, methodology, provenance, urbanAtlas, income, population] = await Promise.all([
  readJson("sectors.geojson"),
  readJson("scores.json"),
  readJson("methodology.json"),
  readJson("provenance.json"),
  readJson("urban-atlas.json"),
  readJson("income.json"),
  readJson("population.json"),
]);

const { sectorIds } = validateApplicationData({
  geojson,
  scorePayload,
  methodology,
  provenance,
  urbanAtlas,
  income,
  population,
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

for (const datasetId of population.availableDatasets) {
  const dataset = population.datasets[datasetId];
  const records = Object.values(dataset.sectorStats);
  if (records.length !== 154 || records.some(({ sourceStatus, population: value, areaHa, densityPerHa }) => (
    sourceStatus !== "available" || !Number.isFinite(value) || !Number.isFinite(areaHa) || !Number.isFinite(densityPerHa)
  ))) {
    throw new Error(`${datasetId}: population statistics are incomplete or invalid.`);
  }
  const municipalityPopulation = Object.values(dataset.municipalityStats)
    .reduce((sum, record) => sum + record.population, 0);
  if (municipalityPopulation !== dataset.regionStats.population) {
    throw new Error(`${datasetId}: municipality population does not reconcile with Zennevallei.`);
  }
}

await fs.access(browserAssetPath(population.datasets["statbel-2025"].mapUrl));
await fs.access(browserAssetPath(population.datasets["flanders-2019"].analyticalUrl));
await Promise.all(Object.values(population.datasets["flanders-2019"].imageVariants)
  .map((asset) => fs.access(browserAssetPath(asset))));

await fs.access(browserAssetPath(urbanAtlas.geojsonUrl));

const officialRoot = path.join(dataRoot, "official-layers");
const officialIndex = JSON.parse(await fs.readFile(path.join(officialRoot, "index.json"), "utf8"));
const officialIds = Object.keys(officialIndex.datasets ?? {});
const expectedOfficialIds = ["groenkaart", "jaarbak", "landgebruik", "landsat-temperature"];
const expectedComparisonIds = [
  "groenkaart-income", "landsat-groenkaart", "landsat-income",
  "landsat-jaarbak", "landsat-urban-atlas",
];
const comparisonIds = Object.keys(officialIndex.comparisons ?? {}).sort();
if (officialIndex.schemaVersion !== 3
  || JSON.stringify(officialIds.sort()) !== JSON.stringify(expectedOfficialIds)) {
  throw new Error(`Published official-layer catalogue is incomplete: ${officialIds.join(", ")}.`);
}
if (JSON.stringify(comparisonIds) !== JSON.stringify(expectedComparisonIds)) {
  throw new Error(`Published comparison catalogue is incomplete: ${comparisonIds.join(", ")}.`);
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
  if (manifest.density) {
    if (manifest.density.radiusMeters !== 100 || manifest.density.denominator !== "complete-circle"
      || manifest.density.analysisResolutionMeters !== 10 || manifest.density.validCoverageThreshold !== 95) {
      throw new Error(`${datasetId}: published density contract is incompatible.`);
    }
    referencedAssets.push(manifest.density.scopeIndexUrl);
    referencedAssets.push(...Object.values(manifest.density.years ?? {}).map(({ dataUrl }) => dataUrl));
  }
  for (const asset of referencedAssets) {
    if (typeof asset !== "string" || asset.includes("..") || path.isAbsolute(asset)) {
      throw new Error(`${datasetId}: invalid published asset path '${asset}'.`);
    }
    await fs.access(path.join(officialRoot, asset));
  }
}
for (const comparisonId of comparisonIds) {
  const descriptor = officialIndex.comparisons[comparisonId];
  const manifest = JSON.parse(await fs.readFile(path.join(officialRoot, descriptor.manifestUrl), "utf8"));
  if (manifest.comparisonId !== comparisonId) throw new Error(`${comparisonId}: published manifest identifier mismatch.`);
  const referencedAssets = [manifest.scopeIndexUrl].filter(Boolean);
  Object.values(manifest.observations ?? {}).forEach((observation) => {
    referencedAssets.push(
      observation.pointDataUrl ?? observation.pixelDataUrl,
      observation.statisticsUrl ?? observation.distributionUrl,
    );
  });
  if (comparisonId === "groenkaart-income") {
    referencedAssets.push(manifest.densityGridUrl, manifest.densityNonGreenUrl, manifest.statisticsUrl);
    if (manifest.analysisResolutionMeters !== 10 || manifest.greenMapYear !== 2021
      || manifest.urbanAtlasYear !== 2021 || manifest.jaarbakYear !== 2021
      || manifest.incomeYear !== 2023) {
      throw new Error(`${comparisonId}: published analytical contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-groenkaart") {
    referencedAssets.push(manifest.densityGridUrl, manifest.densityNonGreenUrl);
  }
  if (["landsat-groenkaart", "landsat-income"].includes(comparisonId)
    && (manifest.analysisResolutionMeters !== 30 || manifest.urbanAtlasYear !== 2021)) {
    throw new Error(`${comparisonId}: published Landsat contract is incompatible.`);
  }
  for (const asset of referencedAssets) {
    if (typeof asset !== "string" || asset.includes("..") || path.isAbsolute(asset)) {
      throw new Error(`${comparisonId}: invalid published asset path '${asset}'.`);
    }
    await fs.access(path.join(officialRoot, asset));
  }
}
const landsat = JSON.parse(await fs.readFile(path.join(officialRoot, "landsat-temperature", "manifest.json"), "utf8"));
if (landsat.timelineItems.some(({ kind, value }) => kind !== "heatwave" || value === "landsat-2020-08-16")) {
  throw new Error("Published Landsat timeline contains a reference or withdrawn 16 August 2020 observation.");
}
const expectedLandsatObservations = [
  "landsat-2020-08-07",
  "landsat-2022-08-14",
  "landsat-2023-06-13",
  "landsat-2023-09-09",
  "landsat-2025-08-13",
  "landsat-2026-06-22",
];
const publishedLandsatObservations = landsat.timelineItems.map(({ value }) => value);
if (JSON.stringify(publishedLandsatObservations) !== JSON.stringify(expectedLandsatObservations)
  || JSON.stringify(Object.keys(landsat.observations)) !== JSON.stringify(expectedLandsatObservations)) {
  throw new Error(`Published Landsat timeline must contain the six clearest approved heatwave observations: ${publishedLandsatObservations.join(", ")}.`);
}

console.log(`Validated ${sectorIds.size} sectors, eight application layers and all prepared browser assets.`);
