/* @vitest-environment node */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFICIAL_CODES, GREEN_CODES, URBAN_ATLAS_CLASSES } from "../scripts/lib/urban-atlas-core.mjs";
import { URBAN_ATLAS_ARTIFACTS } from "../scripts/prepare-urban-atlas.mjs";

const dataDir = path.resolve(import.meta.dirname, "..", "public", "data");
const manifestPath = path.join(dataDir, "urban-atlas.json");
const geometryPath = path.join(dataDir, "urban-atlas.geojson");
const generated = existsSync(manifestPath) && existsSync(geometryPath);
const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

describe.skipIf(!generated)("generated Urban Atlas data contract", () => {
  it("pins the official product and all 154 sector summaries", async () => {
    const manifest = await readJson(manifestPath);
    expect(manifest).toMatchObject({ available: true, activeYear: 2021, schemaVersion: 1 });
    expect(manifest.source).toMatchObject({
      dataset: "clms_ua_land-cover-land-use_europe_V025ha_3yearly_v1",
      fuaCode: "BE001L3",
      productId: "cb6a69ee-dbd7-41ec-bc35-d705d5d71b33",
      expectedBytes: 178900771,
      expectedMd5: "eae385ced547b8fab079e33fa81e03fd",
      crs: "EPSG:3035",
    });
    expect(URBAN_ATLAS_ARTIFACTS.some((artifact) => artifact.byteLength === manifest.source.byteLength
      && artifact.md5 === manifest.source.md5
      && artifact.key === manifest.source.artifactKey)).toBe(true);
    expect(Object.keys(manifest.sectorStats)).toHaveLength(154);
    expect(manifest.processing.municipalityCounts).toEqual({
      Beersel: 39,
      Drogenbos: 7,
      Halle: 41,
      Linkebeek: 7,
      Pepingen: 15,
      "Sint-Genesius-Rode": 22,
      "Sint-Pieters-Leeuw": 23,
    });
  });

  it("uses the exact metrics, official colours and present-only legend", async () => {
    const [manifest, geometry] = await Promise.all([readJson(manifestPath), readJson(geometryPath)]);
    expect(manifest.greenCodes).toEqual(GREEN_CODES);
    expect(manifest.greenCodes).toContain("23000");
    expect(manifest.greenCodes).toContain("32000");
    expect(manifest.artificialCodes).toEqual(ARTIFICIAL_CODES);
    expect(manifest.greenCodes.some((code) => manifest.artificialCodes.includes(code))).toBe(false);
    const officialPalette = Object.fromEntries(URBAN_ATLAS_CLASSES.map(({ code, color }) => [code, color]));
    expect(Object.fromEntries(manifest.classes.map(({ code, color }) => [code, color]))).toEqual(officialPalette);
    const geometryCodes = [...new Set(geometry.features.map((feature) => feature.properties.classCode))].sort();
    expect(manifest.classes.filter(({ present }) => present).map(({ code }) => code).sort()).toEqual(geometryCodes);
  });

  it("publishes valid WGS84 MultiPolygons with complete sector coverage", async () => {
    const [manifest, geometry] = await Promise.all([readJson(manifestPath), readJson(geometryPath)]);
    expect(geometry.type).toBe("FeatureCollection");
    expect(geometry.features.length).toBeGreaterThan(154);
    for (const feature of geometry.features) {
      expect(feature.geometry.type).toBe("MultiPolygon");
      expect(feature.geometry.coordinates.length).toBeGreaterThan(0);
      expect(manifest.sectorStats[feature.properties.sectorId]).toBeDefined();
      const [longitude, latitude] = feature.geometry.coordinates[0][0][0];
      expect(longitude).toBeGreaterThan(3.5);
      expect(longitude).toBeLessThan(5.5);
      expect(latitude).toBeGreaterThan(49.5);
      expect(latitude).toBeLessThan(51.5);
    }
    for (const stats of Object.values(manifest.sectorStats)) {
      expect(stats.coveragePercentage).toBeGreaterThanOrEqual(99.5);
      expect(Math.abs(stats.sectorAreaHa - stats.validAreaHa - stats.noDataAreaHa)).toBeLessThanOrEqual(0.01);
      expect(stats.green.classes.map(({ code }) => code)).toEqual(["31000", "32000", "23000", "14110", "14120", "14130"]);
      expect(stats.green.percentage).toBeGreaterThanOrEqual(0);
      expect(stats.green.percentage).toBeLessThanOrEqual(100);
      expect(stats.artificial.percentage).toBeGreaterThanOrEqual(0);
      expect(stats.artificial.percentage).toBeLessThanOrEqual(100);
    }
  });
});
