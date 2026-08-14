import { describe, expect, it } from "vitest";
import { pixelScatterStyle } from "../src/scatter-chart.js";

describe("density-aware pixel scatter styling", () => {
  it("retains the original regional mark character for a dense cloud", () => {
    expect(pixelScatterStyle(65_236, 280, 220)).toMatchObject({
      boost: 1,
      opacity: 0.18,
      markSize: 1.4,
    });
  });

  it("makes a Nieuwenhoven-sized subset substantially more visible", () => {
    const style = pixelScatterStyle(2_478, 280, 220);
    expect(style.opacity).toBeGreaterThan(0.35);
    expect(style.markSize).toBeGreaterThan(2);
    expect(style.opacity).toBeLessThanOrEqual(0.65);
    expect(style.markSize).toBeLessThanOrEqual(2.8);
  });

  it("caps presentation changes for extremely small subsets", () => {
    expect(pixelScatterStyle(1, 660, 390)).toMatchObject({ opacity: 0.65, markSize: 2.8 });
  });
});
