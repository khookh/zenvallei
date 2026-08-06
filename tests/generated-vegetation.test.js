/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const dataRoot = path.resolve(import.meta.dirname, "..", "public", "data");
const vegetation = JSON.parse(await fs.readFile(path.join(dataRoot, "vegetation.json"), "utf8"));
const year = vegetation.years[vegetation.activeYear];

describe("generated likely-vegetation assets", () => {
  it("publishes only the selected 2020 L2A observation", () => {
    expect(vegetation).toMatchObject({
      schemaVersion: 4,
      available: true,
      activeYear: 2020,
      availableYears: [2020],
    });
    expect(year).toMatchObject({
      acquisitionDate: "2020-06-24",
      crs: "EPSG:32631",
      pixelSizeMeters: 10,
      width: 2474,
      height: 1532,
    });
    expect(vegetation.source.collection).toBe("sentinel-2-l2a");
    expect(Object.values(vegetation.years).every((entry) => entry.products.length >= 2)).toBe(true);
    expect(Object.values(vegetation.years).every((entry) => entry.quality.coveragePercentage >= 99.5)).toBe(true);
    expect(Object.keys(year.rasterVariants)).toHaveLength(8);
  });

  it("records the exact calibration classes and a defensible 2020 threshold", () => {
    expect(vegetation.definitions.calibrationPositiveCodes).toEqual(["14110", "14120", "14130", "23000", "31000", "32000"]);
    expect(vegetation.definitions.calibrationNegativeCodes).toEqual(["11100", "12210"]);
    expect(vegetation.definitions.thresholdMode).toBe("annual-per-observation");
    expect(vegetation.definitions).not.toHaveProperty("calibrationYear");
    expect(vegetation.definitions).not.toHaveProperty("frozenThreshold");
    expect(vegetation.definitions.agriculturalExclusionRules).toEqual([
      { landCoverCode: 40, excludeUnlessUrbanAtlasCodes: ["23000"] },
      { landCoverCode: 30, excludeWhenUrbanAtlasCodes: ["21000"] },
    ]);
    expect(vegetation.definitions.excludedUrbanAtlasCodes).toEqual(["50000"]);
    expect(vegetation.exclusionSource).toMatchObject({
      referenceYear: 2020,
      landCoverClassCodes: [30, 40],
      urbanAtlasReferenceYear: 2021,
      pastureOverrideClassCode: "23000",
      arableExclusionClassCode: "21000",
      waterClassCode: "50000",
    });
    expect(vegetation.processing.agriculturalOverlap).toEqual({
      pixelAreaHa: 0.01,
      croplandPasturePixels: 35_696,
      croplandPastureAreaHa: 356.96,
      grasslandArablePixels: 231_394,
      grasslandArableAreaHa: 2313.94,
    });
    expect(Object.keys(vegetation.years)).toEqual(["2020"]);
    expect(year.threshold).toBe(0.697);
    Object.values(vegetation.years).forEach((entry) => {
      expect(entry.threshold).toBe(entry.calibration.threshold);
      expect(entry.threshold).toBeGreaterThanOrEqual(-1);
      expect(entry.threshold).toBeLessThanOrEqual(1);
      expect(entry.calibration.positive.count).toBeGreaterThan(200_000);
      expect(entry.calibration.negative.count).toBeGreaterThan(10_000);
      expect(entry.calibration.auc).toBeGreaterThan(0.85);
      expect(entry.calibration.balancedAccuracy).toBeGreaterThan(0.8);
    });
  });

  it("contains reconciled statistics for all 154 sectors", () => {
    let sectorWithMissingObservation = null;
    Object.values(vegetation.years).forEach((entry) => {
      expect(Object.keys(entry.sectorStats)).toHaveLength(154);
      Object.values(entry.sectorStats).forEach((stats) => {
        const sum = stats.likelyVegetatedAreaHa + stats.belowThresholdAreaHa
          + stats.excludedCroplandAreaHa + stats.excludedWaterAreaHa;
        expect(Math.abs(sum - stats.validAreaHa)).toBeLessThanOrEqual(0.03);
        expect(stats.missingObservationAreaHa + stats.validAreaHa).toBeCloseTo(stats.sectorAreaHa, 1);
        expect(Math.abs(stats.likelyVegetatedPercentage
          - stats.likelyVegetatedAreaHa / stats.sectorAreaHa * 100)).toBeLessThanOrEqual(0.1);
        expect(Math.abs(stats.belowThresholdPercentage
          - stats.belowThresholdAreaHa / stats.sectorAreaHa * 100)).toBeLessThanOrEqual(0.1);
        expect(stats.likelyVegetatedPercentage).toBeGreaterThanOrEqual(0);
        expect(stats.likelyVegetatedPercentage).toBeLessThanOrEqual(100);
        expect(stats.medianNdvi === null || (stats.medianNdvi >= -1 && stats.medianNdvi <= 1)).toBe(true);
        if (stats.missingObservationAreaHa > 0.05 && stats.likelyVegetatedAreaHa > 0) {
          sectorWithMissingObservation = stats;
        }
      });
    });
    expect(vegetation.definitions.headlineDenominator).toBe("complete-statbel-sector-area");
    expect(sectorWithMissingObservation).not.toBeNull();
    expect(sectorWithMissingObservation.likelyVegetatedPercentage)
      .toBeLessThan(sectorWithMissingObservation.likelyVegetatedAreaHa / sectorWithMissingObservation.validAreaHa * 100);
  });

  it("contains no browser rasters for unpublished years", async () => {
    const files = (await fs.readdir(path.join(dataRoot, "vegetation")))
      .filter((file) => file.startsWith("likely-vegetation-") && file.endsWith(".png"));
    expect(files).toHaveLength(8);
    expect(files.every((file) => file.startsWith("likely-vegetation-2020"))).toBe(true);
  });

  it("uses only the exact green class and transparent pixels", async () => {
    const imagePath = path.join(dataRoot, "vegetation", `likely-vegetation-${vegetation.activeYear}.png`);
    const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(2474);
    expect(info.height).toBe(1532);
    const colours = new Set();
    let transparent = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) transparent += 1;
      else colours.add(`#${Buffer.from(data.subarray(index, index + 3)).toString("hex").toUpperCase()}`);
    }
    expect(colours).toEqual(new Set(["#238B45"]));
    expect(transparent).toBeGreaterThan(0);
    for (const [municipality, assetUrl] of Object.entries(year.rasterVariants)) {
      if (municipality === "all") continue;
      const { channels } = await sharp(path.join(dataRoot, "..", assetUrl)).stats();
      expect(channels[3].max).toBe(255);
      expect(channels[3].mean).toBeGreaterThan(0);
      expect(channels[3].mean).toBeLessThan(255 - transparent / (info.width * info.height) * 255);
    }
  });
});
