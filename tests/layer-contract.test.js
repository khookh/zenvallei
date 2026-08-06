import { describe, expect, it } from "vitest";
import { LAYER_CATEGORIES, validateLayerCategories } from "../src/layers/categories.js";
import { createLayerRegistry, defineLayer } from "../src/layers/layer-contract.js";
import { buildLayerRegistry } from "../src/layers/registry.js";

function validLayer(id) {
  return {
    id,
    categoryId: "heat",
    isAvailable: () => true,
    getLabel: () => id,
    getDatasetStatus: () => "ready",
    getContext: () => ({ meta: "meta", text: "text" }),
    getLegendModel: () => ({ title: id, layout: "groups", groups: [] }),
    getPopupModel: () => ({ title: id, lines: [] }),
    getPanelModel: () => ({ template: id }),
    mount: () => true,
    setVisible() {},
    applyFilter() {},
  };
}

describe("layer module contract", () => {
  it("accepts simple modules and rejects missing methods", () => {
    expect(defineLayer(validLayer("example")).id).toBe("example");
    expect(() => defineLayer({ ...validLayer("broken"), getLegendModel: undefined }))
      .toThrow("missing getLegendModel()");
  });

  it("rejects duplicate stable identifiers", () => {
    expect(() => createLayerRegistry([validLayer("same"), validLayer("same")]))
      .toThrow("Duplicate layer id 'same'");
  });

  it("registers the four application layers without frontend-specific setup", () => {
    const registry = buildLayerRegistry({
      scores: {
        A: { sectorId: "A", status: "scored", scores: { final: 6, heat: 7, vulnerability: 8 } },
      },
      methodology: {
        palette: Object.fromEntries([
          ...Array.from({ length: 11 }, (_, score) => [`score-${score}`, `#00000${score}`]),
          ["no-data", "#eee"],
          ["institution-present-no-score", "#ffc"],
        ]),
      },
      landCover: null,
      urbanAtlas: null,
      vegetation: null,
    });
    expect([...registry.keys()]).toEqual(["heat", "land-cover", "urban-atlas", "vegetation"]);
    expect(registry.get("heat").isAvailable()).toBe(true);
    expect(registry.get("land-cover").isAvailable()).toBe(false);
    expect(registry.get("urban-atlas").isAvailable()).toBe(false);
    expect(registry.get("vegetation").isAvailable()).toBe(false);
    expect(LAYER_CATEGORIES.map(({ id }) => id)).toEqual(["heat", "land-green"]);
    expect(registry.get("heat").categoryId).toBe("heat");
    expect([...registry.values()].slice(1).every(({ categoryId }) => categoryId === "land-green")).toBe(true);
  });

  it("rejects layers assigned to an unknown navigation category", () => {
    const registry = createLayerRegistry([{ ...validLayer("example"), categoryId: "unknown" }]);
    expect(() => validateLayerCategories(registry)).toThrow("unknown category 'unknown'");
  });
});
