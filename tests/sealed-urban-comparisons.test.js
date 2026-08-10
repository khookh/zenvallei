import { describe, expect, it } from "vitest";
import { validateGroenkaartIncomeManifest } from "../src/comparisons/groenkaart-income.js";
import { validateLandsatGroenkaartManifest } from "../src/comparisons/landsat-groenkaart.js";
import { validateLandsatIncomeManifest } from "../src/comparisons/landsat-income.js";
import { isOfficialSealedPixel } from "../src/comparisons/exact-sealed-raster.js";
import {
  comparisonPixelOffset, greenDensityColor, incomeLevel, ordinaryLeastSquares, selectedDensity,
  surroundingAreaHa,
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
  observations: { observation: { displayDataUrl: "shared/display.png", pointDataUrl: "points.png" } },
};

describe("sealed urban comparison contracts", () => {
  it("validates the three explicit products", () => {
    expect(validateLandsatGroenkaartManifest({
      ...commonLandsat,
      schemaVersion: 3,
      comparisonId: "landsat-groenkaart",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "groenkaart",
      greenMapYear: 2021,
      minimumGreenCoverage: .8,
      greenClasses: [],
      urbanFabricMaskUrl: "shared/urban-fabric-2021.pmtiles",
    }).comparisonId).toBe("landsat-groenkaart");
    expect(validateLandsatIncomeManifest({
      ...commonLandsat,
      schemaVersion: 2,
      comparisonId: "landsat-income",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "income",
      incomeYear: 2023,
      minimumSectorPixels: 10,
      displayResolutionMeters: 1,
      urbanFabricMaskUrl: "shared/urban-fabric-2021.pmtiles",
    }).comparisonId).toBe("landsat-income");
    expect(validateGroenkaartIncomeManifest({
      schemaVersion: 2,
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
      urbanFabricMaskUrl: "shared/urban-fabric-2021.pmtiles",
      statisticWeighting: "exact-sealed-urban-area",
      urbanFabricCodes: ["11100", "11210", "11220", "11230", "11240"],
    }).comparisonId).toBe("groenkaart-income");
  });

  it("rejects isolated structures or incompatible analytical thresholds", () => {
    expect(() => validateGroenkaartIncomeManifest({
      schemaVersion: 2,
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

  it("uses a continuous green interpolation rather than density bins", () => {
    expect(greenDensityColor(0)).toEqual([247, 252, 245]);
    expect(greenDensityColor(25)).toEqual([199, 233, 192]);
    expect(greenDensityColor(12.5)).toEqual([223, 243, 219]);
    expect(greenDensityColor(42.37)).not.toEqual(greenDensityColor(42));
    expect(greenDensityColor(100)).toEqual([0, 68, 27]);
    expect(surroundingAreaHa(0)).toBe(0);
    expect(surroundingAreaHa(50)).toBeCloseTo(1.5708, 4);
    expect(surroundingAreaHa(100)).toBeCloseTo(3.1416, 4);
  });

  it("uses fixed income boundaries and locates browser pixels", () => {
    expect(incomeLevel(29_999).id).toBe("low");
    expect(incomeLevel(30_000).id).toBe("middle");
    expect(incomeLevel(40_000).id).toBe("high");
    expect(comparisonPixelOffset(commonLandsat, { lng: 4.5, lat: 50.5 })).toBeGreaterThan(0);
    expect(comparisonPixelOffset(commonLandsat, { lng: 2, lat: 50.5 })).toBe(-1);
  });

  it("accepts only the official opaque JaarBAK sealed colour", () => {
    expect(isOfficialSealedPixel(new Uint8ClampedArray([0xe8, 0x29, 0x2f, 255]), 0)).toBe(true);
    expect(isOfficialSealedPixel(new Uint8ClampedArray([0x8e, 0xcf, 0x7c, 255]), 0)).toBe(false);
    expect(isOfficialSealedPixel(new Uint8ClampedArray([0xe8, 0x29, 0x2f, 0]), 0)).toBe(false);
  });
});
