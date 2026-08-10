import { describe, expect, it } from "vitest";
import {
  COMPARISON_PAIRS, comparisonForLayers, comparisonTargets,
} from "../src/comparison-pairs.js";

describe("comparison pair contract", () => {
  it("discovers all seven comparisons from both participating layers", () => {
    expect(COMPARISON_PAIRS).toHaveLength(7);
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
    expect(comparisonForLayers("income", "groenkaart")?.canonicalLayerId).toBe("groenkaart");
    expect(comparisonForLayers("groenkaart", "landsat-temperature")?.canonicalLayerId).toBe("landsat-temperature");
  });

  it("offers only registered functional targets", () => {
    expect(comparisonTargets("urban-atlas")).toEqual(["landsat-temperature"]);
    expect(comparisonTargets("jaarbak")).toEqual(["landsat-temperature"]);
    expect(comparisonTargets("groenkaart").sort()).toEqual(["income", "landsat-temperature"]);
    expect(comparisonTargets("income").sort()).toEqual(["groenkaart", "heat", "landsat-temperature"]);
    expect(comparisonTargets("landgebruik")).toEqual([]);
  });
});
