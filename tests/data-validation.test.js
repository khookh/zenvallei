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
  };
}

describe("browser data contracts", () => {
  it("treats legacy unversioned payloads as version 1", () => {
    expect(schemaVersionOf({})).toBe(1);
    expect(assertSupportedSchema("scores", {})).toBe(1);
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
});
