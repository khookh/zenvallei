import { describe, expect, it } from "vitest";
import { validateGroenkaartIncomeManifest } from "../src/comparisons/groenkaart-income.js";
import { validateLandsatGroenkaartManifest } from "../src/comparisons/landsat-groenkaart.js";
import { validateLandsatIncomeManifest } from "../src/comparisons/landsat-income.js";
import { isOfficialSealedPixel } from "../src/comparisons/exact-sealed-raster.js";
import {
  comparisonPixelOffset, greenDensityColor, incomeLevel, ordinaryLeastSquares, selectedDensity,
  surroundingAreaHa, hasUrbanSurfaceContract,
} from "../src/comparisons/sealed-urban-shared.js";

const commonLandsat = {
  schemaVersion: 6,
  urbanAtlasYear: 2021,
  analysisResolutionMeters: 30,
  densityNonGreenUrl: "landsat-groenkaart/green-density-non-green.png",
  scopeIndexUrl: "landsat-groenkaart/scope-index.png",
  municipalityIndexes: { Halle: 1 },
  coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
  imageSize: [100, 100],
  maskResolutionMeters: 1,
  temperatureResolutionMeters: 30,
  aggregation: "exact-masked-area",
  minimumAnalysedAreaHa: 0.1,
  minimumPixelMaskedAreaM2: 1,
  observations: { observation: { displayDataUrl: "shared/display.png", pointDataUrl: "points.json" } },
};
const surfaceContract = {
  urbanAtlasClassMaskUrl: "shared/urban-atlas-classes-2021.pmtiles",
  urbanAtlasClassIndexes: { 11100: 1, 12100: 2 },
  urbanSurfaceGroups: [
    { id: "residential", codes: ["11100", "11210", "11220", "11230", "11240"] },
    { id: "employmentInstitutional", codes: ["12100"] },
  ],
  defaultUrbanSurfaceGroups: ["residential", "employmentInstitutional"],
};

describe("sealed urban comparison contracts", () => {
  it("requires both exact Urban Atlas surface groups by default", () => {
    expect(hasUrbanSurfaceContract(surfaceContract)).toBe(true);
    expect(hasUrbanSurfaceContract({
      ...surfaceContract,
      defaultUrbanSurfaceGroups: ["residential"],
    })).toBe(false);
    expect(hasUrbanSurfaceContract({
      ...surfaceContract,
      urbanSurfaceGroups: [{ id: "residential", codes: ["11100"] }],
    })).toBe(false);
  });

  it("validates the three explicit products", () => {
    expect(validateLandsatGroenkaartManifest({
      ...commonLandsat,
      schemaVersion: 6,
      comparisonId: "landsat-groenkaart",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "groenkaart",
      greenMapYear: 2021,
      greenClasses: [],
      urbanFabricMaskUrl: "shared/urban-fabric-2021.pmtiles",
      ...surfaceContract,
    }).comparisonId).toBe("landsat-groenkaart");
    expect(validateLandsatIncomeManifest({
      ...commonLandsat,
      schemaVersion: 4,
      comparisonId: "landsat-income",
      primaryLayerId: "landsat-temperature",
      secondaryLayerId: "income",
      incomeYear: 2023,
      minimumAnalysedAreaHa: 0.1,
      maskResolutionMeters: 1,
      temperatureResolutionMeters: 30,
      aggregation: "exact-masked-area",
      displayResolutionMeters: 1,
      ...surfaceContract,
    }).comparisonId).toBe("landsat-income");
    expect(validateGroenkaartIncomeManifest({
      schemaVersion: 4,
      comparisonId: "groenkaart-income",
      primaryLayerId: "groenkaart",
      secondaryLayerId: "income",
      greenMapYear: 2021,
      urbanAtlasYear: 2021,
      jaarbakYear: 2021,
      incomeYear: 2023,
      analysisResolutionMeters: 10,
      maskResolutionMeters: 1,
      aggregation: "exact-masked-area",
      minimumAnalysedAreaHa: 0.1,
      scopeIndexUrl: "groenkaart-income/scope-index.png",
      densityNonGreenUrl: "groenkaart-income/density-non-green.png",
      municipalityIndexes: { Halle: 1 },
      ...surfaceContract,
      statisticWeighting: "exact-sealed-urban-area",
      urbanFabricCodes: ["11100", "11210", "11220", "11230", "11240"],
    }).comparisonId).toBe("groenkaart-income");
  });

  it("rejects isolated structures or incompatible analytical thresholds", () => {
    expect(() => validateGroenkaartIncomeManifest({
      schemaVersion: 3,
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
    ], "income", "density")).toMatchObject({
      count: 3, slope: .001, intercept: -10, rSquared: 1, pearsonR: 1, spearmanRho: 1,
    });
    const tied = ordinaryLeastSquares([
      { x: 1, y: 3 }, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 5 },
    ], "x", "y");
    expect(tied.spearmanRho).toBeCloseTo(0.948683298, 6);
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
