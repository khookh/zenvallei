/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/i18n.js";
import {
  createPopulationLayer,
  populationDensityExpression,
  validatePopulationManifest,
} from "../src/layers/population-layer.js";
import { renderSectorPanelModel } from "../src/panel.js";

const manifestPath = path.resolve(import.meta.dirname, "..", "public", "data", "population.json");
const loadManifest = () => fs.readFile(manifestPath, "utf8").then(JSON.parse);

beforeEach(() => setLanguage("en"));

describe("population-density layer", () => {
  it("validates the prepared two-dataset contract and fixed scale", async () => {
    const manifest = await loadManifest();
    expect(validatePopulationManifest(manifest)).toBe(manifest);
    expect(populationDensityExpression(manifest)).toEqual([
      "step", ["to-number", ["get", "densityPerHa"]],
      "#f2f3f5", 0.000001, "#edf8fb", 5, "#d7b5d8", 15, "#c994c7",
      30, "#9e9ac8", 60, "#756bb1", 100, "#54278f", 200, "#2d004b",
    ]);
  });

  it("exposes a dataset switch rather than a misleading year timeline", async () => {
    const layer = createPopulationLayer({ population: await loadManifest() });
    expect(layer.id).toBe("population");
    expect(layer.categoryId).toBe("demography");
    expect(layer.supportsMunicipalitySummary).toBe(true);
    expect(layer.supportsRegionSummary).toBe(true);
    expect(layer.getTemporalControl).toBeUndefined();
    expect(layer.getSecondaryControl().options.map(({ id, label }) => [id, label])).toEqual([
      ["statbel-2025", "Current grid · 2025"],
      ["flanders-2019", "100 m model · 2019"],
    ]);
  });

  it("uses official sector totals for sector, municipality and region panels", async () => {
    const layer = createPopulationLayer({ population: await loadManifest() });
    const sector = layer.getPanelModel({ scope: "sector", sectorId: "23003A001" });
    const municipality = layer.getPanelModel({ scope: "municipality", municipality: "Beersel" });
    const region = layer.getPanelModel({ scope: "region" });
    expect(sector.stats.population).toBe(1212);
    expect(municipality.stats.population).toBe(26590);
    expect(region.stats.population).toBe(140122);
    expect(region.stats.densityPerHa).toBeCloseTo(7.724, 3);
  });

  it("translates an already-open complete-region panel at render time", async () => {
    const population = await loadManifest();
    const layer = createPopulationLayer({ population });
    const record = { scope: "region", sectorName: "Entire Zennevallei", sectorCount: 154 };
    const model = layer.getPanelModel(record);
    setLanguage("nl");
    expect(renderSectorPanelModel(model)).toContain('<h2 id="panel-title">Hele Zennevallei</h2>');
  });
});
