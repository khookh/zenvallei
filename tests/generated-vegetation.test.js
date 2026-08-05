/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const dataRoot = path.resolve(import.meta.dirname, "..", "public", "data");
const vegetation = JSON.parse(await fs.readFile(path.join(dataRoot, "vegetation.json"), "utf8"));
const year = vegetation.years[vegetation.activeYear];

describe("generated likely-vegetation assets", () => {
  it("pins one selected L2A observation for every archive year", () => {
    expect(vegetation).toMatchObject({
      schemaVersion: 2,
      available: true,
      activeYear: 2026,
      availableYears: [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
    });
    expect(year).toMatchObject({
      acquisitionDate: "2026-06-20",
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

  it("records the exact calibration classes and a defensible threshold", () => {
    expect(vegetation.definitions.calibrationPositiveCodes).toEqual(["14110", "14120", "14130", "23000", "31000", "32000"]);
    expect(vegetation.definitions.calibrationNegativeCodes).toEqual(["11100", "12210"]);
    expect(vegetation.definitions.calibrationYear).toBe(2023);
    expect(vegetation.definitions.excludedLandCoverCodes).toEqual([40]);
    expect(vegetation.definitions.excludedUrbanAtlasCodes).toEqual(["50000"]);
    expect(year.threshold).toBe(0.66);
    expect(year.calibration.positive.count).toBeGreaterThan(300_000);
    expect(year.calibration.negative.count).toBeGreaterThan(20_000);
    expect(year.calibration.auc).toBeGreaterThan(0.9);
    expect(year.calibration.balancedAccuracy).toBeGreaterThan(0.8);
  });

  it("contains reconciled statistics for all 154 sectors", () => {
    Object.values(vegetation.years).forEach((entry) => {
      expect(Object.keys(entry.sectorStats)).toHaveLength(154);
      Object.values(entry.sectorStats).forEach((stats) => {
        const sum = stats.likelyVegetatedAreaHa + stats.belowThresholdAreaHa
          + stats.excludedCroplandAreaHa + stats.excludedWaterAreaHa;
        expect(Math.abs(sum - stats.validAreaHa)).toBeLessThanOrEqual(0.03);
        expect(stats.missingObservationAreaHa + stats.validAreaHa).toBeCloseTo(stats.sectorAreaHa, 1);
        expect(stats.likelyVegetatedPercentage).toBeGreaterThanOrEqual(0);
        expect(stats.likelyVegetatedPercentage).toBeLessThanOrEqual(100);
        expect(stats.medianNdvi === null || (stats.medianNdvi >= -1 && stats.medianNdvi <= 1)).toBe(true);
      });
    });
    expect([2015, 2017, 2024, 2025].every((warningYear) => vegetation.years[warningYear].quality.status === "warning")).toBe(true);
  });

  it("uses only the exact two visible colours and transparent pixels", async () => {
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
    expect(colours).toEqual(new Set(["#238B45", "#D9DEDA"]));
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
