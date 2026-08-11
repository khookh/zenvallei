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

  it("creates resident-weighted bands without splitting tied population values", () => {
    const cells = Array.from({ length: 100 }, (_, index) => cell(index, Math.floor(index / 10) * 5 + 5, index));
    const summary = summarizeGreenByPopulation(cells, new Set([1, 2]));
    expect(summary.sufficient).toBe(true);
    expect(summary.bands.reduce((sum, group) => sum + group.count, 0)).toBe(100);
    expect(summary.bands.every((band) => band.count >= 5)).toBe(true);
    expect(summary.bands.at(-1).endShare).toBeCloseTo(100);
    expect(summary.bands.every((band, index) => !index || band.minimum > summary.bands[index - 1].maximum)).toBe(true);
  });

  it("shows a weighted mean instead of bands below ten positive cells", () => {
    const summary = summarizeGreenByPopulation(
      Array.from({ length: 9 }, (_, index) => cell(index, index + 1, 30)),
      new Set([1, 2]),
    );
    expect(summary).toMatchObject({ sufficient: false, bands: [] });
    expect(summary.points).toHaveLength(9);
    expect(summary.weightedMean).toBe(30);
  });

  it("sums any selected non-empty Green Map class combination", () => {
    const source = [cell(1, 12, 50), cell(2, 14, 20), ...Array.from({ length: 28 }, (_, index) => cell(index + 3, 20 + index, 10))];
    const green = summarizeGreenByPopulation(source, new Set([1, 2]));
    const nonGreen = summarizeGreenByPopulation(source, new Set([4]));
    expect(green.points[0].density).toBe(50);
    expect(nonGreen.points[0].density).toBe(50);
    expect(green.points[1].density).toBe(20);
    expect(nonGreen.points[1].density).toBe(80);
  });
});
