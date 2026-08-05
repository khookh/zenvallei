import { describe, expect, it } from "vitest";
import { collectionBounds, findSectorFromQuery, sectorSearchLabel, sectorsForMunicipality } from "../src/data.js";

const scores = {
  A: { sectorId: "A", sectorName: "Zuid", municipality: "Halle" },
  B: { sectorId: "B", sectorName: "Noord", municipality: "Beersel" },
};

describe("application data helpers", () => {
  it("filters and alphabetizes sector records", () => {
    expect(sectorsForMunicipality(scores).map((record) => record.sectorId)).toEqual(["B", "A"]);
    expect(sectorsForMunicipality(scores, "Halle").map((record) => record.sectorId)).toEqual(["A"]);
  });

  it("finds a sector by exact accessible label or identifier", () => {
    const label = sectorSearchLabel(scores.A);
    expect(findSectorFromQuery(scores, label)?.sectorId).toBe("A");
    expect(findSectorFromQuery(scores, "a")?.sectorId).toBe("A");
    expect(findSectorFromQuery(scores, "onbekend")).toBeNull();
  });

  it("computes feature-collection bounds", () => {
    const geojson = {
      features: [
        { properties: { municipality: "Halle" }, geometry: { coordinates: [[[[4, 50], [4.1, 50.2], [4, 50]]]] } },
        { properties: { municipality: "Beersel" }, geometry: { coordinates: [[[[4.2, 50.3], [4.4, 50.5], [4.2, 50.3]]]] } },
      ],
    };
    expect(collectionBounds(geojson)).toEqual([[4, 50], [4.4, 50.5]]);
    expect(collectionBounds(geojson, "Halle")).toEqual([[4, 50], [4.1, 50.2]]);
  });
});
