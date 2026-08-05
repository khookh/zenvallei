import { describe, expect, it } from "vitest";
import { createLayerRegistry, defineLayer } from "../src/layers/layer-contract.js";
import { buildLayerRegistry } from "../src/layers/registry.js";

function validLayer(id) {
  return {
    id,
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

  it("registers the three application layers without frontend-specific setup", () => {
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
    });
    expect([...registry.keys()]).toEqual(["heat", "land-cover", "urban-atlas"]);
    expect(registry.get("heat").isAvailable()).toBe(true);
    expect(registry.get("land-cover").isAvailable()).toBe(false);
    expect(registry.get("urban-atlas").isAvailable()).toBe(false);
  });
});
