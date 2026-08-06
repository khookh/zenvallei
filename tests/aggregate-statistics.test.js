/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { addMunicipalityStatistics } from "../src/aggregate-statistics.js";

describe("municipality statistics", () => {
  it("recomputes area-weighted land-cover and vegetation percentages", () => {
    const scores = {
      A: { sectorId: "A", municipality: "Test" },
      B: { sectorId: "B", municipality: "Test" },
    };
    const landCover = { sectorStats: {
      A: { totalAreaHa: 10, classifiedAreaHa: 10, vegetationAreaHa: 8, builtUpAreaHa: 2, classes: [{ code: 10, areaHa: 8 }, { code: 90, areaHa: 2 }] },
      B: { totalAreaHa: 30, classifiedAreaHa: 30, vegetationAreaHa: 6, builtUpAreaHa: 24, classes: [{ code: 10, areaHa: 6 }, { code: 90, areaHa: 24 }] },
    } };
    const vegetation = { years: { 2023: { sectorStats: {
      A: { sectorAreaHa: 10, validAreaHa: 10, likelyVegetatedAreaHa: 8, belowThresholdAreaHa: 1, excludedCroplandAreaHa: 1, excludedWaterAreaHa: 0, missingObservationAreaHa: 0, medianNdvi: 0.7 },
      B: { sectorAreaHa: 40, validAreaHa: 30, likelyVegetatedAreaHa: 6, belowThresholdAreaHa: 20, excludedCroplandAreaHa: 3, excludedWaterAreaHa: 1, missingObservationAreaHa: 10, medianNdvi: 0.5 },
    } } } };

    addMunicipalityStatistics({ scores, landCover, urbanAtlas: null, vegetation });

    expect(landCover.municipalityStats.Test.vegetationPercentage).toBe(35);
    expect(landCover.municipalityStats.Test.dominantClassCode).toBe(90);
    expect(vegetation.years[2023].municipalityStats.Test).toMatchObject({
      likelyVegetatedAreaHa: 14,
      likelyVegetatedPercentage: 28,
      excludedCroplandAreaHa: 4,
      excludedCroplandPercentage: 8,
      medianIsAreaWeightedApproximation: true,
    });
  });

  it("sums Urban Atlas class areas before calculating both headline metrics", () => {
    const scores = { A: { sectorId: "A", municipality: "Test" } };
    const urbanAtlas = {
      greenCodes: ["23000", "31000"],
      artificialCodes: ["11100"],
      sectorStats: { A: {
        sectorAreaHa: 10, processedAreaHa: 10, validAreaHa: 10, noDataAreaHa: 0,
        green: { classes: [{ code: "23000", areaHa: 2 }, { code: "31000", areaHa: 1 }] },
        artificial: { classes: [{ code: "11100", areaHa: 5 }] },
        otherClasses: [{ code: "21000", areaHa: 2 }],
      } },
    };
    addMunicipalityStatistics({ scores, landCover: null, urbanAtlas, vegetation: null });
    expect(urbanAtlas.municipalityStats.Test.green.percentage).toBe(30);
    expect(urbanAtlas.municipalityStats.Test.artificial.percentage).toBe(50);
    expect(urbanAtlas.municipalityStats.Test.dominantClassCode).toBe("11100");
  });
});
