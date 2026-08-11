import { describe, expect, it } from "vitest";
import { summarizePopulationTemperature, summarizeResidentProfile } from "../src/comparisons/population-profile.js";

const record = (id, population, value) => ({
  cellId: String(id), populationDensityPerHa: population, value,
});

describe("population-temperature exposure profiles", () => {
  const temperatureCell = (id, residents, temperature, count = 3) => ({
    cellId: id, populationDensityPerHa: residents, temperature, contributingCount: count, analysedAreaHa: 0.1,
  });

  it("sorts hottest first and reconciles cumulative residents with 0.5 C bins", () => {
    const summary = summarizePopulationTemperature([
      temperatureCell("cool", 100, 30.2, 4),
      temperatureCell("hot", 40, 35.1, 3),
      temperatureCell("middle", 60, 32.7, 5),
      { ...temperatureCell("insufficient", 900, 40, 2), analysedAreaHa: 0.0999 },
      temperatureCell("zero", 0, 31, 3),
    ]);
    expect(summary.points.map(({ cellId }) => cellId)).toEqual(["hot", "middle", "cool"]);
    expect(summary.totalResidents).toBe(200);
    expect(summary.curve.at(-1).cumulativeResidents).toBe(200);
    expect(summary.bins.reduce((sum, bin) => sum + bin.residents, 0)).toBe(200);
    expect(summary.bins.reduce((sum, bin) => sum + bin.share, 0)).toBeCloseTo(100);
    expect(summary.zeroPopulationCount).toBe(1);
  });

  it("reports residents above, below and inside the selected half-degree interval", () => {
    const summary = summarizePopulationTemperature([
      temperatureCell("a", 20, 34.1), temperatureCell("b", 30, 34.1), temperatureCell("c", 50, 30.2),
    ]);
    expect(summary.curve[0]).toMatchObject({ atOrAboveResidents: 50, coolerResidents: 50, intervalResidents: 50 });
    expect(summary.curve.at(-1)).toMatchObject({ atOrAboveResidents: 100, coolerResidents: 0, intervalResidents: 50 });
  });
});

describe("resident-weighted cumulative profiles", () => {
  it("excludes zero-population cells and reconciles every positive resident", () => {
    const records = [record("zero", 0, 99), ...Array.from({ length: 20 }, (_, index) => record(index, 10 + index, index))];
    const summary = summarizeResidentProfile(records, { valueKey: "value" });
    expect(summary.zeroPopulationCount).toBe(1);
    expect(summary.bands.reduce((sum, band) => sum + band.residents, 0)).toBeCloseTo(summary.totalResidents);
    expect(summary.bands.at(-1).endShare).toBeCloseTo(100);
  });

  it("never splits equal population-density values and merges bands below five cells", () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index, 10 + Math.floor(index / 6) * 10, index));
    const summary = summarizeResidentProfile(records, { valueKey: "value" });
    expect(summary.bands.every((band) => band.count >= 5)).toBe(true);
    expect(summary.bands.every((band, index) => !index || band.minimum > summary.bands[index - 1].maximum)).toBe(true);
  });

  it("uses population weights rather than a geographic-cell mean", () => {
    const records = [record("a", 1, 0), record("b", 9, 100),
      ...Array.from({ length: 8 }, (_, index) => record(index, 1, 0))];
    const summary = summarizeResidentProfile(records, { valueKey: "value" });
    expect(summary.weightedMean).toBeCloseTo(50);
  });
});
