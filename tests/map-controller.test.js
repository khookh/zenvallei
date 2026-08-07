import { describe, expect, it } from "vitest";
import { clampViewportPadding } from "../src/map-controller.js";

describe("responsive map camera padding", () => {
  it("preserves ordinary padding", () => {
    expect(clampViewportPadding(
      { top: 80, right: 68, bottom: 62, left: 20 },
      390,
      780,
    )).toEqual({ top: 80, right: 68, bottom: 62, left: 20 });
  });

  it("keeps a usable map window during overlapping responsive resizes", () => {
    const padding = clampViewportPadding(
      { top: 700, right: 360, bottom: 220, left: 180 },
      390,
      780,
    );
    expect(padding.left + padding.right).toBeCloseTo(270);
    expect(padding.top + padding.bottom).toBeCloseTo(660);
    expect(Object.values(padding).every(Number.isFinite)).toBe(true);
  });

  it("normalises malformed measurements", () => {
    expect(clampViewportPadding(
      { top: Number.NaN, right: Infinity, bottom: -5, left: 12 },
      390,
      780,
    )).toEqual({ top: 0, right: 0, bottom: 0, left: 12 });
  });
});
