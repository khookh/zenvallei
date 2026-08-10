import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildHeatPopulationPoints,
  createHeatPopulationComparison,
  createPopulationIcon,
  populationLevel,
  summarizeHeatByPopulationLevel,
  sumPopulationByHeatScore,
} from "../src/comparisons/heat-population.js";
import { setLanguage } from "../src/i18n.js";
import { renderSectorPanelModel } from "../src/panel.js";

const dataRoot = path.resolve(import.meta.dirname, "..", "public", "data");
let scores;
let population;

beforeAll(async () => {
  scores = JSON.parse(await fs.readFile(path.join(dataRoot, "scores.json"), "utf8")).sectors;
  population = JSON.parse(await fs.readFile(path.join(dataRoot, "population.json"), "utf8"));
});

describe("heat-population comparison", () => {
  it("uses stable population thresholds including every exact boundary", () => {
    expect(populationLevel(null)).toBeNull();
    expect(populationLevel(0)).toBe(0);
    expect(populationLevel(1)).toBe(1);
    expect(populationLevel(249)).toBe(1);
    expect(populationLevel(250)).toBe(2);
    expect(populationLevel(499)).toBe(2);
    expect(populationLevel(500)).toBe(3);
    expect(populationLevel(999)).toBe(3);
    expect(populationLevel(1_000)).toBe(4);
    expect(populationLevel(1_999)).toBe(4);
    expect(populationLevel(2_000)).toBe(5);
  });

  it("joins the authoritative 2025 totals and excludes unavailable heat scores", () => {
    for (const metric of ["final", "heat", "vulnerability"]) {
      const points = buildHeatPopulationPoints(scores, population, metric);
      expect(points).toHaveLength(140);
      expect(points.every(({ population: value, score, level }) => (
        Number.isFinite(value) && value > 0 && Number.isFinite(score) && level >= 1 && level <= 5
      ))).toBe(true);
      expect(summarizeHeatByPopulationLevel(points).map(({ count }) => count)).toEqual([22, 30, 37, 32, 19]);
      const populationByScore = sumPopulationByHeatScore(points);
      expect(populationByScore).toHaveLength(11);
      expect(populationByScore.reduce((sum, entry) => sum + entry.population, 0)).toBe(139_939);
      expect(populationByScore.reduce((sum, entry) => sum + entry.sectorCount, 0)).toBe(140);
      expect(populationByScore.reduce((sum, entry) => sum + entry.populationShare, 0)).toBeCloseTo(100, 8);
      expect(populationByScore[0].atOrAbovePopulation).toBe(139_939);
      expect(populationByScore[0].atOrAbovePopulationShare).toBeCloseTo(100, 8);
      expect(populationByScore[10].atOrAbovePopulation).toBe(populationByScore[10].population);
      expect(populationByScore[10].atOrAbovePopulationShare).toBe(populationByScore[10].populationShare);
    }
  });

  it("creates five deterministic person-strip sprites without emoji or fonts", () => {
    const one = createPopulationIcon(1);
    const five = createPopulationIcon(5);
    expect(one.height).toBe(five.height);
    expect(five.width).toBeGreaterThan(one.width * 4);
    expect(one.data).toEqual(createPopulationIcon(1).data);
    expect([...one.data].some((value) => value !== 0)).toBe(true);
  });

  it("keeps heat visible, hides the population layer and filters the symbols", async () => {
    let metric = "final";
    const heatLayer = {
      getOption: () => metric,
      setVisible: vi.fn(),
      getLegendModel: () => ({
        title: "Heat", layout: "scale",
        groups: [
          { items: Array.from({ length: 11 }, (_, score) => ({ value: String(score), color: `color-${score}` })) },
          { items: [] },
        ],
      }),
    };
    const populationLayer = { getOption: () => "flanders-2019", setVisible: vi.fn() };
    const layers = new Map();
    const images = new Map();
    const map = {
      getLayer: vi.fn((id) => layers.get(id)),
      addLayer: vi.fn((definition) => layers.set(definition.id, definition)),
      hasImage: vi.fn((id) => images.has(id)),
      addImage: vi.fn((id, image) => images.set(id, image)),
      setFilter: vi.fn(), setLayoutProperty: vi.fn(), triggerRepaint: vi.fn(),
    };
    const comparison = createHeatPopulationComparison({ scores, population, heatLayer, populationLayer });
    await comparison.activate(map);
    expect(images.size).toBe(5);
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "heat-population-symbols", type: "symbol" }), "heat-sectors-outline");
    expect(heatLayer.setVisible).toHaveBeenLastCalledWith(map, true);
    expect(populationLayer.setVisible).toHaveBeenLastCalledWith(map, false);
    expect(comparison.getLegendModel().comparisonLegend.items.map(({ personCount }) => personCount)).toEqual([1, 2, 3, 4, 5]);
    expect(comparison.getPanelModel()).toMatchObject({
      template: "heat-population-comparison",
      populationYear: 2025,
      comparablePopulation: 139_939,
      totalPopulation: 140_122,
      excludedPopulation: 183,
      excludedCount: 14,
    });
    comparison.setMunicipality("Halle");
    expect(map.setFilter).toHaveBeenLastCalledWith("heat-population-symbols", ["==", ["get", "municipality"], "Halle"]);
    expect(comparison.getPanelModel({ scope: "municipality", municipality: "Halle", sectorName: "Halle" })).toMatchObject({
      comparablePopulation: 42_846,
      totalPopulation: 42_877,
      excludedPopulation: 31,
    });
    expect(comparison.getPanelModel().points).toHaveLength(39);
    metric = "vulnerability";
    comparison.refreshMetric();
    expect(comparison.getPanelModel().metric).toBe("vulnerability");
    comparison.deactivate();
    expect(populationLayer.getOption()).toBe("flanders-2019");
  });

  it("renders bilingual box plots, resident bars and expandable charts", () => {
    const points = buildHeatPopulationPoints(scores, population, "final");
    const model = {
      template: "heat-population-comparison",
      record: { scope: "region", sectorName: "Entire Zennevallei", municipality: "", sectorId: "", sectorCount: 154 },
      metric: "final",
      points,
      levelSummaries: summarizeHeatByPopulationLevel(points),
      populationByScore: sumPopulationByHeatScore(points),
      scoreColors: Object.fromEntries(Array.from({ length: 11 }, (_, score) => [score, `#${String(score).repeat(6).slice(0, 6)}`])),
      comparablePopulation: 139_939,
      totalPopulation: 140_122,
      excludedPopulation: 183,
      excludedCount: 14,
      highlightedSectorId: "23003A001",
    };
    setLanguage("en");
    const english = renderSectorPanelModel(model);
    expect(english).toContain("Heat score by population band");
    expect(english).toContain("Residents by heat-score level");
    expect(english.match(/data-scatter-sector=/g)).toHaveLength(280);
    // Inline, combined expanded and independently expanded bar charts each
    // contain the same eleven score bars.
    expect(english.match(/data-population-score-bar/g)).toHaveLength(33);
    expect(english).toContain("139,939 of 140,122 residents are represented");
    expect(english).toContain("data-expand-comparison-chart");
    expect(english).toContain("At score 0 or above: 139,939 residents, 100%.");
    expect(english).toContain('data-dialog-target="heat-population-bars"');
    expect(english).not.toMatch(/regression|correlation/i);

    setLanguage("nl");
    const dutch = renderSectorPanelModel({ ...model, metric: "heat" });
    expect(dutch).toContain("Hittescore per bevolkingsklasse");
    expect(dutch).toContain("Inwoners per hittescore");
    expect(dutch).toContain("139.939 van 140.122 inwoners zijn vertegenwoordigd");
  });
});
