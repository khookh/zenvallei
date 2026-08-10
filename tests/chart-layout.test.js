import { describe, expect, it } from "vitest";
import {
  compactEuroTick,
  createChartLayout,
  heatIncomeLayout,
  landsatHistogramLayout,
} from "../src/chart-layout.js";

describe("shared chart geometry", () => {
  it("keeps plot bounds inside dedicated axis margins", () => {
    for (const layout of [heatIncomeLayout(), landsatHistogramLayout()]) {
      expect(layout.plot.left).toBeGreaterThan(0);
      expect(layout.plot.top).toBeGreaterThan(0);
      expect(layout.plot.left + layout.plot.width).toBeLessThan(layout.width);
      expect(layout.plot.top + layout.plot.height).toBeLessThan(layout.height);
    }
  });

  it("maps domain endpoints exactly and clips values outside the domain", () => {
    const layout = createChartLayout({
      width: 100, height: 100, margins: { left: 10, right: 10, top: 20, bottom: 20 },
      xDomain: [0, 10], yDomain: [0, 10],
    });
    expect(layout.x(-1)).toBe(10);
    expect(layout.x(10)).toBe(90);
    expect(layout.y(0)).toBe(80);
    expect(layout.y(11)).toBe(20);
  });

  it("formats sparse compact euro ticks", () => {
    expect([20_000, 30_000, 40_000, 50_000].map(compactEuroTick))
      .toEqual(["€20k", "€30k", "€40k", "€50k"]);
  });
});
