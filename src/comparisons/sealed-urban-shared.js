import { formatCurrency, formatNumber, getLanguage, t } from "../i18n.js";

/**
 * Continuous Green Map density ramp. These are interpolation stops, not
 * analytical classes: every value from 0 to 100 receives an interpolated
 * colour while the original density value remains available to queries.
 */
export const GREEN_DENSITY_STOPS = Object.freeze([
  Object.freeze({ value: 0, color: "#f7fcf5" }),
  Object.freeze({ value: 25, color: "#c7e9c0" }),
  Object.freeze({ value: 50, color: "#74c476" }),
  Object.freeze({ value: 75, color: "#238b45" }),
  Object.freeze({ value: 100, color: "#00441b" }),
]);
export const GREEN_DENSITY_COLORS = Object.freeze(GREEN_DENSITY_STOPS.map(({ color }) => color));
export const GREEN_DENSITY_GRADIENT = `linear-gradient(90deg, ${GREEN_DENSITY_STOPS
  .map(({ value, color }) => `${color} ${value}%`).join(", ")})`;
export const SURROUNDING_RADIUS_METRES = 100;
export const SURROUNDING_AREA_HA = Math.PI;
const EXPECTED_URBAN_SURFACE_GROUPS = Object.freeze({
  residential: Object.freeze(["11100", "11210", "11220", "11230", "11240"]),
  employmentInstitutional: Object.freeze(["12100"]),
});

/** Keep the five comparison manifests on the same explicit two-group contract. */
export function hasUrbanSurfaceContract(manifest) {
  if (!Array.isArray(manifest?.urbanSurfaceGroups)
    || JSON.stringify(manifest.defaultUrbanSurfaceGroups) !== JSON.stringify(Object.keys(EXPECTED_URBAN_SURFACE_GROUPS))) {
    return false;
  }
  return Object.entries(EXPECTED_URBAN_SURFACE_GROUPS).every(([id, codes]) => {
    const group = manifest.urbanSurfaceGroups.find((candidate) => candidate.id === id);
    return group && JSON.stringify(group.codes) === JSON.stringify(codes);
  }) && manifest.urbanSurfaceGroups.length === 2;
}

const hexRgb = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

/** Return the continuously interpolated RGB colour for a 0-100% density. */
export function greenDensityColor(value) {
  const bounded = Math.max(0, Math.min(100, Number(value) || 0));
  const endIndex = Math.max(1, GREEN_DENSITY_STOPS.findIndex((stop) => stop.value >= bounded));
  const start = GREEN_DENSITY_STOPS[endIndex - 1];
  const end = GREEN_DENSITY_STOPS[endIndex];
  const mix = (bounded - start.value) / Math.max(1, end.value - start.value);
  const startRgb = hexRgb(start.color);
  const endRgb = hexRgb(end.color);
  return startRgb.map((component, index) => Math.round(component + (endRgb[index] - component) * mix));
}

/** Convert a 0-100% focal-cover value into hectares in the 100 m circle. */
export function surroundingAreaHa(percentage) {
  return Math.max(0, Math.min(100, Number(percentage) || 0)) / 100 * SURROUNDING_AREA_HA;
}
export const INCOME_SYMBOL_LAYER_PREFIX = "sealed-urban-income-symbols";
export const SEALED_URBAN_SOURCE_URLS = Object.freeze({
  landsat: "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature",
  greenMap: "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021",
  jaarbak: "https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023",
  urbanAtlas: "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021",
  income: "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector",
});

export function safeAsset(root, value, extension) {
  if (typeof value !== "string" || value.includes("..") || !value.endsWith(extension)) {
    throw new TypeError(`Unsafe comparison asset '${value}'.`);
  }
  return `${root}${value}`;
}

export async function loadImageData(url, expectedSize) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Comparison image HTTP ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob());
  if (bitmap.width !== expectedSize[0] || bitmap.height !== expectedSize[1]) {
    bitmap.close();
    throw new Error("Comparison image dimensions do not match its manifest.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function mercatorY(latitude) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

/** Locate a pointer in the lossless north-up comparison image. */
export function comparisonPixelOffset(manifest, point) {
  const [[west, north], [east], , [, south]] = manifest.coordinates;
  const column = Math.floor((point.lng - west) / (east - west) * manifest.imageSize[0]);
  const northY = mercatorY(north);
  const southY = mercatorY(south);
  const row = Math.floor((northY - mercatorY(point.lat)) / (northY - southY) * manifest.imageSize[1]);
  if (column < 0 || row < 0 || column >= manifest.imageSize[0] || row >= manifest.imageSize[1]) return -1;
  return (row * manifest.imageSize[0] + column) * 4;
}

export const localized = (value, fallback = "") => typeof value === "string"
  ? value
  : value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;

export function comparisonAreaRecord(record, municipality = "") {
  if (record?.scope) return record;
  return {
    scope: municipality ? "municipality" : "region",
    municipality,
    sectorId: "",
    sectorName: municipality || t("controls.allMunicipalities"),
  };
}

export function selectedDensity(record, selectedClasses) {
  return [...selectedClasses].reduce((sum, code) => {
    const value = record?.meanDensityByGreenClass?.[String(code)];
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

export function ordinaryLeastSquares(points, xKey, yKey) {
  const valid = points.filter((point) => Number.isFinite(point[xKey]) && Number.isFinite(point[yKey]));
  if (valid.length < 3) return null;
  const xMean = valid.reduce((sum, point) => sum + point[xKey], 0) / valid.length;
  const yMean = valid.reduce((sum, point) => sum + point[yKey], 0) / valid.length;
  const denominator = valid.reduce((sum, point) => sum + (point[xKey] - xMean) ** 2, 0);
  if (denominator <= 0) return null;
  const slope = valid.reduce((sum, point) => sum + (point[xKey] - xMean) * (point[yKey] - yMean), 0) / denominator;
  const intercept = yMean - slope * xMean;
  const total = valid.reduce((sum, point) => sum + (point[yKey] - yMean) ** 2, 0);
  const residual = valid.reduce((sum, point) => sum + (point[yKey] - (intercept + slope * point[xKey])) ** 2, 0);
  const correlation = (left, right) => {
    const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
    const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
    const covariance = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
    const scale = Math.sqrt(
      left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0)
      * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0),
    );
    return scale > 0 ? covariance / scale : null;
  };
  const averageRanks = (values) => {
    const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
    const ranks = new Array(values.length);
    for (let start = 0; start < sorted.length;) {
      let end = start + 1;
      while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
      const rank = (start + 1 + end) / 2;
      for (let index = start; index < end; index += 1) ranks[sorted[index].index] = rank;
      start = end;
    }
    return ranks;
  };
  const xValues = valid.map((point) => point[xKey]);
  const yValues = valid.map((point) => point[yKey]);
  return {
    count: valid.length,
    slope,
    intercept,
    rSquared: total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : null,
    pearsonR: correlation(xValues, yValues),
    spearmanRho: correlation(averageRanks(xValues), averageRanks(yValues)),
  };
}

export function incomeLevel(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 30_000) return { id: "low", symbol: "€" };
  if (value < 40_000) return { id: "middle", symbol: "€€" };
  return { id: "high", symbol: "€€€" };
}

export function incomeLegend() {
  return {
    title: t("sealedUrban.incomeLegend"),
    items: [
      { label: t("heatIncome.incomeLow"), symbol: "€", color: "#fffdf7" },
      { label: t("heatIncome.incomeMiddle"), symbol: "€€", color: "#fffdf7" },
      { label: t("heatIncome.incomeHigh"), symbol: "€€€", color: "#fffdf7" },
      { label: t("heatIncome.incomeUnavailable"), symbol: "–", color: "#eae2de" },
    ],
  };
}

export function mountIncomeSymbols(map, { id, sectorStats, municipality = "" }) {
  const entries = Object.entries(sectorStats).flatMap(([sectorId, record]) => {
    const level = incomeLevel(record.income);
    return level ? [sectorId, level.symbol] : [];
  });
  if (!map.getLayer(id)) {
    map.addLayer({
      id,
      type: "symbol",
      source: "heat-sectors",
      layout: {
        "text-field": ["match", ["get", "sectorId"], ...entries, ""],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9, 12, 12, 14, 14],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#173f48",
        "text-halo-color": "rgba(255,253,247,0.96)",
        "text-halo-width": 1.8,
      },
    }, "heat-sectors-outline");
  }
  map.setFilter(id, municipality ? ["==", ["get", "municipality"], municipality] : null);
  map.setLayoutProperty(id, "visibility", "visible");
}

export function hideIncomeSymbols(map, id) {
  if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
}

export function sectorPointLabel(point, { x = "income", y = "density", observation = null } = {}) {
  const xValue = x === "income" ? formatCurrency(point.income) : `${formatNumber(point.density, 1)}%`;
  const yValue = y === "temperature" ? `${formatNumber(point.temperature, 1)} °C` : `${formatNumber(point.density, 1)}%`;
  return [point.sectorName, point.sectorId, point.municipality, xValue, yValue, observation].filter(Boolean).join(" · ");
}

export function greenClassSelector(manifest, selected) {
  return {
    title: t("sealedUrban.greenSelector"),
    items: manifest.greenClasses.map((item) => ({
      value: Number(item.value), code: Number(item.value),
      label: localized(item.label, String(item.value)),
      color: item.color,
      selected: selected.has(Number(item.value)),
    })),
  };
}

/** Build the same two-group Urban Atlas selector for every sealed-urban comparison. */
export function urbanSurfaceSelector(manifest, selected) {
  return {
    title: t("sealedUrban.surfaceSelectorTitle"),
    help: t("sealedUrban.surfaceSelectorHelp"),
    selected: [...selected],
    groups: manifest.urbanSurfaceGroups.map((group) => ({
      id: group.id,
      title: t(`sealedUrban.surface.${group.id}`),
      expanded: false,
      items: [],
      family: {
        key: group.id,
        color: group.color,
        selected: selected.has(group.id),
      },
    })),
  };
}

export function selectedUrbanClassIndexes(manifest, selected) {
  return manifest.urbanSurfaceGroups
    .filter(({ id }) => selected.has(id))
    .flatMap(({ codes }) => codes.map((code) => manifest.urbanAtlasClassIndexes[String(code)]))
    .filter(Number.isFinite);
}

/** Combine group-specific sums without averaging group means twice. */
export function combineUrbanGroupStats(record, selected, { valueKeys = [] } = {}) {
  const groups = [...selected].map((id) => record?.urbanSurfaceGroups?.[id]).filter(Boolean);
  const analysedAreaHa = groups.reduce((sum, group) => sum + Number(group.analysedAreaHa ?? 0), 0);
  const clearPixelCount = groups.reduce((sum, group) => sum + Number(group.clearPixelCount ?? 0), 0);
  const contributingIds = new Set(groups.flatMap((group) => group.landsatIndexes ?? []));
  const contributingLandsatCount = contributingIds.size || groups.reduce(
    (sum, group) => sum + Number(group.contributingLandsatCount ?? 0), 0,
  );
  const temperatureAreaSum = groups.reduce(
    (sum, group) => sum + Number(group.temperatureAreaSum ?? 0), 0,
  );
  const output = { analysedAreaHa, clearPixelCount, contributingLandsatCount, temperatureAreaSum };
  valueKeys.forEach((key) => {
    if (key === "meanTemperatureC" && groups.some((group) => Number.isFinite(group.temperatureAreaSum))) {
      output[key] = analysedAreaHa > 0 ? temperatureAreaSum / (analysedAreaHa * 10_000) : null;
      return;
    }
    const denominator = key === "meanTemperatureC" ? clearPixelCount : analysedAreaHa;
    const weighted = groups.reduce((sum, group) => {
      const weight = key === "meanTemperatureC"
        ? Number(group.clearPixelCount ?? 0)
        : Number(group.analysedAreaHa ?? 0);
      return Number.isFinite(group[key]) ? sum + group[key] * weight : sum;
    }, 0);
    output[key] = denominator > 0 ? weighted / denominator : null;
  });
  return output;
}
