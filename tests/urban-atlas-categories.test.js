import { describe, expect, it } from "vitest";
import {
  URBAN_ATLAS_CATEGORIES,
  URBAN_ATLAS_UNAVAILABLE_CODES,
  dominantUrbanAtlasCategory,
  urbanAtlasCategoryBreakdown,
} from "../src/urban-atlas-categories.js";

const expected = {
  urbanFabric: ["11100", "11210", "11220", "11230", "11240", "11300"],
  industryServices: ["12100"],
  transportWorks: ["12210", "12220", "12230", "12300", "12400", "13100", "13300", "13400"],
  greenSemiNatural: ["14110", "14120", "14130", "31000", "32000", "33000"],
  agriculture: ["21000", "22000", "23000", "24000"],
  sportsLeisure: ["14200"],
  wetlandsWater: ["40000", "50000"],
};

describe("Urban Atlas presentation categories", () => {
  it("assigns every supported official class exactly once and excludes unavailable codes", () => {
    expect(Object.fromEntries(URBAN_ATLAS_CATEGORIES.map(({ id, codes }) => [id, codes]))).toEqual(expected);
    const codes = URBAN_ATLAS_CATEGORIES.flatMap(({ codes }) => codes);
    expect(new Set(codes).size).toBe(codes.length);
    URBAN_ATLAS_UNAVAILABLE_CODES.forEach((code) => expect(codes).not.toContain(code));
  });

  it("reconciles the seven groups to valid classified area", () => {
    const classRows = URBAN_ATLAS_CATEGORIES.flatMap(({ codes }, categoryIndex) => codes.map((code, codeIndex) => ({
      code,
      areaHa: categoryIndex + codeIndex + 1,
    })));
    const validAreaHa = classRows.reduce((sum, row) => sum + row.areaHa, 0);
    const stats = {
      validAreaHa,
      green: { classes: classRows.slice(0, 8) },
      artificial: { classes: classRows.slice(8, 20) },
      otherClasses: classRows.slice(20),
    };
    const breakdown = urbanAtlasCategoryBreakdown(stats);
    expect(breakdown).toHaveLength(7);
    expect(breakdown.reduce((sum, category) => sum + category.areaHa, 0)).toBe(validAreaHa);
    expect(breakdown.reduce((sum, category) => sum + category.percentage, 0)).toBeCloseTo(100, 1);
    expect(dominantUrbanAtlasCategory(stats).areaHa).toBe(Math.max(...breakdown.map(({ areaHa }) => areaHa)));
  });
});
