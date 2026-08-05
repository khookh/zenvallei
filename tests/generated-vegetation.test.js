/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const dataRoot = path.resolve(import.meta.dirname, "..", "public", "data");
const vegetation = JSON.parse(await fs.readFile(path.join(dataRoot, "vegetation.json"), "utf8"));
const year = vegetation.years[vegetation.activeYear];

describe("generated likely-vegetation assets", () => {
  it("pins the requested L2A acquisition and processing grid", () => {
    expect(vegetation).toMatchObject({ schemaVersion: 1, available: true, activeYear: 2023, availableYears: [2023] });
    expect(year).toMatchObject({
      acquisitionDate: "2023-06-24",
      crs: "EPSG:32631",
      pixelSizeMeters: 10,
      width: 2474,
      height: 1532,
    });
    expect(vegetation.source.collection).toBe("sentinel-2-l2a");
    expect(vegetation.source.cloudCoverLimitPercentage).toBe(1);
    expect(vegetation.source.products).toEqual([
      expect.objectContaining({ id: "S2A_MSIL2A_20230624T104621_N0510_R051_T31UFS_20240912T071700", cloudCover: 0 }),
      expect.objectContaining({ id: "S2A_MSIL2A_20230624T104621_N0510_R051_T31UES_20240912T071700", cloudCover: 0.98 }),
    ]);
    expect(vegetation.source.responseSha256).toBe("ff486e6f25f0a660a2c0f65fd85f5ea0b0feff99a7a85600b1bb6502a3c6fb5a");
  });

  it("records the exact calibration classes and a defensible threshold", () => {
    expect(vegetation.definitions.calibrationPositiveCodes).toEqual(["14110", "14120", "14130", "23000", "31000", "32000"]);
    expect(vegetation.definitions.calibrationNegativeCodes).toEqual(["11100", "12210"]);
    expect(vegetation.definitions.excludedCodes).toEqual(["21000", "50000"]);
    expect(year.threshold).toBe(0.66);
    expect(year.calibration.positive.count).toBeGreaterThan(300_000);
    expect(year.calibration.negative.count).toBeGreaterThan(20_000);
    expect(year.calibration.auc).toBeGreaterThan(0.9);
    expect(year.calibration.balancedAccuracy).toBeGreaterThan(0.8);
  });

  it("contains reconciled statistics for all 154 sectors", () => {
    expect(Object.keys(year.sectorStats)).toHaveLength(154);
    Object.values(year.sectorStats).forEach((stats) => {
      const sum = stats.likelyVegetatedAreaHa + stats.belowThresholdAreaHa
        + stats.excludedArableAreaHa + stats.excludedWaterAreaHa;
      expect(Math.abs(sum - stats.validAreaHa)).toBeLessThanOrEqual(0.03);
      expect(stats.missingObservationAreaHa + stats.validAreaHa).toBeCloseTo(stats.sectorAreaHa, 1);
      expect(stats.likelyVegetatedPercentage).toBeGreaterThanOrEqual(0);
      expect(stats.likelyVegetatedPercentage).toBeLessThanOrEqual(100);
      expect(stats.medianNdvi === null || (stats.medianNdvi >= -1 && stats.medianNdvi <= 1)).toBe(true);
    });
  });

  it("uses only the exact two visible colours and transparent pixels", async () => {
    const imagePath = path.join(dataRoot, "vegetation", "likely-vegetation-2023.png");
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
  });
});
