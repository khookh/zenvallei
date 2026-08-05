/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createGrid } from "../scripts/lib/landcover-core.mjs";

const dataDir = path.resolve(import.meta.dirname, "..", "public", "data");
const readJson = async (file) => JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));

describe("generated Zennevallei data contract", () => {
  it("contains an exact, one-to-one 154-sector geometry join", async () => {
    const [geojson, scores, provenance] = await Promise.all([
      readJson("sectors.geojson"),
      readJson("scores.json"),
      readJson("provenance.json"),
    ]);
    const featureIds = geojson.features.map((feature) => feature.properties.sectorId);
    expect(geojson.features).toHaveLength(154);
    expect(new Set(featureIds).size).toBe(154);
    expect(geojson.features.every((feature) => feature.geometry.type === "MultiPolygon" && feature.geometry.coordinates.length > 0)).toBe(true);
    expect(Object.keys(scores.sectors)).toHaveLength(154);
    expect(provenance.output.sectorCount).toBe(154);
    expect(provenance.output.inputVertices).toBe(provenance.output.outputVertices);
    expect(provenance.output.inputVertices).toBe(28693);
  });

  it("pins the verified municipalities and source states", async () => {
    const [scores, provenance] = await Promise.all([readJson("scores.json"), readJson("provenance.json")]);
    expect(provenance.output.municipalityCounts).toEqual({
      Beersel: 39,
      Drogenbos: 7,
      Halle: 41,
      Linkebeek: 7,
      Pepingen: 15,
      "Sint-Genesius-Rode": 22,
      "Sint-Pieters-Leeuw": 23,
    });
    expect(provenance.output.scoredCount).toBe(140);
    expect(provenance.output.insufficientDataCount).toBe(14);
    expect(scores.sectors["23027A183"].status).toBe("insufficient-data");
    expect(scores.sectors["23027A183"].scores.final).toBeNull();
  });

  it("preserves known score values and the corrected Statbel display name", async () => {
    const scores = await readJson("scores.json");
    const beersel = scores.sectors["23003A001"];
    expect(beersel.scores.final).toBe(6);
    expect(beersel.scores.heat).toBe(7);
    expect(beersel.scores.vulnerability).toBe(8);
    expect(beersel.scores.components.sesIndex).toBe(3.75);
    expect(scores.sectors["23077D00-"].sectorName).toBe("VLEZENBEEK-KERN");
    expect(scores.sectors["23077D00-"].workbookSectorName).toBe("VLEZENBEK-KERN");
  });

  it("keeps all output coordinates in plausible WGS84 bounds", async () => {
    const provenance = await readJson("provenance.json");
    expect(provenance.output.targetCrs).toBe("EPSG:4326");
    expect(provenance.output.bounds.minLon).toBeGreaterThan(3.5);
    expect(provenance.output.bounds.maxLon).toBeLessThan(5.5);
    expect(provenance.output.bounds.minLat).toBeGreaterThan(49.5);
    expect(provenance.output.bounds.maxLat).toBeLessThan(51.5);
  });

  it("defines every rendering class, including the future sentinel fixture", async () => {
    const methodology = await readJson("methodology.json");
    expect(methodology.palette).toEqual({
      "no-data": "#EAE2DE",
      "score-0": "#97D8E5",
      "score-1": "#6EC3ED",
      "score-2": "#6AA7F0",
      "score-3": "#8E85E2",
      "score-4": "#B657BA",
      "score-5": "#CC017A",
      "score-6": "#B10064",
      "score-7": "#96004E",
      "score-8": "#7C003A",
      "score-9": "#610027",
      "score-10": "#000000",
      "institution-present-no-score": "#F1CE63",
    });
  });

  it("publishes the documented weights and all eight SES details", async () => {
    const methodology = await readJson("methodology.json");
    expect(Object.fromEntries(methodology.vulnerabilityComponents.map(({ key, weight }) => [key, weight]))).toEqual({
      populationDensity: 1,
      age0To9: 1,
      age65Plus: 1,
      primaryEducation: 0.5,
      childcare: 0.5,
      residentialElderlyCare: 0.5,
      hospitals: 0.5,
      sesIndex: 2,
      trees50m: 0.5,
      neighborhoodGreen: 0.5,
    });
    expect(Object.fromEntries(methodology.vulnerabilityComponents.map(({ key, groupKey }) => [key, groupKey]))).toEqual({
      populationDensity: "population",
      age0To9: "population",
      age65Plus: "population",
      primaryEducation: "facilities",
      childcare: "facilities",
      residentialElderlyCare: "facilities",
      hospitals: "facilities",
      sesIndex: "socioeconomic",
      trees50m: "green",
      neighborhoodGreen: "green",
    });
    expect(methodology.sesComponents).toHaveLength(8);
  });

  it("publishes the prepared pinned Copernicus raster without pretending 2026 exists", async () => {
    const landCover = await readJson("land-cover.json");
    expect(landCover.source).toMatchObject({
      dataset: "lcm_global_10m_yearly_v1",
      year: 2020,
      productId: "0d1a8740-7798-4c23-b057-beffba83cccd",
      expectedMd5: "a71128e04beb6f1a148af7557db17179",
      expectedBytes: 104123112,
      contentType: "application/tiff",
    });
    expect(landCover.classes).toHaveLength(12);
    expect(landCover.availableYears).toEqual([2020]);
    expect(landCover.raster).toMatchObject({
      available: true,
      year: 2020,
      imageUrl: "data/land-cover/land-cover-2020.png",
      width: 2479,
      height: 1537,
    });
    expect(landCover.source).toMatchObject({
      md5: landCover.source.expectedMd5,
      byteLength: landCover.source.expectedBytes,
      crs: "EPSG:4326",
    });
    expect(Object.keys(landCover.sectorStats)).toHaveLength(154);
    expect(landCover.schemaVersion).toBe(2);
    expect(Object.values(landCover.sectorStats).every(({ classifiedAreaHa }) => classifiedAreaHa > 0)).toBe(true);
    expect(Object.values(landCover.sectorStats).every((stats) => !Object.hasOwn(stats, "mappedAreaHa"))).toBe(true);
    expect(Object.values(landCover.sectorStats).every(({ vegetationPercentage, builtUpPercentage }) => (
      vegetationPercentage >= 0 && vegetationPercentage <= 100
      && builtUpPercentage >= 0 && builtUpPercentage <= 100
    ))).toBe(true);
    expect(landCover.classes.filter(({ present }) => present)).toHaveLength(8);

    const pngPath = path.join(dataDir, "land-cover", "land-cover-2020.png");
    const { width, height, channels } = await sharp(pngPath).metadata();
    const { channels: channelStats } = await sharp(pngPath).stats();
    expect({ width, height, channels }).toEqual({ width: 2479, height: 1537, channels: 4 });
    expect(channelStats[3].min).toBe(0);
    expect(channelStats[3].max).toBe(255);
    expect(Object.keys(landCover.raster.rasterVariants)).toHaveLength(8);
    for (const [municipality, assetUrl] of Object.entries(landCover.raster.rasterVariants)) {
      if (municipality === "all") continue;
      const { channels: municipalityChannels } = await sharp(path.join(dataDir, "..", assetUrl)).stats();
      expect(municipalityChannels[3].max).toBe(255);
      expect(municipalityChannels[3].mean).toBeGreaterThan(0);
      expect(municipalityChannels[3].mean).toBeLessThan(channelStats[3].mean);
    }
    expect(landCover.vegetationCodes).toEqual([10, 30]);
    expect(landCover.builtUpCodes).toEqual([90]);
    expect(landCover.metricDefinitions).toEqual({
      vegetation: {
        classCodes: [10, 30],
        denominator: "classified-area",
        description: "Tree cover and grassland only; cropland and all other LCM-10 classes are excluded.",
      },
      builtUp: {
        classCodes: [90],
        denominator: "classified-area",
        description: "LCM-10 built-up class; this is a classification estimate, not a cadastral or soil-sealing measurement.",
      },
    });
    expect(landCover.change).toMatchObject({
      available: false,
      baseYear: 2020,
      comparisonYear: 2026,
      reason: "comparison-year-not-published",
    });
  });

  it("derives the approximately 2,500 by 1,550 Web Mercator output grid", async () => {
    const provenance = await readJson("provenance.json");
    const { minLon, minLat, maxLon, maxLat } = provenance.output.bounds;
    const grid = createGrid([[minLon, minLat], [maxLon, maxLat]], 10);
    expect(grid.width).toBe(2479);
    expect(grid.height).toBe(1537);
    expect(grid.coordinates).toEqual([
      [minLon, maxLat], [maxLon, maxLat], [maxLon, minLat], [minLon, minLat],
    ]);
  });
});
