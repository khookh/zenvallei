import { describe, expect, it } from "vitest";
import {
  LOCAL_ONLY_LAYER_IDS,
  PUBLIC_COMPARISON_IDS,
  LAYER_ACTIONS,
  PUBLIC_LAYER_IDS,
  validateProductContract,
} from "../src/product-contract.js";

describe("release product contract", () => {
  it("pins eight public layers, nine comparisons and only relevant action rows", () => {
    expect(PUBLIC_LAYER_IDS).toEqual([
      "heat", "landsat-temperature", "urban-atlas", "jaarbak",
      "groenkaart", "landgebruik", "population", "income",
    ]);
    expect(PUBLIC_COMPARISON_IDS).toEqual([
      "heat-income", "heat-population", "landsat-urban-atlas",
      "landsat-jaarbak", "landsat-groenkaart", "groenkaart-income", "groenkaart-population", "landsat-income",
      "landsat-population",
    ]);
    expect(LAYER_ACTIONS).toEqual({
      heat: "compare",
      "landsat-temperature": "compare",
      jaarbak: "density",
      groenkaart: "density",
    });
  });

  it("rejects a release that silently omits a layer or comparison", () => {
    const layers = new Map(PUBLIC_LAYER_IDS.map((id) => [id, {}]));
    const comparisons = new Map(PUBLIC_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons)).toBe(true);
    layers.delete("landsat-temperature");
    expect(() => validateProductContract(layers, comparisons)).toThrow("landsat-temperature");
  });

  it("allows only the notebook Test layer in playground mode", () => {
    const layers = new Map([...PUBLIC_LAYER_IDS, "notebook-test"].map((id) => [id, {}]));
    const comparisons = new Map(PUBLIC_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons, { playground: true })).toBe(true);
  });

  it("allows the scenario layer only in local-data mode", () => {
    expect(LOCAL_ONLY_LAYER_IDS).toEqual(["land-cover-scenario"]);
    const layers = new Map([...PUBLIC_LAYER_IDS, ...LOCAL_ONLY_LAYER_IDS].map((id) => [id, {}]));
    const comparisons = new Map(PUBLIC_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons, { localData: true })).toBe(true);
    expect(() => validateProductContract(layers, comparisons)).toThrow("land-cover-scenario");
  });

  it("requires every functional comparison in every public mode", () => {
    const layers = new Map(PUBLIC_LAYER_IDS.map((id) => [id, {}]));
    const comparisons = new Map(PUBLIC_COMPARISON_IDS.map((id) => [id, {}]));
    expect(validateProductContract(layers, comparisons)).toBe(true);
    comparisons.delete("heat-income");
    expect(() => validateProductContract(layers, comparisons)).toThrow("heat-income");
    comparisons.set("heat-income", {});
    comparisons.delete("heat-population");
    expect(() => validateProductContract(layers, comparisons)).toThrow("heat-population");
  });
});
