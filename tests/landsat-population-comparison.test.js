import { describe, expect, it } from "vitest";
import { validateLandsatPopulationManifest } from "../src/comparisons/landsat-population.js";

const manifest = {
  schemaVersion: 3,
  comparisonId: "landsat-population",
  primaryLayerId: "landsat-temperature",
  secondaryLayerId: "population",
  populationDatasetId: "flanders-2019",
  populationYear: 2019,
  populationResolutionMeters: 100,
  analysisResolutionMeters: 30,
  maskResolutionMeters: 1,
  temperatureResolutionMeters: 30,
  aggregation: "exact-masked-area",
  minimumAnalysedAreaHa: 0.1,
  cellEncoding: ["sectorId", "row", "column", "populationDensityPerHa", "residential[areaM2,temperatureAreaSum,landsatIndexes]", "employmentInstitutional[areaM2,temperatureAreaSum,landsatIndexes]"],
  urbanAtlasClassMaskUrl: "shared/urban-atlas-classes-2021.pmtiles",
  urbanAtlasClassIndexes: { 11100: 1, 12100: 2 },
  urbanSurfaceGroups: [{ id: "residential", codes: ["11100", "11210", "11220", "11230", "11240"] }, { id: "employmentInstitutional", codes: ["12100"] }],
  defaultUrbanSurfaceGroups: ["residential", "employmentInstitutional"],
  observations: { one: { displayDataUrl: "shared/one.png", statisticsUrl: "landsat-population/one.json" } },
};

describe("Landsat-population comparison", () => {
  it("pins the uniform 2019 model and exact-area threshold", () => {
    expect(validateLandsatPopulationManifest(manifest)).toBe(manifest);
    expect(() => validateLandsatPopulationManifest({ ...manifest, populationDatasetId: "statbel-2025" }))
      .toThrow(/unsupported/i);
    expect(() => validateLandsatPopulationManifest({ ...manifest, minimumAnalysedAreaHa: 0.0999 }))
      .toThrow(/unsupported/i);
  });
});
