/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  VEGETATION_CROPLAND_OVERRIDE_URBAN_ATLAS_CODES,
  VEGETATION_EXCLUDED_LAND_COVER_CODES,
  VEGETATION_EXCLUDED_URBAN_ATLAS_CODES,
  VEGETATION_GRASSLAND_EXCLUSION_URBAN_ATLAS_CODES,
  VEGETATION_GRASSLAND_LAND_COVER_CODES,
  VEGETATION_MASKED_SCL_CODES,
  VEGETATION_NEGATIVE_CODES,
  VEGETATION_PALETTE,
  VEGETATION_POSITIVE_CODES,
  calculateNdvi,
  calibrateNdviThreshold,
  classifyVegetationPixel,
  isValidScenePixel,
  rasterizeProjectedFeatures,
  subpixelVotes,
  vegetationExclusionReason,
} from "../scripts/lib/vegetation-core.mjs";

describe("Sentinel-2 vegetation preparation contract", () => {
  it("uses the exact calibration, exclusion, cloud-mask and palette definitions", () => {
    expect(VEGETATION_POSITIVE_CODES).toEqual(["14110", "14120", "14130", "23000", "31000", "32000"]);
    expect(VEGETATION_NEGATIVE_CODES).toEqual(["11100", "12210"]);
    expect(VEGETATION_EXCLUDED_LAND_COVER_CODES).toEqual([40]);
    expect(VEGETATION_CROPLAND_OVERRIDE_URBAN_ATLAS_CODES).toEqual(["23000"]);
    expect(VEGETATION_GRASSLAND_LAND_COVER_CODES).toEqual([30]);
    expect(VEGETATION_GRASSLAND_EXCLUSION_URBAN_ATLAS_CODES).toEqual(["21000"]);
    expect(VEGETATION_EXCLUDED_URBAN_ATLAS_CODES).toEqual(["50000"]);
    expect(VEGETATION_MASKED_SCL_CODES).toEqual([0, 1, 3, 7, 8, 9, 10, 11]);
    expect(VEGETATION_PALETTE).toEqual({ likelyVegetated: "#238B45", belowThreshold: "#D9DEDA" });
  });

  it("calculates NDVI and rejects invalid observations", () => {
    expect(calculateNdvi(0.1, 0.5)).toBeCloseTo(2 / 3);
    expect(calculateNdvi(0, 0)).toBeNull();
    expect(calculateNdvi(Number.NaN, 0.5)).toBeNull();
    expect(isValidScenePixel(1, 4)).toBe(true);
    expect(isValidScenePixel(0, 4)).toBe(false);
    VEGETATION_MASKED_SCL_CODES.forEach((code) => expect(isValidScenePixel(1, code)).toBe(false));
  });

  it("selects a deterministic Youden threshold and reports calibration performance", () => {
    const positive = [0.7, 0.75, 0.8, 0.85, 0.9];
    const negative = [0.1, 0.15, 0.2, 0.25, 0.3];
    const first = calibrateNdviThreshold(positive, negative);
    const second = calibrateNdviThreshold(positive, negative);
    expect(first).toEqual(second);
    expect(first.threshold).toBeGreaterThan(0.3);
    expect(first.threshold).toBeLessThanOrEqual(0.7);
    expect(first.sensitivity).toBe(1);
    expect(first.specificity).toBe(1);
    expect(first.balancedAccuracy).toBe(1);
    expect(first.auc).toBe(1);
    expect(first.overlapWarning).toBe(false);
  });

  it("handles overlapping distributions, ties and insufficient samples", () => {
    const overlap = calibrateNdviThreshold([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]);
    expect(overlap.auc).toBe(0.5);
    expect(overlap.overlapWarning).toBe(true);
    expect(overlap.threshold).toBeGreaterThanOrEqual(-1);
    expect(overlap.threshold).toBeLessThanOrEqual(1);
    expect(() => calibrateNdviThreshold([], [0.1])).toThrow("geen geldige NDVI-pixels");
    expect(() => calibrateNdviThreshold([0.2], [])).toThrow("geen geldige NDVI-pixels");
  });

  it("applies the agricultural exclusion truth table before NDVI classification", () => {
    const cases = [
      [{ landCoverCode: 40, urbanAtlasCode: "21000" }, "cropland", "excluded"],
      [{ landCoverCode: 40, urbanAtlasCode: "23000" }, null, "likely-vegetated"],
      [{ landCoverCode: 40 }, "cropland", "excluded"],
      [{ landCoverCode: 30, urbanAtlasCode: "21000" }, "cropland", "excluded"],
      [{ landCoverCode: 30, urbanAtlasCode: "23000" }, null, "likely-vegetated"],
      [{ landCoverCode: 30, urbanAtlasCode: "50000" }, "water", "excluded"],
      [{ landCoverCode: 40, urbanAtlasCode: "50000" }, "water", "excluded"],
    ];
    cases.forEach(([classifications, reason, result]) => {
      expect(vegetationExclusionReason(classifications)).toBe(reason);
      expect(classifyVegetationPixel(0.9, true, classifications, 0.66)).toBe(result);
    });
    expect(classifyVegetationPixel(0.4, true, { landCoverCode: 40, urbanAtlasCode: "23000" }, 0.66)).toBe("below-threshold");
    expect(classifyVegetationPixel(0.4, true, { landCoverCode: 30, urbanAtlasCode: "31000" }, 0.66)).toBe("below-threshold");
    expect(classifyVegetationPixel(0.9, false, { landCoverCode: 30, urbanAtlasCode: "31000" }, 0.66)).toBe("no-data");
  });

  it("supports the nine-point pure-reference vote rule", () => {
    const feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [[[[0, 10], [10, 10], [10, 0], [0, 0], [0, 10]]]],
      },
    };
    const raster = rasterizeProjectedFeatures(
      [feature],
      { minX: 0, maxY: 10, width: 1, height: 1, resolution: 10 },
      () => 7,
      { scale: 3, ArrayType: Uint8Array },
    );
    expect(subpixelVotes(raster, 0, 0)).toEqual([[7, 9]]);
  });
});
