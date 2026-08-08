import { describe, expect, it } from "vitest";
import { validateDensityContract } from "../src/layers/density-mode.js";

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
});
