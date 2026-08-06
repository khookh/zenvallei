import { validateApplicationData } from "./data-validation.js";
import { addMunicipalityStatistics } from "./aggregate-statistics.js";

export async function loadApplicationData(baseUrl = import.meta.env.BASE_URL) {
  const prefix = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const loadJson = async (fileName) => {
    const response = await fetch(`${prefix}data/${fileName}`);
    if (!response.ok) throw new Error(`${fileName}: HTTP ${response.status}`);
    return response.json();
  };
  const loadOptionalJson = async (fileName, { tolerateErrors = false } = {}) => {
    try {
      const response = await fetch(`${prefix}data/${fileName}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${fileName}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (!tolerateErrors) throw error;
      return { available: false, loadError: error.message };
    }
  };
  const loadNotebookTest = async () => {
    if (import.meta.env.MODE !== "playground") return null;
    try {
      const response = await fetch(`${prefix}__playground__/manifest.json`, { cache: "no-store" });
      if (response.status === 404) return { available: false, missing: true };
      if (!response.ok) throw new Error(`manifest.json: HTTP ${response.status}`);
      return { ...(await response.json()), available: true };
    } catch (error) {
      return { available: false, loadError: error.message };
    }
  };
  const [geojson, scorePayload, methodology, provenance, landCover, urbanAtlas, vegetation, notebookTest] = await Promise.all([
    loadJson("sectors.geojson"),
    loadJson("scores.json"),
    loadJson("methodology.json"),
    loadJson("provenance.json"),
    loadOptionalJson("land-cover.json"),
    loadOptionalJson("urban-atlas.json", { tolerateErrors: true }),
    loadOptionalJson("vegetation.json", { tolerateErrors: true }),
    loadNotebookTest(),
  ]);
  const resolveAssetUrl = (assetUrl) => {
    if (!assetUrl || /^(?:https?:)?\/\//.test(assetUrl)) return assetUrl;
    return `${prefix}${assetUrl.replace(/^\//, "")}`;
  };
  if (landCover?.raster) {
    landCover.raster.imageUrl = resolveAssetUrl(landCover.raster.imageUrl);
    Object.entries(landCover.raster.rasterVariants ?? {}).forEach(([key, value]) => {
      landCover.raster.rasterVariants[key] = resolveAssetUrl(value);
    });
  }
  if (landCover?.change) landCover.change.imageUrl = resolveAssetUrl(landCover.change.imageUrl);
  if (urbanAtlas?.geojsonUrl) urbanAtlas.geojsonUrl = resolveAssetUrl(urbanAtlas.geojsonUrl);
  Object.values(vegetation?.years ?? {}).forEach((year) => {
    if (year?.imageUrl) year.imageUrl = resolveAssetUrl(year.imageUrl);
    Object.entries(year?.rasterVariants ?? {}).forEach(([key, value]) => {
      year.rasterVariants[key] = resolveAssetUrl(value);
    });
  });
  const resolveNotebookUrl = (assetUrl) => {
    if (!assetUrl || !/^[a-z0-9-]+\.png$/i.test(assetUrl)) return null;
    return `${prefix}__playground__/${assetUrl}`;
  };
  if (notebookTest?.available) {
    notebookTest.imageUrl = resolveNotebookUrl(notebookTest.imageUrl);
    Object.entries(notebookTest.rasterVariants ?? {}).forEach(([key, value]) => {
      notebookTest.rasterVariants[key] = resolveNotebookUrl(value);
    });
  }
  validateApplicationData({ geojson, scorePayload, methodology, provenance, landCover, urbanAtlas, vegetation });
  addMunicipalityStatistics({ scores: scorePayload.sectors, landCover, urbanAtlas, vegetation });
  return { geojson, scores: scorePayload.sectors, methodology, provenance, landCover, urbanAtlas, vegetation, notebookTest };
}

export function sectorsForMunicipality(scores, municipality = "") {
  return Object.values(scores)
    .filter((record) => !municipality || record.municipality === municipality)
    .sort((left, right) => left.sectorName.localeCompare(right.sectorName, "nl"));
}

export function sectorSearchLabel(record) {
  return `${record.sectorName} · ${record.municipality} (${record.sectorId})`;
}

export function findSectorFromQuery(scores, query) {
  const normalized = query.trim().toLocaleLowerCase("nl");
  if (!normalized) return null;
  return Object.values(scores).find((record) => {
    const label = sectorSearchLabel(record).toLocaleLowerCase("nl");
    return record.sectorId.toLocaleLowerCase("nl") === normalized || label === normalized;
  }) ?? null;
}

export function geometryBounds(geometry) {
  const bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  const visit = (coordinates) => {
    if (coordinates.length >= 2 && typeof coordinates[0] === "number") {
      bounds.minLon = Math.min(bounds.minLon, coordinates[0]);
      bounds.maxLon = Math.max(bounds.maxLon, coordinates[0]);
      bounds.minLat = Math.min(bounds.minLat, coordinates[1]);
      bounds.maxLat = Math.max(bounds.maxLat, coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]];
}

export function collectionBounds(featureCollection, municipality = "") {
  const selected = featureCollection.features.filter(
    (feature) => !municipality || feature.properties.municipality === municipality,
  );
  const aggregate = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  selected.forEach((feature) => {
    const [[minLon, minLat], [maxLon, maxLat]] = geometryBounds(feature.geometry);
    aggregate.minLon = Math.min(aggregate.minLon, minLon);
    aggregate.minLat = Math.min(aggregate.minLat, minLat);
    aggregate.maxLon = Math.max(aggregate.maxLon, maxLon);
    aggregate.maxLat = Math.max(aggregate.maxLat, maxLat);
  });
  return [[aggregate.minLon, aggregate.minLat], [aggregate.maxLon, aggregate.maxLat]];
}
