const ROUNDING_DIGITS = 4;

export const URBAN_ATLAS_CLASSES = Object.freeze([
  { code: "11100", key: "continuousUrbanFabric", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#800000" },
  { code: "11210", key: "denseUrbanFabric", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#bf0000" },
  { code: "11220", key: "mediumUrbanFabric", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#ff4040" },
  { code: "11230", key: "lowUrbanFabric", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#ff8080" },
  { code: "11240", key: "veryLowUrbanFabric", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#ffbfbf" },
  { code: "11300", key: "isolatedStructures", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", color: "#cc6666" },
  { code: "12100", key: "industrialCommercialPublic", groupKey: "artificialSurfaces", artificialGroupKey: "industryServices", color: "#cc4df2" },
  { code: "12210", key: "fastTransitRoads", groupKey: "artificialSurfaces", artificialGroupKey: "transport", color: "#959595" },
  { code: "12220", key: "otherRoads", groupKey: "artificialSurfaces", artificialGroupKey: "transport", color: "#b3b3b3" },
  { code: "12230", key: "railways", groupKey: "artificialSurfaces", artificialGroupKey: "transport", color: "#595959" },
  { code: "12300", key: "portAreas", groupKey: "artificialSurfaces", artificialGroupKey: "transport", color: "#e6cccc" },
  { code: "12400", key: "airports", groupKey: "artificialSurfaces", artificialGroupKey: "transport", color: "#e6cce6" },
  { code: "13100", key: "mineralExtractionDump", groupKey: "artificialSurfaces", artificialGroupKey: "constructionExtraction", color: "#734d37" },
  { code: "13300", key: "constructionSites", groupKey: "artificialSurfaces", artificialGroupKey: "constructionExtraction", color: "#b9a56e" },
  { code: "13400", key: "unusedArtificialLand", groupKey: "artificialSurfaces", artificialGroupKey: "constructionExtraction", color: "#874545" },
  { code: "14110", key: "greenUrbanPublic", groupKey: "greenUrbanAreas", color: "#8cdc00" },
  { code: "14120", key: "greenUrbanPrivate", groupKey: "greenUrbanAreas", color: "#74b800" },
  { code: "14130", key: "greenUrbanUnknown", groupKey: "greenUrbanAreas", color: "#5a8f00" },
  { code: "14200", key: "sportsLeisure", groupKey: "agricultureSemiNatural", color: "#afd2a5" },
  { code: "21000", key: "arableLand", groupKey: "agricultureSemiNatural", color: "#ffffa8" },
  { code: "22000", key: "permanentCrops", groupKey: "agricultureSemiNatural", color: "#f2a64d" },
  { code: "23000", key: "pastures", groupKey: "agricultureSemiNatural", color: "#e6e64d" },
  { code: "24000", key: "complexCultivation", groupKey: "agricultureSemiNatural", color: "#ffe64d" },
  { code: "31000", key: "forests", groupKey: "agricultureSemiNatural", color: "#008c00" },
  { code: "32000", key: "herbaceousVegetation", groupKey: "agricultureSemiNatural", color: "#ccf24d" },
  { code: "33000", key: "openSpaces", groupKey: "agricultureSemiNatural", color: "#ccffcc" },
  { code: "40000", key: "wetlands", groupKey: "wetlands", color: "#a6a6ff" },
  { code: "50000", key: "water", groupKey: "water", color: "#80f2e6" },
  { code: "91000", key: "noDataCloud", groupKey: "noData", color: "#ffffff", noData: true },
  { code: "92000", key: "noDataMissing", groupKey: "noData", color: "#000000", noData: true },
]);

export const GREEN_CODES = Object.freeze(["14110", "14120", "14130", "23000", "31000", "32000"]);
export const GREEN_BREAKDOWN_CODES = Object.freeze(["31000", "32000", "23000", "14110", "14120", "14130"]);
export const ARTIFICIAL_CODES = Object.freeze([
  "11100", "11210", "11220", "11230", "11240", "11300", "12100",
  "12210", "12220", "12230", "12300", "12400", "13100", "13300", "13400",
]);
export const NO_DATA_CODES = Object.freeze(["91000", "92000"]);

export const CLASS_BY_CODE = new Map(URBAN_ATLAS_CLASSES.map((entry) => [entry.code, entry]));

function decodeXml(value) {
  return value
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function parseUrbanAtlasStyle(sld) {
  const parsed = [];
  const rules = sld.matchAll(/<se:Rule>([\s\S]*?)<\/se:Rule>/g);
  for (const match of rules) {
    const body = match[1];
    const name = body.match(/<se:Name>([\s\S]*?)<\/se:Name>/)?.[1]?.trim();
    const code = body.match(/<ogc:Literal>(\d{5})<\/ogc:Literal>/)?.[1];
    const color = body.match(/<se:SvgParameter\s+name=["']fill["']>(#[0-9a-fA-F]{6})<\/se:SvgParameter>/)?.[1]?.toLowerCase();
    if (!name || !code || !color) continue;
    const [nameCode, ...labelParts] = decodeXml(name).split(":");
    if (nameCode.trim() !== code) throw new Error(`Urban Atlas SLD-regel heeft tegenstrijdige codes: ${nameCode.trim()} en ${code}.`);
    parsed.push({ code, sourceLabel: labelParts.join(":").trim(), color });
  }
  return parsed;
}

export function validateOfficialStyle(styleEntries) {
  const byCode = new Map(styleEntries.map((entry) => [String(entry.code), entry]));
  for (const expected of URBAN_ATLAS_CLASSES) {
    const actual = byCode.get(expected.code);
    if (!actual) throw new Error(`Urban Atlas SLD mist klasse ${expected.code}.`);
    if (actual.color.toLowerCase() !== expected.color) {
      throw new Error(`Urban Atlas SLD-kleur voor ${expected.code} is ${actual.color}; verwacht ${expected.color}.`);
    }
  }
  const unknown = [...byCode.keys()].filter((code) => !CLASS_BY_CODE.has(code));
  if (unknown.length) throw new Error(`Urban Atlas SLD bevat onbekende klassen: ${unknown.join(", ")}.`);
  return true;
}

export function buildClassManifest(styleEntries, presentCodes = new Set()) {
  const styleByCode = new Map(styleEntries.map((entry) => [String(entry.code), entry]));
  return URBAN_ATLAS_CLASSES.map((definition) => ({
    ...definition,
    sourceLabel: styleByCode.get(definition.code)?.sourceLabel ?? definition.key,
    present: presentCodes.has(definition.code),
    renderClass: `ua-${definition.code}`,
    metric: GREEN_CODES.includes(definition.code)
      ? "green"
      : ARTIFICIAL_CODES.includes(definition.code) ? "artificial" : "other",
  }));
}

export function toMultiPolygonCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`Urban Atlas verwacht Polygon of MultiPolygon, niet ${geometry.type}.`);
}

export function projectMultiPolygon(multiPolygon, projector) {
  return multiPolygon.map((polygon) => polygon.map((ring) => ring.map(projector)));
}

export function multiPolygonBounds(multiPolygon) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of multiPolygon) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
  }
  return bounds;
}

export function boundsIntersect(left, right) {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

export function ringBounds(ring) {
  return ring.reduce((bounds, [x, y]) => [
    Math.min(bounds[0], x),
    Math.min(bounds[1], y),
    Math.max(bounds[2], x),
    Math.max(bounds[3], y),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

export function indexMultiPolygonRings(multiPolygon) {
  return multiPolygon
    .filter((polygon) => polygon.length && polygon[0].length >= 4)
    .map((polygon) => ({
      exterior: polygon[0],
      bounds: ringBounds(polygon[0]),
      holes: polygon.slice(1)
        .filter((ring) => ring.length >= 4)
        .map((ring) => ({ ring, bounds: ringBounds(ring) })),
    }));
}

export function indexedMultiPolygonBounds(indexedMultiPolygon) {
  return indexedMultiPolygon.reduce((bounds, polygon) => [
    Math.min(bounds[0], polygon.bounds[0]),
    Math.min(bounds[1], polygon.bounds[1]),
    Math.max(bounds[2], polygon.bounds[2]),
    Math.max(bounds[3], polygon.bounds[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}

export function subsetIndexedMultiPolygon(indexedMultiPolygon, clipBounds) {
  return indexedMultiPolygon
    .filter((polygon) => boundsIntersect(polygon.bounds, clipBounds))
    .map((polygon) => [
      polygon.exterior,
      ...polygon.holes
        .filter((hole) => boundsIntersect(hole.bounds, clipBounds))
        .map((hole) => hole.ring),
    ]);
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

export function multiPolygonAreaSquareMeters(multiPolygon) {
  return multiPolygon.reduce((total, polygon) => {
    if (!polygon.length) return total;
    const exterior = Math.abs(ringArea(polygon[0]));
    const holes = polygon.slice(1).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
    return total + Math.max(0, exterior - holes);
  }, 0);
}

function rounded(value) {
  return Number(value.toFixed(ROUNDING_DIGITS));
}

function percentage(area, denominator) {
  return denominator > 0 ? rounded((area / denominator) * 100) : 0;
}

export function buildSectorStatistics(sectorAreasSquareMeters, areaBySectorAndClass) {
  const output = {};
  for (const [sectorId, sectorAreaSquareMeters] of sectorAreasSquareMeters) {
    const areaByClass = areaBySectorAndClass.get(sectorId) ?? new Map();
    const processedAreaSquareMeters = [...areaByClass.values()].reduce((sum, area) => sum + area, 0);
    const explicitNoDataSquareMeters = NO_DATA_CODES.reduce((sum, code) => sum + (areaByClass.get(code) ?? 0), 0);
    const coverageGapSquareMeters = Math.max(0, sectorAreaSquareMeters - processedAreaSquareMeters);
    const validAreaSquareMeters = Math.max(0, processedAreaSquareMeters - explicitNoDataSquareMeters);
    const greenAreaSquareMeters = GREEN_CODES.reduce((sum, code) => sum + (areaByClass.get(code) ?? 0), 0);
    const artificialAreaSquareMeters = ARTIFICIAL_CODES.reduce((sum, code) => sum + (areaByClass.get(code) ?? 0), 0);
    const dominant = [...areaByClass.entries()]
      .filter(([code]) => !NO_DATA_CODES.includes(code))
      .sort((left, right) => right[1] - left[1])[0];
    const metricClass = (code, metricAreaSquareMeters) => {
      const area = areaByClass.get(code) ?? 0;
      return {
        code,
        areaHa: rounded(area / 10_000),
        sectorPercentage: percentage(area, validAreaSquareMeters),
        metricPercentage: percentage(area, metricAreaSquareMeters),
      };
    };
    const otherClasses = [...areaByClass.entries()]
      .filter(([code, area]) => area > 0 && !NO_DATA_CODES.includes(code)
        && !GREEN_CODES.includes(code) && !ARTIFICIAL_CODES.includes(code))
      .map(([code]) => metricClass(code, 0))
      .sort((left, right) => right.areaHa - left.areaHa);
    output[sectorId] = {
      sectorAreaHa: rounded(sectorAreaSquareMeters / 10_000),
      processedAreaHa: rounded(processedAreaSquareMeters / 10_000),
      validAreaHa: rounded(validAreaSquareMeters / 10_000),
      noDataAreaHa: rounded((explicitNoDataSquareMeters + coverageGapSquareMeters) / 10_000),
      coveragePercentage: percentage(processedAreaSquareMeters, sectorAreaSquareMeters),
      dominantClassCode: dominant?.[0] ?? null,
      green: {
        areaHa: rounded(greenAreaSquareMeters / 10_000),
        percentage: percentage(greenAreaSquareMeters, validAreaSquareMeters),
        classes: GREEN_BREAKDOWN_CODES.map((code) => metricClass(code, greenAreaSquareMeters)),
      },
      artificial: {
        areaHa: rounded(artificialAreaSquareMeters / 10_000),
        percentage: percentage(artificialAreaSquareMeters, validAreaSquareMeters),
        classes: ARTIFICIAL_CODES.map((code) => metricClass(code, artificialAreaSquareMeters))
          .filter((entry) => entry.areaHa > 0),
      },
      otherClasses,
    };
  }
  return output;
}
