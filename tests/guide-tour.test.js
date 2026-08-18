import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUIDE_HEATWAVES, GUIDE_OBSERVATIONS, GUIDE_RECORDS, GUIDE_REPORT_URLS, GUIDE_TIMING,
} from "../src/guide-tour.js";
import { en } from "../src/i18n/en.js";
import { nl } from "../src/i18n/nl.js";

const geographyPath = path.resolve("public/data/guide-geography.geojson");

describe("Guide me story contract", () => {
  it("uses the four fixed heatwave observations in chronological order", () => {
    expect(GUIDE_OBSERVATIONS).toEqual([
      "landsat-2023-06-13",
      "landsat-2023-09-09",
      "landsat-2025-08-13",
      "landsat-2026-06-22",
    ]);
  });

  it("keeps a deliberate cinematic pace and four concise heatwave records", () => {
    expect(GUIDE_TIMING).toMatchObject({
      regionDrawMs: 3_200,
      municipalitiesMs: 5_000,
      questionHoldMs: 5_000,
      observationHoldMs: 3_200,
      recordRevealMs: 900,
    });
    expect(GUIDE_HEATWAVES).toHaveLength(4);
    expect(GUIDE_RECORDS).toHaveLength(4);
    expect(GUIDE_RECORDS.map(({ value }) => en[value])).toEqual([
      "12 days of heatwave",
      "7 days above 30°C",
      "39.4°C",
      "24.1°C overnight minimum",
    ]);
    expect(GUIDE_RECORDS.map(({ value }) => nl[value])).toEqual([
      "12 dagen hittegolf",
      "7 dagen boven 30°C",
      "39,4°C",
      "Nachtminimum van 24,1°C",
    ]);
  });

  it("links only to official language-specific KMI/IRM reports", () => {
    expect(GUIDE_REPORT_URLS.nl).toMatch(/^https:\/\/www\.meteo\.be\/nl\//);
    expect(GUIDE_REPORT_URLS.en).toMatch(/^https:\/\/www\.meteo\.be\/fr\//);
    const guideCopy = Object.entries({ en, nl }).flatMap(([, translations]) => Object.entries(translations)
      .filter(([key]) => key.startsWith("guide."))
      .map(([, value]) => value)).join(" ");
    expect(guideCopy).not.toMatch(/Le Soir|RTBF|RTL Belgique/i);
  });

  it("ends with a bilingual preview of future guide insights", () => {
    expect(en["guide.finalMessage"]).toBe(
      "The Guide me tour will soon reveal more insights from this tool. For now, this is a test animation. :)",
    );
    expect(nl["guide.finalMessage"]).toBe(
      "De rondleiding zal binnenkort meer inzichten uit deze tool tonen. Voorlopig is dit een testanimatie. :)",
    );
  });

  it("ships one region and seven north-to-south municipality unions", () => {
    const geography = JSON.parse(fs.readFileSync(geographyPath, "utf8"));
    const region = geography.features.find(({ properties }) => properties.kind === "region");
    const municipalities = geography.features
      .filter(({ properties }) => properties.kind === "municipality")
      .sort((a, b) => a.properties.revealIndex - b.properties.revealIndex);
    const labels = geography.features.filter(({ properties }) => properties.kind === "municipality-label");

    expect(region.properties).toMatchObject({ sectorCount: 154, municipalityCount: 7 });
    expect(municipalities).toHaveLength(7);
    expect(labels).toHaveLength(7);
    expect(municipalities.reduce((sum, feature) => sum + feature.properties.sectorCount, 0)).toBe(154);
    expect(municipalities.map(({ properties }) => properties.name)).toEqual([
      "Drogenbos",
      "Sint-Pieters-Leeuw",
      "Linkebeek",
      "Beersel",
      "Pepingen",
      "Sint-Genesius-Rode",
      "Halle",
    ]);
  });
});
