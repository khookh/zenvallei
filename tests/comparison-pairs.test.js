import { describe, expect, it } from "vitest";
import {
  COMPARISON_PAIRS, comparisonForLayers, comparisonTargets,
} from "../src/comparison-pairs.js";

describe("comparison pair contract", () => {
  it("discovers all five comparisons from both participating layers", () => {
    expect(COMPARISON_PAIRS).toHaveLength(5);
    for (const pair of COMPARISON_PAIRS) {
      const [first, second] = pair.layers;
      expect(comparisonForLayers(first, second)?.id).toBe(pair.id);
      expect(comparisonForLayers(second, first)?.id).toBe(pair.id);
      expect(comparisonTargets(first)).toContain(second);
      expect(comparisonTargets(second)).toContain(first);
    }
  });

  it("uses one canonical presentation regardless of entry direction", () => {
    expect(comparisonForLayers("income", "heat")?.canonicalLayerId).toBe("heat");
    expect(comparisonForLayers("jaarbak", "landsat-temperature")?.canonicalLayerId).toBe("landsat-temperature");
    expect(comparisonForLayers("urban-atlas", "groenkaart")?.canonicalLayerId).toBe("groenkaart");
  });

  it("offers only registered functional targets", () => {
    expect(comparisonTargets("urban-atlas").sort()).toEqual(["groenkaart", "landsat-temperature"]);
    expect(comparisonTargets("jaarbak")).toEqual(["landsat-temperature"]);
    expect(comparisonTargets("landgebruik")).toEqual([]);
  });
});
