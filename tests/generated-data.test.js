/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = path.resolve(import.meta.dirname, "..", "public", "data");
const readJson = async (file) => JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));

describe("generated Zennevallei data contract", () => {
  it("contains an exact, one-to-one 154-sector geometry join", async () => {
    const [geojson, scores, provenance] = await Promise.all([
      readJson("sectors.geojson"),
      readJson("scores.json"),
      readJson("provenance.json"),
    ]);
    const featureIds = geojson.features.map((feature) => feature.properties.sectorId);
    expect(geojson.features).toHaveLength(154);
    expect(new Set(featureIds).size).toBe(154);
    expect(geojson.features.every((feature) => feature.geometry.type === "MultiPolygon" && feature.geometry.coordinates.length > 0)).toBe(true);
    expect(Object.keys(scores.sectors)).toHaveLength(154);
    expect(provenance.output.sectorCount).toBe(154);
    expect(provenance.output.inputVertices).toBe(provenance.output.outputVertices);
    expect(provenance.output.inputVertices).toBe(28693);
  });

  it("pins the verified municipalities and source states", async () => {
    const [scores, provenance] = await Promise.all([readJson("scores.json"), readJson("provenance.json")]);
    expect(provenance.output.municipalityCounts).toEqual({
      Beersel: 39,
      Drogenbos: 7,
      Halle: 41,
      Linkebeek: 7,
      Pepingen: 15,
      "Sint-Genesius-Rode": 22,
      "Sint-Pieters-Leeuw": 23,
    });
    expect(provenance.output.scoredCount).toBe(140);
    expect(provenance.output.insufficientDataCount).toBe(14);
    expect(scores.sectors["23027A183"].status).toBe("insufficient-data");
    expect(scores.sectors["23027A183"].scores.final).toBeNull();
  });

  it("preserves known score values and the corrected Statbel display name", async () => {
    const scores = await readJson("scores.json");
    const beersel = scores.sectors["23003A001"];
    expect(beersel.scores.final).toBe(6);
    expect(beersel.scores.heat).toBe(7);
    expect(beersel.scores.vulnerability).toBe(8);
    expect(beersel.scores.components.sesIndex).toBe(3.75);
    expect(scores.sectors["23077D00-"].sectorName).toBe("VLEZENBEEK-KERN");
    expect(scores.sectors["23077D00-"].workbookSectorName).toBe("VLEZENBEK-KERN");
  });

  it("keeps all output coordinates in plausible WGS84 bounds", async () => {
    const provenance = await readJson("provenance.json");
    expect(provenance.output.targetCrs).toBe("EPSG:4326");
    expect(provenance.output.bounds.minLon).toBeGreaterThan(3.5);
    expect(provenance.output.bounds.maxLon).toBeLessThan(5.5);
    expect(provenance.output.bounds.minLat).toBeGreaterThan(49.5);
    expect(provenance.output.bounds.maxLat).toBeLessThan(51.5);
  });

  it("defines every rendering class, including the future sentinel fixture", async () => {
    const methodology = await readJson("methodology.json");
    expect(methodology.palette).toEqual({
      "no-data": "#EAE2DE",
      "score-0": "#97D8E5",
      "score-1": "#6EC3ED",
      "score-2": "#6AA7F0",
      "score-3": "#8E85E2",
      "score-4": "#B657BA",
      "score-5": "#CC017A",
      "score-6": "#B10064",
      "score-7": "#96004E",
      "score-8": "#7C003A",
      "score-9": "#610027",
      "score-10": "#000000",
      "institution-present-no-score": "#F1CE63",
    });
  });

  it("publishes the documented weights and all eight SES details", async () => {
    const methodology = await readJson("methodology.json");
    expect(Object.fromEntries(methodology.vulnerabilityComponents.map(({ key, weight }) => [key, weight]))).toEqual({
      populationDensity: 1,
      age0To9: 1,
      age65Plus: 1,
      primaryEducation: 0.5,
      childcare: 0.5,
      residentialElderlyCare: 0.5,
      hospitals: 0.5,
      sesIndex: 2,
      trees50m: 0.5,
      neighborhoodGreen: 0.5,
    });
    expect(Object.fromEntries(methodology.vulnerabilityComponents.map(({ key, groupKey }) => [key, groupKey]))).toEqual({
      populationDensity: "population",
      age0To9: "population",
      age65Plus: "population",
      primaryEducation: "facilities",
      childcare: "facilities",
      residentialElderlyCare: "facilities",
      hospitals: "facilities",
      sesIndex: "socioeconomic",
      trees50m: "green",
      neighborhoodGreen: "green",
    });
    expect(methodology.sesComponents).toHaveLength(8);
  });

  it("publishes five comparable Statbel income years without inventing missing values", async () => {
    const income = await readJson("income.json");
    expect(income.availableYears).toEqual([2019, 2020, 2021, 2022, 2023]);
    expect(income.defaultYear).toBe(2023);
    expect(income.bands.map(({ color }) => color)).toEqual([
      "#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594",
    ]);
    for (const year of income.availableYears) {
      const records = Object.values(income.years[year].sectorStats);
      expect(records).toHaveLength(154);
      expect(income.years[year].matchedCount).toBe(150);
      expect(records.filter(({ sourceStatus }) => sourceStatus === "available")).toHaveLength(141);
      expect(records.filter(({ sourceStatus }) => sourceStatus !== "available")).toHaveLength(13);
      expect(records.filter(({ sourceStatus }) => sourceStatus !== "available")
        .every(({ medianNetTaxableIncome }) => medianNetTaxableIncome === null)).toBe(true);
    }
  });

});
