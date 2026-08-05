/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  BUILT_UP_CODES,
  CHANGE_CLASSES,
  LCM_CLASSES,
  VEGETATION_CODES,
  buildLandCoverOutput,
  classifyVegetationChange,
  detectRasterContainer,
  lonLatToMercator,
  rasterizeSectorMask,
  resampleClasses,
  summarizeVegetationChange,
} from "../scripts/landcover-core.mjs";

function fixtureGrid() {
  const [minX, minY] = lonLatToMercator([4, 50]);
  const [maxX, maxY] = lonLatToMercator([4.04, 50.04]);
  return { width: 4, height: 4, projectedBounds: { minX, minY, maxX, maxY } };
}

const geojson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { sectorId: "LEFT" },
      geometry: { type: "MultiPolygon", coordinates: [[[[4, 50], [4.02, 50], [4.02, 50.04], [4, 50.04], [4, 50]]]] },
    },
    {
      type: "Feature",
      properties: { sectorId: "RIGHT" },
      geometry: { type: "MultiPolygon", coordinates: [[[[4.02, 50], [4.04, 50], [4.04, 50.04], [4.02, 50.04], [4.02, 50]]]] },
    },
  ],
};

describe("LCM-10 preparation core", () => {
  it("detects CDSE ZIP envelopes independently of a misleading .tif filename", () => {
    expect(detectRasterContainer(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(detectRasterContainer(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe("tiff");
    expect(detectRasterContainer(Buffer.from([0x4d, 0x4d, 0x00, 0x2b]))).toBe("tiff");
    expect(detectRasterContainer(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe("unknown");
  });

  it("pins the official palette and defines green cover as trees plus grass only", () => {
    expect(Object.fromEntries(LCM_CLASSES.map(({ code, color }) => [code, color]))).toEqual({
      10: "#006400", 20: "#ffbb22", 30: "#ffff4c", 40: "#f096ff",
      50: "#0096a0", 60: "#00cf75", 70: "#fae6a0", 80: "#b4b4b4",
      90: "#fa0000", 100: "#0064c8", 110: "#f0f0f0", 254: "#0a0a0a",
    });
    expect(VEGETATION_CODES).toEqual([10, 30]);
    expect(BUILT_UP_CODES).toEqual([90]);
    expect(LCM_CLASSES.find(({ code }) => code === 40).vegetation).toBe(false);
    expect(CHANGE_CLASSES).toEqual([
      { key: "gained", color: "#009E73" },
      { key: "lost", color: "#D55E00" },
    ]);
  });

  it("rasterizes every test pixel to exactly one sector and produces sector statistics", () => {
    const grid = fixtureGrid();
    const sectorMask = rasterizeSectorMask(geojson, grid);
    expect([...sectorMask.mask].filter((value) => value === 1)).toHaveLength(8);
    expect([...sectorMask.mask].filter((value) => value === 2)).toHaveLength(8);
    const classes = Uint8Array.from([
      10, 10, 90, 90,
      10, 30, 90, 100,
      40, 40, 30, 30,
      254, 40, 30, 0,
    ]);
    const output = buildLandCoverOutput(classes, sectorMask, grid, geojson);
    expect(Object.keys(output.sectorStats)).toEqual(["LEFT", "RIGHT"]);
    expect(output.sectorStats.LEFT.vegetationPercentage).toBeGreaterThan(55);
    expect(output.sectorStats.LEFT.vegetationPercentage).toBeLessThan(60);
    expect(output.sectorStats.RIGHT.builtUpPercentage).toBeGreaterThan(40);
    expect(output.sectorStats.RIGHT.builtUpAreaHa).toBeGreaterThan(0);
    expect(output.sectorStats.LEFT).not.toHaveProperty("mappedAreaHa");
    expect(output.sectorStats.LEFT).toHaveProperty("classifiedAreaHa");
    expect(output.sectorStats.RIGHT.dominantClassCode).toBe(30);
    expect(output.rgba[3]).toBe(255);
    expect(output.rgba.at(-1)).toBe(0);
    expect([...output.rgba].filter((_, index) => index % 4 === 3 && output.rgba[index] === 255)).toHaveLength(15);
  });

  it("aligns a geographic source window to the Web Mercator target with nearest-neighbour sampling", () => {
    const source = {
      data: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 254, 10, 30, 40, 90]),
      width: 4,
      height: 4,
      window: [0, 0, 4, 4],
      origin: [4, 50.04],
      resolution: [0.01, -0.01],
    };
    expect([...resampleClasses(source, fixtureGrid())]).toEqual([...source.data]);
  });

  it("marks only gained and lost vegetation while ignoring stable and invalid pixels", () => {
    const before = Uint8Array.from([90, 10, 40, 30, 254, 0]);
    const after = Uint8Array.from([10, 90, 30, 40, 10, 10]);
    const mask = Uint16Array.from([1, 1, 1, 1, 1, 1]);
    const result = classifyVegetationChange(before, after, mask);
    expect([...result.states]).toEqual([1, 2, 1, 2, 0, 0]);
    expect([...result.rgba.slice(0, 4)]).toEqual([0, 158, 115, 255]);
    expect([...result.rgba.slice(4, 8)]).toEqual([213, 94, 0, 255]);
  });

  it("summarizes gained, lost and unchanged vegetation by latitude-corrected sector area", () => {
    const grid = fixtureGrid();
    const sectorMask = rasterizeSectorMask(geojson, grid);
    const before = Uint8Array.from([
      90, 10, 10, 90,
      10, 10, 90, 90,
      40, 40, 30, 30,
      90, 90, 100, 100,
    ]);
    const after = Uint8Array.from([
      10, 90, 30, 90,
      30, 10, 10, 90,
      40, 30, 90, 30,
      90, 10, 100, 254,
    ]);
    const stats = summarizeVegetationChange(before, after, sectorMask, grid, geojson);
    expect(stats.LEFT.gainedAreaHa).toBeGreaterThan(0);
    expect(stats.LEFT.lostAreaHa).toBeGreaterThan(0);
    expect(stats.LEFT.unchangedVegetationAreaHa).toBeGreaterThan(0);
    expect(stats.RIGHT.gainedAreaHa).toBeGreaterThan(0);
    expect(stats.RIGHT.comparedAreaHa).toBeGreaterThan(stats.RIGHT.gainedAreaHa);
    expect(stats.RIGHT.gainedPercentage).toBeGreaterThan(0);
    expect(stats.RIGHT.lostPercentage).toBeGreaterThan(0);
  });
});
