import { describe, expect, it } from "vitest";
import {
  combinedGreenDensity, validateGreenUrbanManifest,
} from "../src/comparisons/groenkaart-urban-atlas.js";
import { setLanguage } from "../src/i18n.js";
import { renderSectorPanelModel } from "../src/panel.js";

const manifest = {
  schemaVersion: 1,
  comparisonId: "groenkaart-urban-atlas",
  primaryLayerId: "groenkaart",
  secondaryLayerId: "urban-atlas",
  greenMapYear: 2021,
  urbanAtlasYear: 2021,
  analysisResolutionMeters: 10,
  densityRadiusMeters: 100,
  fabricClasses: ["11100", "11210", "11220", "11230", "11240"].map((code, index) => ({ code, index: index + 1 })),
  excludedUrbanAtlasCodes: ["11300"],
};

describe("Green Map and Urban Atlas comparison", () => {
  it("accepts exactly the five urban-fabric classes and excludes isolated structures", () => {
    expect(validateGreenUrbanManifest(structuredClone(manifest))).toEqual(manifest);
    expect(() => validateGreenUrbanManifest({
      ...manifest,
      fabricClasses: [...manifest.fabricClasses.slice(0, 4), { code: "11300", index: 5 }],
    })).toThrow(/unsupported/i);
    expect(() => validateGreenUrbanManifest({ ...manifest, excludedUrbanAtlasCodes: [] })).toThrow(/unsupported/i);
  });

  it("sums only the selected non-overlapping Green Map density bands", () => {
    const stats = { meanDensityByGreenClass: { 1: 18.25, 2: 24.5, 3: 32, 4: null } };
    expect(combinedGreenDensity(stats, [1, 2])).toBeCloseTo(42.75, 8);
    expect(combinedGreenDensity(stats, [3])).toBe(32);
    expect(combinedGreenDensity(stats, [4])).toBe(0);
  });

  it("renders scientific box plots and accessible values for each selected fabric", () => {
    setLanguage("en");
    const distribution = {
      count: 120, q1: 21.5, median: 34.5, q3: 48.25, whiskerLow: 3, whiskerHigh: 76,
    };
    const html = renderSectorPanelModel({
      template: "groenkaart-urban-atlas-comparison",
      record: { scope: "region", sectorName: "Entire Zennevallei", municipality: "", sectorId: "" },
      greenClassLabels: ["High green", "Low green"],
      selectedGreenClasses: [1, 2],
      selectedFabricClasses: [{
        code: "11100", label: "Continuous urban fabric", color: "#800000",
        meanDensity: 35, densityDistribution: distribution,
        stats: { validCellCount: 120, validAreaHa: 1.2 },
      }],
      densityRadiusMeters: 100,
      analysisResolutionMeters: 10,
    });
    expect(html).toContain("Green-density distribution by urban-fabric class");
    expect(html).toContain("Green density (%)");
    expect(html).toContain("Urban Atlas class");
    expect(html).toContain("median 34.5%");
    expect(html).toContain("data-green-density-box");
    expect(html).toContain("data-expand-comparison-chart");
    expect(html).toContain("green-density-boxplot is-expanded");
    expect(html).toContain("data-section=\"green-urban-methodology\"");
  });
});
