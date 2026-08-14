import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { validateApplicationData } from "../src/data-validation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const dataRoot = path.join(publicRoot, "data");

async function readJson(fileName) {
  return JSON.parse(await fs.readFile(path.join(dataRoot, fileName), "utf8"));
}

async function readJsonAsset(file) {
  const contents = await fs.readFile(file);
  return JSON.parse((file.endsWith(".json.gz") ? gunzipSync(contents) : contents).toString("utf8"));
}

function assertSpatialInference(inference, label) {
  const statuses = new Set([
    "available", "insufficient-observations", "undefined-variance", "undefined-spatial-structure",
    "insufficient-distance-classes", "insufficient-effective-sample", "numerical-failure",
  ]);
  if (inference?.method !== "crh-dutilleul-modified-t"
    || inference.hypothesis !== "pearson-r-equals-zero" || inference.sidedness !== "two-sided"
    || inference.distanceClassCount !== 13 || !statuses.has(inference.status)
    || (inference.status === "available" && (!Number.isFinite(inference.pValue)
      || !Number.isFinite(inference.effectiveSampleSize) || inference.effectiveSampleSize < 10))) {
    throw new Error(`${label}: invalid spatial-inference contract.`);
  }
}

function browserAssetPath(assetUrl) {
  if (!assetUrl || /^(?:https?:)?\/\//i.test(assetUrl)) throw new Error(`Expected a local browser asset, received '${assetUrl}'.`);
  return path.join(publicRoot, assetUrl.replace(/^\//, ""));
}

function hasExpectedUrbanSurfaceGroups(manifest) {
  const expected = {
    residential: ["11100", "11210", "11220", "11230", "11240"],
    employmentInstitutional: ["12100"],
  };
  return JSON.stringify(manifest.defaultUrbanSurfaceGroups) === JSON.stringify(Object.keys(expected))
    && manifest.urbanSurfaceGroups?.length === 2
    && Object.entries(expected).every(([id, codes]) => JSON.stringify(
      manifest.urbanSurfaceGroups.find((group) => group.id === id)?.codes,
    ) === JSON.stringify(codes));
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
const expectedOfficialIds = ["groenkaart", "jaarbak", "land-cover-scenario", "landgebruik", "landsat-temperature"];
const expectedComparisonIds = [
  "groenkaart-income", "groenkaart-population", "landsat-groenkaart", "landsat-income",
  "landsat-jaarbak", "landsat-population", "landsat-urban-atlas",
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
  if (datasetId === "land-cover-scenario") {
    if (manifest.schemaVersion !== 7 || manifest.browserRuntime?.protocolVersion !== 1
      || manifest.limits?.submittedAreaHa !== 200 || !manifest.browserRuntime?.xgboost) {
      throw new Error("land-cover-scenario: published browser runtime is incompatible.");
    }
    referencedAssets.push(
      manifest.baselineAreaStatistics.url,
      manifest.analysisWaterMask.url,
      manifest.urbanAtlasClassMaskUrl,
      manifest.browserRuntime.baseline.url,
      manifest.browserRuntime.outputScopes.url,
      manifest.browserRuntime.xgboost.modelUrl,
      manifest.browserRuntime.xgboost.inferenceGridUrl,
    );
  }
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
    if (comparisonId === "landsat-urban-atlas") {
      referencedAssets.push(observation.displayDataUrl, observation.distributionUrl);
    } else if (comparisonId === "landsat-jaarbak") {
      referencedAssets.push(observation.densityPointDataUrl, observation.densityDataUrl, observation.distributionUrl);
    } else if (comparisonId === "landsat-groenkaart") {
      referencedAssets.push(observation.displayDataUrl, observation.pointDataUrl, observation.statisticsUrl);
    } else if (["landsat-income", "landsat-population"].includes(comparisonId)) {
      referencedAssets.push(observation.displayDataUrl, observation.statisticsUrl);
    } else {
      referencedAssets.push(observation.pointDataUrl ?? observation.pixelDataUrl,
        observation.statisticsUrl ?? observation.distributionUrl);
    }
  });
  if (comparisonId === "groenkaart-income") {
    referencedAssets.push(manifest.densityGridUrl, manifest.densityNonGreenUrl, manifest.statisticsUrl,
      manifest.urbanAtlasClassMaskUrl);
    if (manifest.analysisResolutionMeters !== 10 || manifest.greenMapYear !== 2021
      || manifest.urbanAtlasYear !== 2021 || manifest.jaarbakYear !== 2021
      || manifest.incomeYear !== 2023 || manifest.schemaVersion !== 5
      || manifest.statisticWeighting !== "exact-sealed-urban-area") {
      throw new Error(`${comparisonId}: published analytical contract is incompatible.`);
    }
  } else if (comparisonId === "groenkaart-population") {
    referencedAssets.push(manifest.statisticsUrl, manifest.urbanAtlasClassMaskUrl);
    if (manifest.schemaVersion !== 3 || manifest.populationDatasetId !== "flanders-2019"
      || manifest.populationResolutionMeters !== 100 || manifest.minimumEligibleAreaHa !== .1
      || manifest.densityRadiusMeters !== 100 || manifest.maskResolutionMeters !== 1
      || manifest.aggregation !== "exact-masked-area" || !manifest.cellEncoding) {
      throw new Error(`${comparisonId}: published analytical contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-groenkaart") {
    referencedAssets.push(manifest.densityGridUrl, manifest.densityNonGreenUrl, manifest.urbanFabricMaskUrl,
      manifest.urbanAtlasClassMaskUrl);
    if (manifest.schemaVersion !== 7 || manifest.displayResolutionMeters !== 1
      || manifest.maskResolutionMeters !== 1 || manifest.temperatureResolutionMeters !== 30
      || manifest.aggregation !== "exact-masked-area" || manifest.minimumAnalysedAreaHa !== .1
      || JSON.stringify(manifest.defaultUrbanSurfaceGroups) !== JSON.stringify(["residential", "employmentInstitutional"])) {
      throw new Error(`${comparisonId}: published display contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-income") {
    referencedAssets.push(manifest.urbanAtlasClassMaskUrl);
    if (manifest.schemaVersion !== 5 || manifest.displayResolutionMeters !== 1
      || manifest.maskResolutionMeters !== 1 || manifest.temperatureResolutionMeters !== 30
      || manifest.aggregation !== "exact-masked-area" || manifest.minimumAnalysedAreaHa !== .1) {
      throw new Error(`${comparisonId}: published display contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-population") {
    referencedAssets.push(manifest.urbanAtlasClassMaskUrl);
    if (manifest.schemaVersion !== 3 || manifest.populationDatasetId !== "flanders-2019"
      || manifest.populationResolutionMeters !== 100 || manifest.minimumAnalysedAreaHa !== .1
      || manifest.maskResolutionMeters !== 1 || manifest.temperatureResolutionMeters !== 30
      || manifest.aggregation !== "exact-masked-area" || manifest.displayResolutionMeters !== 1) {
      throw new Error(`${comparisonId}: published analytical contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-jaarbak") {
    referencedAssets.push(manifest.analysisScopeIndexUrl);
    if (manifest.schemaVersion !== 4 || manifest.maskResolutionMeters !== 1
      || manifest.temperatureResolutionMeters !== 30 || manifest.aggregation !== "exact-masked-area"
      || manifest.minimumAnalysedAreaHa !== .1 || manifest.classification?.sourceResolutionMetres !== 1
      || manifest.classification?.temperatureResolutionMetres !== 30
      || manifest.classification?.aggregation !== "exact-masked-area"
      || manifest.classification?.minimumAnalysedAreaHa !== .1
      || manifest.densityAnalysis?.radiusMeters !== 100
      || manifest.densityAnalysis?.validCoverageThreshold !== 95
      || manifest.densityAnalysis?.sampling !== "none") {
      throw new Error(`${comparisonId}: published density-analysis contract is incompatible.`);
    }
  } else if (comparisonId === "landsat-urban-atlas") {
    referencedAssets.push(manifest.urbanAtlasClassMaskUrl);
    if (manifest.schemaVersion !== 3 || manifest.maskResolutionMeters !== 1
      || manifest.temperatureResolutionMeters !== 30 || manifest.aggregation !== "exact-masked-area"
      || manifest.minimumAnalysedAreaHa !== .1 || !manifest.urbanAtlasClassIndexes
      || Object.values(manifest.observations).some(({ displayDataUrl }) => !displayDataUrl)) {
      throw new Error(`${comparisonId}: published exact-mask contract is incompatible.`);
    }
  }
  if (["groenkaart-income", "groenkaart-population", "landsat-groenkaart", "landsat-income", "landsat-population"]
    .includes(comparisonId) && !hasExpectedUrbanSurfaceGroups(manifest)) {
    throw new Error(`${comparisonId}: Urban Atlas surface groups or defaults are incompatible.`);
  }
  if (["landsat-groenkaart", "landsat-income", "landsat-population"].includes(comparisonId)
    && (manifest.analysisResolutionMeters !== 30 || manifest.urbanAtlasYear !== 2021)) {
    throw new Error(`${comparisonId}: published Landsat contract is incompatible.`);
  }
  if (comparisonId === "landsat-groenkaart"
    && Object.values(manifest.observations).some(({ displayDataUrl, pointDataUrl }) => displayDataUrl === pointDataUrl)) {
    throw new Error("landsat-groenkaart: display status must be independent from graph eligibility.");
  }
  if (comparisonId === "landsat-income") {
    for (const observation of Object.values(manifest.observations)) {
      const statistics = await readJsonAsset(path.join(officialRoot, observation.statisticsUrl));
      if (statistics.schemaVersion !== 4) throw new Error("landsat-income: unsupported statistics schema.");
      const sectors = Object.values(statistics.sectorStats ?? {});
      if (!sectors.some(({ analysedAreaHa }) => analysedAreaHa >= manifest.minimumAnalysedAreaHa)
        || sectors.some((record) => Object.hasOwn(record, "meanDensityByGreenClass"))) {
        throw new Error("landsat-income: sector temperatures must not depend on Green Map coverage.");
      }
      Object.values(statistics.regressionsBySurface ?? {}).forEach((byScope) => Object.values(byScope)
        .filter(Boolean).forEach(({ inference }) => assertSpatialInference(inference, "landsat-income")));
    }
  } else if (comparisonId === "landsat-groenkaart") {
    const expected = 3 * 15 * (1 + Object.keys(manifest.municipalityIndexes).length
      + Object.keys(manifest.sectorIndexes).length);
    for (const observation of Object.values(manifest.observations)) {
      const statistics = await readJsonAsset(path.join(officialRoot, observation.statisticsUrl));
      const records = Object.values(statistics.inferenceBySurface ?? {}).flatMap((byGreen) => (
        Object.values(byGreen).flatMap((byScope) => Object.values(byScope))
      ));
      if (statistics.schemaVersion !== 3 || records.length !== expected) {
        throw new Error("landsat-groenkaart: incomplete selector/scope inference matrix.");
      }
      records.forEach((inference) => assertSpatialInference(inference, "landsat-groenkaart"));
    }
  } else if (comparisonId === "groenkaart-income") {
    const statistics = await readJsonAsset(path.join(officialRoot, manifest.statisticsUrl));
    const regressions = Object.values(statistics.regressionsBySurface ?? {}).flatMap((byGreen) => (
      Object.values(byGreen).flatMap((byScope) => Object.values(byScope))
    )).filter(Boolean);
    if (statistics.schemaVersion !== 4 || regressions.length !== 3 * 15 * 8) {
      throw new Error("groenkaart-income: incomplete selector/scope regression matrix.");
    }
    regressions.forEach(({ inference }) => assertSpatialInference(inference, "groenkaart-income"));
  } else if (comparisonId === "landsat-jaarbak") {
    for (const observation of Object.values(manifest.observations)) {
      const distribution = await readJsonAsset(path.join(officialRoot, observation.distributionUrl));
      const regressions = Object.values(distribution.densityAnalysis ?? {}).filter(Boolean);
      if (distribution.schemaVersion !== 4 || regressions.length !== 162) {
        throw new Error("landsat-jaarbak: incomplete spatial density analysis.");
      }
      regressions.forEach(({ inference }) => assertSpatialInference(inference, "landsat-jaarbak"));
    }
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

console.log(`Validated ${sectorIds.size} sectors, nine application layers and all prepared browser assets.`);
