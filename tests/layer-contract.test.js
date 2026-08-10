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
    getContext: () => ({ meta: "meta", text: "text" }),
    getLegendModel: () => ({ title: id, layout: "groups", groups: [] }),
    getPopupModel: () => ({ title: id, lines: [] }),
    getPanelModel: () => ({ template: id }),
    mount: () => true,
    setVisible() {},
    applyFilter() {},
  };
}

function incomeManifest() {
  const stats = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, {
    sourceStatus: "available",
    medianNetTaxableIncome: 35000,
    renderClass: "35000-39999",
  }]));
  return {
    schemaVersion: 1,
    datasetId: "statbel-income",
    kind: "sector-temporal",
    availableYears: [2019, 2020, 2021, 2022, 2023],
    defaultYear: 2023,
    noDataColor: "#eee",
    bands: Array.from({ length: 7 }, (_, index) => ({ id: index === 4 ? "35000-39999" : `b${index}`, color: "#123456" })),
    years: Object.fromEntries([2019, 2020, 2021, 2022, 2023].map((year) => [year, { sectorStats: stats }])),
    source: {},
  };
}

function populationManifest() {
  const stats = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, {
    sourceStatus: "available", population: 100, areaHa: 10, densityPerHa: 10,
  }]));
  const dataset = { sectorStats: stats, municipalityStats: {}, regionStats: {}, source: {} };
  return {
    schemaVersion: 1,
    datasetId: "population-density",
    kind: "dataset-switch",
    availableDatasets: ["statbel-2025", "flanders-2019"],
    defaultDataset: "statbel-2025",
    bands: Array.from({ length: 8 }, (_, index) => ({ id: `b${index}`, color: "#123456" })),
    datasets: { "statbel-2025": dataset, "flanders-2019": dataset },
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

  it("registers the four always-built core modules without optional catalogue modules", () => {
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
      urbanAtlas: null,
      population: populationManifest(),
      income: incomeManifest(),
    });
    expect([...registry.keys()]).toEqual(["heat", "urban-atlas", "population", "income"]);
    expect(registry.get("heat").isAvailable()).toBe(true);
    expect(registry.get("urban-atlas").isAvailable()).toBe(false);
    expect(LAYER_CATEGORIES.map(({ id }) => id)).toEqual(["heat", "land-green", "demography"]);
    expect(registry.get("heat").categoryId).toBe("heat");
    expect(registry.get("urban-atlas").categoryId).toBe("land-green");
    expect(registry.get("population").categoryId).toBe("demography");
    expect(registry.get("income").categoryId).toBe("demography");
  });

  it("registers the notebook Test layer only in explicit playground mode", () => {
    const data = {
      scores: { A: { sectorId: "A", status: "scored", scores: { final: 6, heat: 7, vulnerability: 8 } } },
      methodology: {
        palette: Object.fromEntries([
          ...Array.from({ length: 11 }, (_, score) => [`score-${score}`, `#00000${score}`]),
          ["no-data", "#eee"], ["institution-present-no-score", "#ffc"],
        ]),
      },
      urbanAtlas: null,
      population: populationManifest(),
      income: incomeManifest(),
      notebookTest: {
        available: true,
        schemaVersion: 1,
        kind: "continuous",
        title: { en: "NDVI test", nl: "NDVI-test" },
        description: { en: "Local output", nl: "Lokale uitvoer" },
        imageUrl: "/__playground__/test.png",
        rasterVariants: { all: "/__playground__/test.png" },
        coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
        legend: { items: [{ label: "0.50", color: "#238b45" }] },
        sectorStats: {},
        municipalityStats: {},
      },
    };
    expect([...buildLayerRegistry(data).keys()]).not.toContain("notebook-test");
    const playground = buildLayerRegistry(data, { playground: true });
    expect([...playground.keys()]).toEqual(["heat", "urban-atlas", "population", "income", "notebook-test"]);
    expect(playground.get("notebook-test").isAvailable()).toBe(true);
    expect(playground.get("notebook-test").supportsMunicipalitySummary).toBe(true);
  });

  it("keeps a missing or malformed notebook export safely unavailable", () => {
    const base = {
      scores: { A: { sectorId: "A", status: "scored", scores: { final: 6, heat: 7, vulnerability: 8 } } },
      methodology: {
        palette: Object.fromEntries([
          ...Array.from({ length: 11 }, (_, score) => [`score-${score}`, `#00000${score}`]),
          ["no-data", "#eee"], ["institution-present-no-score", "#ffc"],
        ]),
      },
      urbanAtlas: null,
      population: populationManifest(),
      income: incomeManifest(),
    };
    const missing = buildLayerRegistry({ ...base, notebookTest: { available: false, missing: true } }, { playground: true })
      .get("notebook-test");
    expect(missing.isAvailable()).toBe(false);
    expect(missing.getUnavailableReasonKey()).toBe("layers.notebookTestMissing");

    const malformed = buildLayerRegistry({
      ...base,
      notebookTest: { available: true, schemaVersion: 99 },
    }, { playground: true }).get("notebook-test");
    expect(malformed.isAvailable()).toBe(false);
    expect(malformed.getUnavailableReasonKey()).toBe("layers.notebookTestLoadError");
  });

  it("rejects layers assigned to an unknown navigation category", () => {
    const registry = createLayerRegistry([{ ...validLayer("example"), categoryId: "unknown" }]);
    expect(() => validateLayerCategories(registry)).toThrow("unknown category 'unknown'");
  });
});
