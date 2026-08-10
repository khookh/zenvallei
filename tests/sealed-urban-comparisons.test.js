import { describe, expect, it } from "vitest";
import { validateGroenkaartIncomeManifest } from "../src/comparisons/groenkaart-income.js";
import { validateLandsatGroenkaartManifest } from "../src/comparisons/landsat-groenkaart.js";
import { validateLandsatIncomeManifest } from "../src/comparisons/landsat-income.js";
import {
  comparisonPixelOffset, incomeLevel, ordinaryLeastSquares, selectedDensity,
} from "../src/comparisons/sealed-urban-shared.js";

const commonLandsat = {
  schemaVersion: 1,
  urbanAtlasYear: 2021,
  analysisResolutionMeters: 30,
  densityNonGreenUrl: "landsat-groenkaart/green-density-non-green.png",
  scopeIndexUrl: "landsat-groenkaart/scope-index.png",
  municipalityIndexes: { Halle: 1 },
  coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
  imageSize: [100, 100],
  observations: { observation: {} },
};

describe("sealed urban comparison contracts", () => {
  it("validates the three explicit products", () => {
    expect(validateLandsatGroenkaartManifest({
      ...commonLandsat,
      comparisonId: "landsat-groenkaart",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "groenkaart",
      greenMapYear: 2021,
      minimumGreenCoverage: .8,
      greenClasses: [],
    }).comparisonId).toBe("landsat-groenkaart");
    expect(validateLandsatIncomeManifest({
      ...commonLandsat,
      comparisonId: "landsat-income",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "income",
      incomeYear: 2023,
      minimumSectorPixels: 10,
    }).comparisonId).toBe("landsat-income");
    expect(validateGroenkaartIncomeManifest({
      schemaVersion: 1,
      comparisonId: "groenkaart-income",
      primaryLayerId: "groenkaart",
      secondaryLayerId: "income",
      greenMapYear: 2021,
      urbanAtlasYear: 2021,
      jaarbakYear: 2021,
      incomeYear: 2023,
      analysisResolutionMeters: 10,
      scopeIndexUrl: "groenkaart-income/scope-index.png",
      densityNonGreenUrl: "groenkaart-income/density-non-green.png",
      municipalityIndexes: { Halle: 1 },
      urbanFabricCodes: ["11100", "11210", "11220", "11230", "11240"],
    }).comparisonId).toBe("groenkaart-income");
  });

  it("rejects isolated structures or incompatible analytical thresholds", () => {
    expect(() => validateGroenkaartIncomeManifest({
      schemaVersion: 1,
      comparisonId: "groenkaart-income",
      primaryLayerId: "groenkaart",
      secondaryLayerId: "income",
      greenMapYear: 2021,
      urbanAtlasYear: 2021,
      jaarbakYear: 2021,
      incomeYear: 2023,
      analysisResolutionMeters: 10,
      scopeIndexUrl: "scope.png",
      municipalityIndexes: {},
      urbanFabricCodes: ["11100", "11300"],
    })).toThrow(/unsupported/i);
  });

  it("sums selected Green Map classes and computes descriptive OLS", () => {
    expect(selectedDensity({ meanDensityByGreenClass: { 1: 12, 2: 8, 3: 70 } }, new Set([1, 2]))).toBe(20);
    expect(ordinaryLeastSquares([
      { income: 20_000, density: 10 },
      { income: 30_000, density: 20 },
      { income: 40_000, density: 30 },
    ], "income", "density")).toMatchObject({ count: 3, slope: .001, intercept: -10, rSquared: 1 });
    expect(ordinaryLeastSquares([
      { income: 20_000, density: 10 }, { income: 20_000, density: 20 }, { income: 20_000, density: 30 },
    ], "income", "density")).toBeNull();
  });

  it("uses fixed income boundaries and locates browser pixels", () => {
    expect(incomeLevel(29_999).id).toBe("low");
    expect(incomeLevel(30_000).id).toBe("middle");
    expect(incomeLevel(40_000).id).toBe("high");
    expect(comparisonPixelOffset(commonLandsat, { lng: 4.5, lat: 50.5 })).toBeGreaterThan(0);
    expect(comparisonPixelOffset(commonLandsat, { lng: 2, lat: 50.5 })).toBe(-1);
  });
});
