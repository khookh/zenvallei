import { describe, expect, it } from "vitest";
import {
  summarizeGreenByPopulation,
  validateGroenkaartPopulationManifest,
} from "../src/comparisons/groenkaart-population.js";

const manifest = {
  schemaVersion: 3,
  comparisonId: "groenkaart-population",
  primaryLayerId: "groenkaart",
  secondaryLayerId: "population",
  greenMapYear: 2021,
  populationDatasetId: "flanders-2019",
  populationResolutionMeters: 100,
  densityRadiusMeters: 100,
  minimumEligibleAreaHa: .1,
  minimumAnalysedAreaHa: .1,
  maskResolutionMeters: 1,
  aggregation: "exact-masked-area",
  statisticsUrl: "groenkaart-population/cells.json",
  urbanAtlasClassMaskUrl: "shared/urban-atlas-classes-2021.pmtiles",
  urbanAtlasClassIndexes: { 11100: 1, 12100: 2 },
  urbanSurfaceGroups: [{ id: "residential", codes: ["11100", "11210", "11220", "11230", "11240"] }, { id: "employmentInstitutional", codes: ["12100"] }],
  defaultUrbanSurfaceGroups: ["residential", "employmentInstitutional"],
  cellEncoding: { s: "sectorId" },
  sectorMunicipalities: { sector: "Halle" },
};

const cell = (index, populationDensityPerHa, density = index % 101) => ({
  cellId: String(index),
  populationDensityPerHa,
  analysedAreaHa: .2,
  meanDensityByGreenClass: { 1: density * .6, 2: density * .4, 3: 0, 4: 100 - density },
});

describe("Green Map-population comparison", () => {
  it("pins the uniform 2019 population model and 100 m comparison unit", () => {
    expect(validateGroenkaartPopulationManifest(manifest)).toBe(manifest);
    expect(() => validateGroenkaartPopulationManifest({ ...manifest, populationDatasetId: "statbel-2025" }))
      .toThrow(/unsupported/i);
  });

  it("creates a least-to-most vegetation curve without splitting tied values", () => {
    const cells = Array.from({ length: 100 }, (_, index) => cell(index, Math.floor(index / 10) * 5 + 5, index));
    const summary = summarizeGreenByPopulation(cells, new Set([1, 2]));
    expect(summary.direction).toBe("ascending");
    expect(summary.curve).toHaveLength(100);
    expect(summary.curve.at(-1).cumulativeResidents).toBe(summary.totalResidents);
    expect(summary.bins).toHaveLength(20);
    expect(summary.bins.reduce((sum, bin) => sum + bin.residents, 0)).toBe(summary.totalResidents);
    const tied = summary.curve.filter(({ value }) => value === 10);
    expect(new Set(tied.map(({ selectedResidents }) => selectedResidents))).toHaveLength(1);
  });

  it("retains exact small cohorts instead of creating resident-decile bands", () => {
    const summary = summarizeGreenByPopulation(
      Array.from({ length: 9 }, (_, index) => cell(index, index + 1, 30)),
      new Set([1, 2]),
    );
    expect(summary.points).toHaveLength(9);
    expect(summary.curve).toHaveLength(9);
    expect(summary.bins).toHaveLength(20);
    expect(summary.weightedMean).toBe(30);
  });

  it("sums any selected non-empty Green Map class combination", () => {
    const source = [cell(1, 12, 50), cell(2, 14, 20), ...Array.from({ length: 28 }, (_, index) => cell(index + 3, 20 + index, 10))];
    const green = summarizeGreenByPopulation(source, new Set([1, 2]));
    const nonGreen = summarizeGreenByPopulation(source, new Set([4]));
    expect(green.points.find(({ cellId }) => cellId === "1").density).toBe(50);
    expect(nonGreen.points.find(({ cellId }) => cellId === "1").density).toBe(50);
    expect(green.points.find(({ cellId }) => cellId === "2").density).toBe(20);
    expect(nonGreen.points.find(({ cellId }) => cellId === "2").density).toBe(80);
  });
});
