import { describe, expect, it } from "vitest";
import { createIncomeLayer, incomeColorExpression, validateIncomeManifest } from "../src/layers/income-layer.js";
import { setLanguage } from "../src/i18n.js";

const years = [2019, 2020, 2021, 2022, 2023];
const bands = [
  ["under-20000", null, 19999.999, "#eff3ff"],
  ["20000-24999", 20000, 24999.999, "#c6dbef"],
  ["25000-29999", 25000, 29999.999, "#9ecae1"],
  ["30000-34999", 30000, 34999.999, "#6baed6"],
  ["35000-39999", 35000, 39999.999, "#4292c6"],
  ["40000-44999", 40000, 44999.999, "#2171b5"],
  ["45000-plus", 45000, null, "#084594"],
].map(([id, minimum, maximum, color]) => ({ id, minimum, maximum, color }));

function manifest() {
  const stats = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, {
    sourceStatus: index === 153 ? "not-published" : "available",
    medianNetTaxableIncome: index === 153 ? null : 35000,
    averageNetTaxableIncome: index === 153 ? null : 42000,
    numberOfDeclarations: index === 153 ? null : 85,
    interquartileDifference: index === 153 ? null : 18000,
    interquartileCoefficient: index === 153 ? null : 42,
    interquartileAsymmetry: index === 153 ? null : 7,
    renderClass: index === 153 ? "no-data" : "35000-39999",
  }]));
  return {
    schemaVersion: 1, datasetId: "statbel-income", kind: "sector-temporal",
    availableYears: years, defaultYear: 2023, bands, noDataColor: "#EAE2DE",
    years: Object.fromEntries(years.map((year) => [year, { sectorStats: stats }])),
    source: { pageUrl: "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector" },
  };
}

describe("Statbel income layer", () => {
  it("uses the fixed bands and explicit no-data colour", () => {
    const input = manifest();
    expect(validateIncomeManifest(input)).toBe(input);
    const expression = incomeColorExpression(input, 2023);
    expect(expression).toContain("#4292c6");
    expect(expression).toContain("#EAE2DE");
    expect(expression.at(-1)).toBe("#EAE2DE");
  });

  it("switches the year without inventing a municipality aggregate", () => {
    setLanguage("en");
    const layer = createIncomeLayer({ income: manifest() });
    expect(layer.supportsMunicipalitySummary).toBe(false);
    expect(layer.getTemporalControl().values).toEqual(years);
    expect(layer.setOption({ getLayer: () => false }, "year", 2019)).toBe(true);
    expect(layer.getOption("year")).toBe(2019);
    expect(layer.getPopupModel({ properties: { sectorName: "Test" } }, { sectorId: "S0" }).lines[0])
      .toMatch(/€35,000|35,000\s*€/);
    expect(layer.getPopupModel({ properties: { sectorName: "Missing" } }, { sectorId: "S153" }).lines[0])
      .toBe("Data not published or unavailable");
  });
});
