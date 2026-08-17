import { describe, expect, it } from "vitest";
import {
  LAYER_CATEGORIES,
  SCENARIO_TOOL_ID,
  THEMATIC_LAYER_IDS,
} from "../src/layers/categories.js";

describe("thematic navigation contract", () => {
  it("exposes seven maps in three tabs and keeps the scenario separate", () => {
    expect(LAYER_CATEGORIES.map(({ id }) => id)).toEqual(["heat", "land-green", "demography"]);
    expect(THEMATIC_LAYER_IDS).toEqual({
      heat: ["landsat-temperature", "heat"],
      "land-green": ["urban-atlas", "jaarbak", "groenkaart"],
      demography: ["population", "income"],
    });
    expect(Object.values(THEMATIC_LAYER_IDS).flat()).toHaveLength(7);
    expect(Object.values(THEMATIC_LAYER_IDS).flat()).not.toContain(SCENARIO_TOOL_ID);
    expect(SCENARIO_TOOL_ID).toBe("land-cover-scenario");
  });
});
