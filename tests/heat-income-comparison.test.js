import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildHeatIncomePoints,
  createHeatIncomeComparison,
  incomeLevel,
  summarizeIncomeByScore,
} from "../src/comparisons/heat-income.js";
import { representedLandsatAreaHa } from "../src/panel.js";
import { renderSectorPanelModel } from "../src/panel.js";
import { setLanguage } from "../src/i18n.js";

const dataRoot = path.resolve(import.meta.dirname, "..", "public", "data");
let scores;
let income;

beforeAll(async () => {
  scores = JSON.parse(await fs.readFile(path.join(dataRoot, "scores.json"), "utf8")).sectors;
  income = JSON.parse(await fs.readFile(path.join(dataRoot, "income.json"), "utf8"));
});

describe("heat-income comparison", () => {
  it("joins exact 2023 values and excludes unavailable sectors instead of creating zeros", () => {
    for (const metric of ["final", "heat", "vulnerability"]) {
      const points = buildHeatIncomePoints(scores, income, metric);
      expect(points).toHaveLength(140);
      expect(points.every(({ income: value, score }) => Number.isFinite(value) && value > 0 && Number.isFinite(score))).toBe(true);
      expect(points).toEqual([...points].sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId)));
    }
    expect(buildHeatIncomePoints(scores, income, "final").find(({ sectorId }) => sectorId === "23003A001")).toMatchObject({
      income: 34503,
      score: 6,
    });
  });

  it("keeps heat visible and overlays fixed income symbols without changing the income year", async () => {
    let metric = "final";
    let incomeYear = 2021;
    const heatLayer = {
      getOption: () => metric,
      setVisible: vi.fn(),
      getLegendModel: () => ({ title: "Heat", layout: "scale", groups: [{ items: [] }, { items: [] }] }),
    };
    const incomeLayer = {
      getOption: () => incomeYear,
      setOption: vi.fn((_map, _name, year) => { incomeYear = year; return true; }),
      setVisible: vi.fn(),
      getLegendModel: () => ({ title: "Income", layout: "groups", groups: [] }),
    };
    const layers = new Map();
    const map = {
      getLayer: vi.fn((id) => layers.get(id)),
      addLayer: vi.fn((definition) => layers.set(definition.id, definition)),
      setFilter: vi.fn(), setLayoutProperty: vi.fn(), triggerRepaint: vi.fn(),
    };
    const comparison = createHeatIncomeComparison({
      scores, income, heatLayer, incomeLayer,
    });
    await comparison.activate(map);
    expect(incomeYear).toBe(2021);
    expect(heatLayer.setVisible).toHaveBeenLastCalledWith(map, true);
    expect(incomeLayer.setVisible).toHaveBeenLastCalledWith(map, false);
    expect(map.addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "heat-income-symbols", type: "symbol" }), "heat-sectors-outline");
    expect(comparison.getLegendModel().comparisonLegend.items.map(({ symbol }) => symbol)).toEqual(["€", "€€", "€€€", "–"]);
    expect(comparison.getPanelModel().points).toHaveLength(140);
    comparison.setMunicipality("Halle");
    expect(comparison.getPanelModel({ scope: "municipality", municipality: "Halle", sectorName: "Halle" }).points).toHaveLength(39);
    metric = "heat";
    expect(comparison.getPanelModel().metric).toBe("heat");
    comparison.deactivate();
    expect(incomeYear).toBe(2021);
    expect(heatLayer.setVisible).toHaveBeenLastCalledWith(map, true);
  });

  it("uses stable income thresholds including exact boundary values", () => {
    expect(incomeLevel(29_999.99)).toMatchObject({ id: "low", symbol: "€" });
    expect(incomeLevel(30_000)).toMatchObject({ id: "middle", symbol: "€€" });
    expect(incomeLevel(39_999.99)).toMatchObject({ id: "middle", symbol: "€€" });
    expect(incomeLevel(40_000)).toMatchObject({ id: "high", symbol: "€€€" });
    expect(incomeLevel(null)).toBeNull();
  });

  it("converts each nominal 30 metre pixel into 0.09 hectares", () => {
    expect(representedLandsatAreaHa(1)).toBeCloseTo(0.09, 8);
    expect(representedLandsatAreaHa(28867)).toBeCloseTo(2598.03, 8);
  });

  it("calculates one Tukey income summary for each ordinal score row", () => {
    const points = buildHeatIncomePoints(scores, income, "final");
    const summaries = summarizeIncomeByScore(points);
    expect(summaries).toHaveLength(11);
    expect(summaries.reduce((total, summary) => total + summary.count, 0)).toBe(140);
    for (const summary of summaries.filter(({ count }) => count)) {
      expect(summary.whiskerLow).toBeLessThanOrEqual(summary.q1);
      expect(summary.q1).toBeLessThanOrEqual(summary.median);
      expect(summary.median).toBeLessThanOrEqual(summary.q3);
      expect(summary.q3).toBeLessThanOrEqual(summary.whiskerHigh);
    }
  });

  it("renders an unbinned, bilingual scatter plot for the active area", () => {
    const points = buildHeatIncomePoints(scores, income, "vulnerability");
    setLanguage("en");
    const english = renderSectorPanelModel({
      template: "heat-income-comparison",
      record: { scope: "region", sectorName: "Entire Zennevallei", municipality: "", sectorId: "", sectorCount: 154 },
      metric: "vulnerability",
      incomeYear: 2023,
      points,
      scoreSummaries: summarizeIncomeByScore(points),
      excludedCount: 14,
      highlightedSectorId: "23003A001",
    });
    expect(english).toContain("Vulnerability versus median taxable income");
    expect(english).toContain("140 comparable sectors");
    expect(english.match(/data-scatter-sector=/g)).toHaveLength(280);
    expect(english).toContain("heat-income-boxplots");
    expect(english).toContain("data-expand-comparison-chart");
    expect(english).toContain("Median net taxable income per declaration, 2023");
    expect(english).toContain("€20k");
    expect(english).not.toContain("€25,000");
    expect(english).toContain("rotate(-90)");
    expect(english).not.toContain("heat-income-regression");

    setLanguage("nl");
    const dutch = renderSectorPanelModel({
      template: "heat-income-comparison",
      record: { scope: "region", sectorName: "Hele Zennevallei", municipality: "", sectorId: "", sectorCount: 154 },
      metric: "heat",
      incomeYear: 2023,
      points: buildHeatIncomePoints(scores, income, "heat"),
      scoreSummaries: summarizeIncomeByScore(buildHeatIncomePoints(scores, income, "heat")),
      excludedCount: 14,
      highlightedSectorId: "",
    });
    expect(dutch).toContain("Hitte tegenover mediaan belastbaar inkomen");
    expect(dutch).toContain("Mediaan netto belastbaar inkomen per aangifte, 2023");
  });
});
