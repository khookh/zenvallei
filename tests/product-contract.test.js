import { describe, expect, it } from "vitest";
import {
  LANDSAT_COMPARISON_IDS,
  LAYER_ACTIONS,
  PUBLIC_LAYER_IDS,
  validateProductContract,
} from "../src/product-contract.js";

describe("release product contract", () => {
  it("pins seven public layers, two comparisons and only relevant action rows", () => {
    expect(PUBLIC_LAYER_IDS).toEqual([
      "heat", "landsat-temperature", "urban-atlas", "jaarbak",
      "groenkaart", "landgebruik", "income",
    ]);
    expect(LANDSAT_COMPARISON_IDS).toEqual(["landsat-urban-atlas", "landsat-jaarbak"]);
    expect(LAYER_ACTIONS).toEqual({
      heat: "comparison-preview",
      "landsat-temperature": "compare",
      jaarbak: "density",
      groenkaart: "density",
    });
  });

  it("rejects a release that silently omits a layer or comparison", () => {
    const layers = new Map(PUBLIC_LAYER_IDS.map((id) => [id, {}]));
    const comparisons = new Map(LANDSAT_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons)).toBe(true);
    layers.delete("landsat-temperature");
    expect(() => validateProductContract(layers, comparisons)).toThrow("landsat-temperature");
  });

  it("allows only the notebook Test layer in playground mode", () => {
    const layers = new Map([...PUBLIC_LAYER_IDS, "notebook-test"].map((id) => [id, {}]));
    const comparisons = new Map(LANDSAT_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons, { playground: true })).toBe(true);
  });
});
