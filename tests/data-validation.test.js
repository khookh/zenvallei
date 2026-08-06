import { describe, expect, it } from "vitest";
import { assertSupportedSchema, schemaVersionOf, validateApplicationData } from "../src/data-validation.js";

function validPayload() {
  return {
    geojson: {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { sectorId: "A", municipality: "Halle" },
        geometry: { type: "MultiPolygon", coordinates: [[[[4, 50], [4.1, 50], [4, 50]]]] },
      }],
    },
    scorePayload: { schemaVersion: 1, sectors: { A: { sectorId: "A" } } },
    methodology: { schemaVersion: 1, palette: {}, vulnerabilityComponents: [] },
    provenance: { schemaVersion: 1, output: { sectorCount: 1 } },
    landCover: null,
    urbanAtlas: null,
    vegetation: null,
  };
}

describe("browser data contracts", () => {
  it("treats legacy unversioned payloads as version 1", () => {
    expect(schemaVersionOf({})).toBe(1);
    expect(assertSupportedSchema("scores", {})).toBe(1);
    expect(assertSupportedSchema("vegetation", { schemaVersion: 3 })).toBe(3);
    expect(assertSupportedSchema("vegetation", { schemaVersion: 4 })).toBe(4);
  });

  it("rejects unsupported schema versions with a readable error", () => {
    expect(() => assertSupportedSchema("urbanAtlas", { schemaVersion: 99 }))
      .toThrow("unsupported schema version 99");
  });

  it("accepts matching sector, score, methodology and provenance data", () => {
    const result = validateApplicationData(validPayload());
    expect([...result.sectorIds]).toEqual(["A"]);
  });

  it("rejects missing or extra sector statistics before map startup", () => {
    const payload = validPayload();
    payload.scorePayload.sectors.B = { sectorId: "B" };
    expect(() => validateApplicationData(payload)).toThrow("Score and geometry sector identifiers differ");
  });

  it("validates the active vegetation year and sector statistics", () => {
    const payload = validPayload();
    payload.vegetation = {
      schemaVersion: 1,
      available: true,
      activeYear: 2023,
      years: {
        2023: {
          imageUrl: "data/vegetation/test.png",
          coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
          threshold: 0.66,
          sectorStats: { A: {} },
        },
      },
    };
    expect(() => validateApplicationData(payload)).not.toThrow();
    delete payload.vegetation.years[2023].sectorStats.A;
    expect(() => validateApplicationData(payload)).toThrow("contains 0 sector records");
  });

  it("requires the complete Statbel area denominator for vegetation schema 4", () => {
    const payload = validPayload();
    payload.vegetation = {
      schemaVersion: 4,
      available: true,
      activeYear: 2020,
      availableYears: [2020],
      definitions: { headlineDenominator: "valid-observed-area" },
      years: {
        2020: {
          imageUrl: "data/vegetation/test.png",
          coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
          threshold: 0.697,
          sectorStats: { A: {} },
        },
      },
    };
    expect(() => validateApplicationData(payload)).toThrow("complete Statbel sector area denominator");
    payload.vegetation.definitions.headlineDenominator = "complete-statbel-sector-area";
    expect(() => validateApplicationData(payload)).not.toThrow();
  });
});
