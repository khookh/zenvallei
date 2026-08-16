import { describe, expect, it } from "vitest";
import {
  COMPARISON_PAIRS, comparisonForLayers, comparisonTargets,
} from "../src/comparison-pairs.js";

describe("comparison pair contract", () => {
  it("discovers all eleven comparisons from both participating layers", () => {
    expect(COMPARISON_PAIRS).toHaveLength(11);
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
    expect(comparisonForLayers("population", "groenkaart")?.canonicalLayerId).toBe("groenkaart");
    expect(comparisonForLayers("population", "landsat-temperature")?.canonicalLayerId).toBe("landsat-temperature");
    expect(comparisonForLayers("population", "jaarbak")?.canonicalLayerId).toBe("jaarbak");
    expect(comparisonForLayers("income", "jaarbak")?.canonicalLayerId).toBe("jaarbak");
  });

  it("offers only registered functional targets", () => {
    expect(comparisonTargets("urban-atlas")).toEqual(["landsat-temperature"]);
    expect(comparisonTargets("jaarbak").sort()).toEqual(["income", "landsat-temperature", "population"]);
    expect(comparisonTargets("groenkaart").sort()).toEqual(["income", "landsat-temperature", "population"]);
    expect(comparisonTargets("population").sort()).toEqual(["groenkaart", "heat", "jaarbak", "landsat-temperature"]);
    expect(comparisonTargets("income").sort()).toEqual(["groenkaart", "heat", "jaarbak", "landsat-temperature"]);
    expect(comparisonTargets("landgebruik")).toEqual([]);
  });
});
