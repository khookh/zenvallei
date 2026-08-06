// @ts-check

const SUPPORTED_SCHEMA_VERSIONS = Object.freeze({
  scores: [1],
  methodology: [1],
  provenance: [1],
  landCover: [1, 2],
  urbanAtlas: [1],
  vegetation: [1, 2, 3, 4],
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
export function validateApplicationData({ geojson, scorePayload, methodology, provenance, landCover, urbanAtlas, vegetation }) {
  assertSupportedSchema("scores", scorePayload);
  assertSupportedSchema("methodology", methodology);
  assertSupportedSchema("provenance", provenance);
  if (landCover) assertSupportedSchema("landCover", landCover);
  if (urbanAtlas && !urbanAtlas.loadError) assertSupportedSchema("urbanAtlas", urbanAtlas);
  if (vegetation && !vegetation.loadError) assertSupportedSchema("vegetation", vegetation);

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
  if (landCover?.raster?.available && (!landCover.raster.imageUrl || !Array.isArray(landCover.raster.coordinates))) {
    throw new Error("land-cover.json marks its raster available but has no image URL or coordinates.");
  }
  if (urbanAtlas?.available && (!urbanAtlas.geojsonUrl || !urbanAtlas.sectorStats)) {
    throw new Error("urban-atlas.json marks the layer available but lacks its GeoJSON URL or sector statistics.");
  }
  if (vegetation?.available) {
    if (schemaVersionOf(vegetation) >= 4 && vegetation.definitions?.headlineDenominator !== "complete-statbel-sector-area") {
      throw new Error("vegetation.json schema version 4 must use the complete Statbel sector area denominator.");
    }
    const activeYear = vegetation.years?.[vegetation.activeYear];
    if (!activeYear?.imageUrl || !Array.isArray(activeYear.coordinates) || !Number.isFinite(activeYear.threshold)) {
      throw new Error("vegetation.json marks the layer available but lacks its image, coordinates or threshold.");
    }
    if (Object.keys(activeYear.sectorStats ?? {}).length !== sectorIds.size) {
      throw new Error(`vegetation.json contains ${Object.keys(activeYear.sectorStats ?? {}).length} sector records; expected ${sectorIds.size}.`);
    }
    const availableYears = Array.isArray(vegetation.availableYears)
      ? vegetation.availableYears
      : [vegetation.activeYear];
    if (availableYears.some((year) => {
      const data = vegetation.years?.[year];
      return !data?.imageUrl || Object.keys(data.sectorStats ?? {}).length !== sectorIds.size;
    })) {
      throw new Error("vegetation.json contains an incomplete annual series.");
    }
  }
  return { sectorIds, scores };
}
