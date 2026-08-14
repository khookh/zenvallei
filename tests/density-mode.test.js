import { describe, expect, it } from "vitest";
import { createDensityMode, validateDensityContract } from "../src/layers/density-mode.js";
import { setLanguage } from "../src/i18n.js";

const contract = {
  schemaVersion: 1,
  radiusMeters: 100,
  denominator: "complete-circle",
  coordinates: [[4, 51], [5, 51], [5, 50], [4, 50]],
  years: { 2021: { dataUrl: "groenkaart/density/groenkaart-2021-density.tif" } },
};

describe("surface-density browser contract", () => {
  it("accepts the fixed complete-circle 100 m definition", () => {
    expect(validateDensityContract(contract, "groenkaart")).toBe(contract);
  });

  it.each([
    [{ ...contract, radiusMeters: 50 }, "radius"],
    [{ ...contract, denominator: "valid-source" }, "denominator"],
    [{ ...contract, years: null }, "years"],
  ])("rejects an incompatible %s contract", (candidate) => {
    expect(() => validateDensityContract(candidate, "groenkaart")).toThrow(/invalid density contract/i);
  });

  it("shows one soil-sealing value and only incomplete source coverage", () => {
    const mode = createDensityMode({ datasetId: "jaarbak" });
    setLanguage("en");
    expect(mode.getPointPopupModel({
      status: "available", year: 2024, radiusMeters: 100,
      percentage: 72.03, areaHa: 2.26, coverage: 100, selected: [],
    }).lines).toEqual(["Sealed surface: 72.03% (2.26 ha)"]);
    expect(mode.getPointPopupModel({
      status: "available", year: 2024, radiusMeters: 100,
      percentage: 72.03, areaHa: 2.26, coverage: 96.5, selected: [],
    }).lines).toEqual(["Sealed surface: 72.03% (2.26 ha)", "Source coverage: 96.5%"]);
  });

  it("shows Green Map contributions only for a multi-class selection in Dutch", () => {
    const mode = createDensityMode({ datasetId: "groenkaart" });
    setLanguage("nl");
    const common = {
      status: "available", year: 2021, radiusMeters: 100,
      percentage: 35, areaHa: 1.1, coverage: 100,
    };
    expect(mode.getPointPopupModel({
      ...common, selected: [{ label: "Hoog groen", percentage: 35 }],
    }).lines).toHaveLength(1);
    expect(mode.getPointPopupModel({
      ...common, selected: [
        { label: "Hoog groen", percentage: 20 },
        { label: "Laag groen", percentage: 15 },
      ],
    }).lines).toEqual([
      "Geselecteerde vegetatieoppervlakken samen: 35% (1,1 ha)",
      "Hoog groen: 20%", "Laag groen: 15%",
    ]);
    setLanguage("en");
  });
});
