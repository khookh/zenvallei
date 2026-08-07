import { describe, expect, it } from "vitest";
import { surfaceModeForWidth, visibleSurfaceIntersections } from "../src/map-surface-layout.js";

function surface(rect, { hidden = false, ariaHidden = "false" } = {}) {
  return {
    hidden,
    getAttribute: (name) => name === "aria-hidden" ? ariaHidden : null,
    getClientRects: () => hidden ? [] : [rect],
    getBoundingClientRect: () => rect,
  };
}

describe("adaptive map-surface layout", () => {
  it("uses the documented expanded, medium and compact breakpoints", () => {
    expect(surfaceModeForWidth(1440)).toBe("expanded");
    expect(surfaceModeForWidth(1180)).toBe("expanded");
    expect(surfaceModeForWidth(1179)).toBe("medium");
    expect(surfaceModeForWidth(760)).toBe("medium");
    expect(surfaceModeForWidth(759)).toBe("compact");
    expect(surfaceModeForWidth(320)).toBe("compact");
  });

  it("reports visible collisions and ignores closed surfaces", () => {
    const controls = surface({ left: 10, right: 380, top: 10, bottom: 500 });
    const overlappingLegend = surface({ left: 20, right: 500, top: 450, bottom: 550 });
    const result = surface({ left: 900, right: 1280, top: 10, bottom: 700 });
    expect(visibleSurfaceIntersections([controls, overlappingLegend, result])).toEqual([[controls, overlappingLegend]]);
    expect(visibleSurfaceIntersections([controls, surface({}, { ariaHidden: "true" })])).toEqual([]);
  });
});

