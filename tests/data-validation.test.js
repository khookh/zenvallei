import { describe, expect, it } from "vitest";
import { assertSupportedSchema, schemaVersionOf, validateApplicationData } from "../src/data-validation.js";

function validPayload() {
  const incomeRecord = {
    sourceStatus: "available",
    medianNetTaxableIncome: 35000,
  };
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
    urbanAtlas: null,
    income: {
      schemaVersion: 1,
      datasetId: "statbel-income",
      availableYears: [2019, 2020, 2021, 2022, 2023],
      defaultYear: 2023,
      bands: Array.from({ length: 7 }, (_, index) => ({ id: `b${index}` })),
      years: Object.fromEntries([2019, 2020, 2021, 2022, 2023].map((year) => [year, {
        sectorStats: { A: incomeRecord },
      }])),
    },
    population: {
      schemaVersion: 1,
      datasetId: "population-density",
      kind: "dataset-switch",
      availableDatasets: ["statbel-2025", "flanders-2019"],
      defaultDataset: "statbel-2025",
      datasets: Object.fromEntries(["statbel-2025", "flanders-2019"].map((datasetId) => [datasetId, {
        sectorStats: { A: { sourceStatus: "available", population: 100, areaHa: 10, densityPerHa: 10 } },
      }])),
    },
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
