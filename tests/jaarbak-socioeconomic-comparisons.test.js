import { describe, expect, it } from "vitest";
import {
  combineJaarbakPopulationCell, summarizeSoilByPopulation, validateJaarbakPopulationManifest,
} from "../src/comparisons/jaarbak-population.js";
import {
  combineJaarbakIncomeRecord, validateJaarbakIncomeManifest,
} from "../src/comparisons/jaarbak-income.js";

const common = {
  schemaVersion: 1,
  soilSealingYear: 2024,
  urbanAtlasYear: 2021,
  densityRadiusMeters: 100,
  densityAnalysisResolutionMeters: 10,
  minimumDensityCoverage: 95,
  minimumAnalysedAreaHa: .1,
  maskResolutionMeters: 1,
  aggregation: "exact-masked-area",
  densityGridUrl: "jaarbak-socioeconomic/density-grid.png",
  scopeIndexUrl: "jaarbak-socioeconomic/scope-index.png",
  urbanAtlasClassMaskUrl: "shared/urban-atlas.pmtiles",
  urbanAtlasClassIndexes: { 11100: 1, 12100: 2 },
  urbanSurfaceGroups: [
    { id: "residential", codes: ["11100", "11210", "11220", "11230", "11240"] },
    { id: "employmentInstitutional", codes: ["12100"] },
  ],
  defaultUrbanSurfaceGroups: ["residential", "employmentInstitutional"],
};

describe("Soil-sealing socioeconomic comparisons", () => {
  it("pins the public population and income source years", () => {
    const population = {
      ...common, comparisonId: "jaarbak-population", primaryLayerId: "jaarbak",
      secondaryLayerId: "population", populationYear: 2019,
      populationDatasetId: "flanders-2019", populationResolutionMeters: 100,
      statisticsUrl: "jaarbak-population/cells.json",
    };
    const income = {
      ...common, comparisonId: "jaarbak-income", primaryLayerId: "jaarbak",
      secondaryLayerId: "income", incomeYear: 2023,
      statisticsUrl: "jaarbak-income/statistics.json.gz",
    };
    expect(validateJaarbakPopulationManifest(population)).toBe(population);
    expect(validateJaarbakIncomeManifest(income)).toBe(income);
    expect(() => validateJaarbakPopulationManifest({ ...population, soilSealingYear: 2021 })).toThrow();
    expect(() => validateJaarbakIncomeManifest({ ...income, incomeYear: 2022 })).toThrow();
  });

  it("orders cumulative residents from highest to lowest sealing and uses fixed five-point bins", () => {
    const summary = summarizeSoilByPopulation([
      { cellId: "zero", density: 0, populationDensityPerHa: 10 },
      { cellId: "half", density: 50, populationDensityPerHa: 20 },
      { cellId: "full", density: 100, populationDensityPerHa: 30 },
      { cellId: "empty", density: 75, populationDensityPerHa: 0 },
    ]);
    expect(summary.direction).toBe("descending");
    expect(summary.points.map(({ density }) => density)).toEqual([100, 50, 0]);
    expect(summary.totalResidents).toBe(60);
    expect(summary.zeroPopulationCount).toBe(1);
    expect(summary.bins).toHaveLength(20);
    expect(summary.bins[0].residents).toBe(10);
    expect(summary.bins[10].residents).toBe(20);
    expect(summary.bins[19].residents).toBe(30);
    expect(summary.curve.at(-1).cumulativeResidents).toBe(60);
  });

  it("uses exact-area weighting when selected Urban Atlas groups differ in area", () => {
    const combined = combineJaarbakIncomeRecord({
      income: 35_000,
      urbanSurfaceGroups: {
        residential: { analysedAreaHa: .1, densityAreaSum: 1_000 * 10 },
        employmentInstitutional: { analysedAreaHa: .3, densityAreaSum: 3_000 * 90 },
      },
    }, new Set(["residential", "employmentInstitutional"]));
    expect(combined.analysedAreaHa).toBeCloseTo(.4);
    expect(combined.density).toBeCloseTo(70);
    expect(combined.density).not.toBe(50);
  });

  it("rejects 999 exact square metres and includes 1,000", () => {
    const makeCell = (pixelCount) => ({
      urbanSurfaceGroups: {
        residential: { pixelCount, weightedDensitySum: pixelCount * 60 },
      },
    });
    expect(combineJaarbakPopulationCell(makeCell(999), new Set(["residential"]))).toBeNull();
    expect(combineJaarbakPopulationCell(makeCell(1_000), new Set(["residential"])))
      .toMatchObject({ analysedAreaHa: .1, density: 60 });
  });
});
