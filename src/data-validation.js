// @ts-check

const SUPPORTED_SCHEMA_VERSIONS = Object.freeze({
  scores: [1],
  methodology: [1],
  provenance: [1],
  urbanAtlas: [1],
  income: [1],
});

export function schemaVersionOf(payload) {
  return Number.isInteger(payload?.schemaVersion) ? payload.schemaVersion : 1;
}

export function assertSupportedSchema(name, payload) {
  const supported = SUPPORTED_SCHEMA_VERSIONS[name];
  if (!supported) throw new Error(`Unknown data contract '${name}'.`);
  const version = schemaVersionOf(payload);
  if (!supported.includes(version)) {
    throw new Error(`${name}.json uses unsupported schema version ${version}; expected ${supported.join(" or ")}.`);
  }
  return version;
}

function assertFeatureCollection(geojson) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) {
    throw new Error("sectors.geojson is not a non-empty FeatureCollection.");
  }
  const sectorIds = new Set();
  geojson.features.forEach((feature, index) => {
    if (feature?.geometry?.type !== "MultiPolygon" || !feature.geometry.coordinates?.length) {
      throw new Error(`sectors.geojson feature ${index} is not a non-empty MultiPolygon.`);
    }
    const sectorId = feature.properties?.sectorId;
    if (!sectorId) throw new Error(`sectors.geojson feature ${index} has no sectorId.`);
    if (sectorIds.has(sectorId)) throw new Error(`sectors.geojson contains duplicate sectorId '${sectorId}'.`);
    sectorIds.add(sectorId);
  });
  return sectorIds;
}

/** Validate contracts at the browser boundary before MapLibre receives data. */
export function validateApplicationData({ geojson, scorePayload, methodology, provenance, urbanAtlas, income }) {
  assertSupportedSchema("scores", scorePayload);
  assertSupportedSchema("methodology", methodology);
  assertSupportedSchema("provenance", provenance);
  if (urbanAtlas && !urbanAtlas.loadError) assertSupportedSchema("urbanAtlas", urbanAtlas);
  assertSupportedSchema("income", income);

  const sectorIds = assertFeatureCollection(geojson);
  const scores = scorePayload?.sectors;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new Error("scores.json does not contain a sectors object.");
  }
  const scoreIds = Object.keys(scores);
  if (scoreIds.length !== sectorIds.size || scoreIds.some((sectorId) => !sectorIds.has(sectorId))) {
    throw new Error(`Score and geometry sector identifiers differ (${scoreIds.length} scores, ${sectorIds.size} geometries).`);
  }
  if (!methodology?.palette || !Array.isArray(methodology.vulnerabilityComponents)) {
    throw new Error("methodology.json is missing its palette or vulnerability components.");
  }
  if (provenance?.output?.sectorCount !== sectorIds.size) {
    throw new Error(`provenance.json reports ${provenance?.output?.sectorCount ?? "no"} sectors; ${sectorIds.size} were loaded.`);
  }
  if (urbanAtlas?.available && (!urbanAtlas.geojsonUrl || !urbanAtlas.sectorStats)) {
    throw new Error("urban-atlas.json marks the layer available but lacks its GeoJSON URL or sector statistics.");
  }
  if (income?.datasetId !== "statbel-income"
    || JSON.stringify(income.availableYears) !== JSON.stringify([2019, 2020, 2021, 2022, 2023])
    || income.defaultYear !== 2023 || income.bands?.length !== 7) {
    throw new Error("income.json does not contain the supported 2019-2023 Statbel contract.");
  }
  income.availableYears.forEach((year) => {
    const stats = income.years?.[year]?.sectorStats;
    const ids = Object.keys(stats ?? {});
    if (ids.length !== sectorIds.size || ids.some((sectorId) => !sectorIds.has(sectorId))) {
      throw new Error(`income.json ${year} statistics do not match the sector geometry.`);
    }
    ids.forEach((sectorId) => {
      const record = stats[sectorId];
      if (!["available", "not-published", "sector-unmatched"].includes(record?.sourceStatus)
        || (record.medianNetTaxableIncome !== null && !Number.isFinite(record.medianNetTaxableIncome))) {
        throw new Error(`income.json ${year} contains an invalid record for '${sectorId}'.`);
      }
    });
  });
  return { sectorIds, scores };
}
