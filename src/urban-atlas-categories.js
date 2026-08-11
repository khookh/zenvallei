/**
 * Mutually exclusive presentation families built from official Urban Atlas
 * classes. They simplify the standalone result without claiming that a family
 * is fully sealed, impermeable or vegetation-free.
 */
export const URBAN_ATLAS_CATEGORIES = Object.freeze([
  { id: "urbanFabric", codes: ["11100", "11210", "11220", "11230", "11240", "11300"], color: "#c74444" },
  { id: "industryServices", codes: ["12100"], color: "#a64db6" },
  { id: "transportWorks", codes: ["12210", "12220", "12230", "12300", "12400", "13100", "13300", "13400"], color: "#777777" },
  { id: "greenSemiNatural", codes: ["14110", "14120", "14130", "31000", "32000", "33000"], color: "#2f8c4d" },
  { id: "agriculture", codes: ["21000", "22000", "23000", "24000"], color: "#d4b83f" },
  { id: "sportsLeisure", codes: ["14200"], color: "#67b89a" },
  { id: "wetlandsWater", codes: ["40000", "50000"], color: "#3787b5" },
]);

export const URBAN_ATLAS_UNAVAILABLE_CODES = Object.freeze(["91000", "92000"]);

const round = (value, digits = 4) => Number(Number(value ?? 0).toFixed(digits));

/** Recover one complete class-area table from the legacy metric partitions. */
export function urbanAtlasClassAreas(stats) {
  const areas = new Map();
  const collections = [stats?.green?.classes, stats?.artificial?.classes, stats?.otherClasses];
  collections.flatMap((items) => items ?? []).forEach((item) => {
    const code = String(item.code);
    areas.set(code, (areas.get(code) ?? 0) + Number(item.areaHa ?? 0));
  });
  return areas;
}

/** Build the seven display families against valid classified Urban Atlas area. */
export function urbanAtlasCategoryBreakdown(stats) {
  if (!stats || !Number.isFinite(Number(stats.validAreaHa)) || Number(stats.validAreaHa) <= 0) return [];
  const denominator = Number(stats.validAreaHa);
  const areas = urbanAtlasClassAreas(stats);
  return URBAN_ATLAS_CATEGORIES.map((category) => {
    const areaHa = category.codes.reduce((total, code) => total + (areas.get(code) ?? 0), 0);
    return {
      ...category,
      areaHa: round(areaHa),
      percentage: round(areaHa / denominator * 100, 2),
      classes: category.codes.map((code) => ({ code, areaHa: round(areas.get(code) ?? 0) })),
    };
  });
}

export function dominantUrbanAtlasCategory(stats) {
  return urbanAtlasCategoryBreakdown(stats)
    .reduce((largest, category) => category.areaHa > (largest?.areaHa ?? -1) ? category : largest, null);
}
