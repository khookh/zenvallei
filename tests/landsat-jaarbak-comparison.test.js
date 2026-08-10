import { describe, expect, it } from "vitest";
import { validateLandsatJaarbakManifest } from "../src/comparisons/landsat-jaarbak.js";
import { comparisonLegendItems, thermalColor } from "../src/comparisons/thermal-palette.js";

const manifest = {
  schemaVersion: 2,
  comparisonId: "landsat-jaarbak",
  primaryLayerId: "landsat-temperature",
  secondaryLayerId: "jaarbak",
  maximumSeries: 2,
  series: [{ key: "class:sealed" }, { key: "class:unsealed" }],
  coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]],
  analysisImageSize: [10, 10],
  analysisScopeIndexUrl: "analysis-scope-index.png",
  densityAnalysis: { radiusMeters: 100, validCoverageThreshold: 95, sampling: "none" },
  observations: { test: {} },
};

describe("Landsat-JaarBAK comparison", () => {
  it("requires exactly the sealed and unsealed contract", () => {
    expect(validateLandsatJaarbakManifest(manifest)).toBe(manifest);
    expect(() => validateLandsatJaarbakManifest({ ...manifest, maximumSeries: 4 })).toThrow(/incomplete/i);
  });

  it("uses the fixed scientific thermal palette", () => {
    expect(thermalColor(0)).toEqual([4, 35, 51]);
    expect(thermalColor(255)).toEqual([232, 250, 91]);
    expect(comparisonLegendItems()).toHaveLength(9);
  });
});
