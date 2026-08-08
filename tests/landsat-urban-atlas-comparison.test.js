import { describe, expect, it } from "vitest";
import {
  updateSurfaceSelection, validateComparisonManifest,
} from "../src/comparisons/landsat-urban-atlas.js";

const manifest = {
  schemaVersion: 1,
  comparisonId: "landsat-urban-atlas",
  primaryLayerId: "landsat-temperature",
  secondaryLayerId: "urban-atlas",
  defaultSeries: ["family:greenUrbanAreas", "class:11100"],
  maximumSeries: 4,
  coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]],
  observations: { test: {} },
  families: [{ key: "family:greenUrbanAreas", type: "family", id: "greenUrbanAreas", codes: ["14110", "14120"] }],
  classes: [
    { key: "class:14110", type: "class", code: "14110" },
    { key: "class:14120", type: "class", code: "14120" },
    { key: "class:11100", type: "class", code: "11100" },
    { key: "class:11210", type: "class", code: "11210" },
    { key: "class:12210", type: "class", code: "12210" },
  ],
};

describe("Landsat-Urban Atlas comparison contract", () => {
  it("validates the local-only comparison identity", () => {
    expect(validateComparisonManifest(manifest)).toBe(manifest);
    expect(() => validateComparisonManifest({ ...manifest, maximumSeries: 5 })).toThrow(/incomplete/i);
  });

  it("keeps family and child selections mutually exclusive", () => {
    const child = updateSurfaceSelection(manifest, ["family:greenUrbanAreas", "class:11100"], "class:14110");
    expect(child.selected).toEqual(["class:11100", "class:14110"]);
    const family = updateSurfaceSelection(manifest, child.selected, "family:greenUrbanAreas");
    expect(family.selected).toEqual(["class:11100", "family:greenUrbanAreas"]);
  });

  it("rejects a fifth simultaneous curve", () => {
    const result = updateSurfaceSelection(
      manifest,
      ["class:11100", "class:11210", "class:12210", "class:14110"],
      "class:14120",
    );
    expect(result).toMatchObject({ changed: false, limit: true });
    expect(result.selected).toHaveLength(4);
  });
});
