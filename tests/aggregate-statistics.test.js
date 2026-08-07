/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { addMunicipalityStatistics } from "../src/aggregate-statistics.js";

describe("municipality statistics", () => {
  it("sums Urban Atlas class areas before calculating both headline metrics", () => {
    const scores = { A: { sectorId: "A", municipality: "Test" } };
    const urbanAtlas = {
      greenCodes: ["23000", "31000"],
      artificialCodes: ["11100"],
      sectorStats: { A: {
        sectorAreaHa: 10, processedAreaHa: 10, validAreaHa: 10, noDataAreaHa: 0,
        green: { classes: [{ code: "23000", areaHa: 2 }, { code: "31000", areaHa: 1 }] },
        artificial: { classes: [{ code: "11100", areaHa: 5 }] },
        otherClasses: [{ code: "21000", areaHa: 2 }],
      } },
    };
    addMunicipalityStatistics({ scores, urbanAtlas });
    expect(urbanAtlas.municipalityStats.Test.green.percentage).toBe(30);
    expect(urbanAtlas.municipalityStats.Test.artificial.percentage).toBe(50);
    expect(urbanAtlas.municipalityStats.Test.dominantClassCode).toBe("11100");
  });
});
