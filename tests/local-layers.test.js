import { describe, expect, it } from "vitest";
import {
  createLocalOfficialLayer,
  validateLocalDatasetDescriptor,
  validateLocalTemporalManifest,
} from "../src/layers/local-official-layers.js";
import { createLandsatTemperatureLayer, localDateTime, validateLandsatManifest } from "../src/layers/landsat-temperature-layer.js";
import { setLanguage } from "../src/i18n.js";
import {
  createLandgebruikLayer,
  validateAgriculturalParcelGeojson,
  validateLandgebruikManifest,
} from "../src/layers/landgebruik-layer.js";
import { parseSingleByteRange } from "../vite.config.js";

function manifest(datasetId = "jaarbak") {
  const years = datasetId === "groenkaart" ? [2018, 2021] : [2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const municipalities = ["Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen", "Sint-Genesius-Rode", "Sint-Pieters-Leeuw"];
  const statistic = { sealedPercentage: 50 };
  const sectorStats = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, statistic]));
  sectorStats.A = sectorStats.S0;
  delete sectorStats.S0;
  return {
    schemaVersion: 2,
    datasetId,
    kind: "categorical",
    availableYears: years,
    defaultYear: Math.max(...years),
    classesOrScale: { items: [{ value: 1, label: { en: "Sealed", nl: "Afgedekt" }, color: "#e8292f" }] },
    source: { url: "https://example.test/source", name: "Source", resolutionLabel: "1 m" },
    years: Object.fromEntries(years.map((year) => [year, {
      status: "final",
      pmtilesVariants: Object.fromEntries(["all", ...municipalities].map((name) => [name, `http://localhost/${year}-${name}.pmtiles`])),
      sectorStats,
      municipalityStats: Object.fromEntries(municipalities.map((name) => [name, statistic])),
    }])),
  };
}

describe("local temporal raster contract", () => {
  it("accepts non-contiguous years and rejects incomplete manifests", () => {
    expect(validateLocalTemporalManifest(manifest(), "jaarbak").availableYears).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024]);
    const broken = manifest();
    delete broken.years[2020].sectorStats;
    expect(() => validateLocalTemporalManifest(broken, "jaarbak")).toThrow("year 2020 is incomplete");
  });

  it("validates lightweight catalogue descriptors without requiring statistics", () => {
    expect(validateLocalDatasetDescriptor({
      datasetId: "groenkaart",
      manifestUrl: "/__local-data__/groenkaart/manifest.json",
      availableYears: [2018, 2021],
      defaultYear: 2021,
    }, "groenkaart").defaultYear).toBe(2021);
  });

  it("exposes a generic temporal control and complete-area panel model", () => {
    const layer = createLocalOfficialLayer({ manifest: manifest(), datasetId: "jaarbak" });
    expect(layer.getTemporalControl().values).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024]);
    expect(layer.getTemporalControl().activeValue).toBe(2024);
    expect(layer.getPanelModel({ sectorId: "A", sectorName: "A", municipality: "Halle" }).stats.sealedPercentage).toBe(50);
  });

  it("parses single HTTP byte ranges and rejects invalid ranges", () => {
    expect(parseSingleByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseSingleByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseSingleByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseSingleByteRange("bytes=100-101", 100)).toBeNull();
    expect(parseSingleByteRange("bytes=10-9", 100)).toBeNull();
  });

  it("validates and presents a semantic Landsat observation timeline", () => {
    const sectorStats = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, {
      medianC: 36.4, p10C: 30.1, p90C: 42.8, clearPercentage: 91.2,
    }]));
    const municipalities = ["Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen", "Sint-Genesius-Rode", "Sint-Pieters-Leeuw"];
    const observation = {
      id: "landsat-2023-06-13", kind: "heatwave", acquiredAt: "2023-06-13T10:47:00Z",
      heatwaveIds: ["2023-06"], pmtilesVariants: { all: "landsat-temperature/test.pmtiles" },
      sectorStats, municipalityStats: Object.fromEntries(municipalities.map((name) => [name, sectorStats.S0])),
    };
    const payload = {
      schemaVersion: 2, datasetId: "landsat-temperature",
      timelineItems: [{ value: observation.id, acquiredAt: observation.acquiredAt, kind: "heatwave", status: "available" }],
      defaultObservation: observation.id, observations: { [observation.id]: observation },
      scale: { stops: [] }, heatwaves: [], source: {},
    };
    expect(validateLandsatManifest(payload)).toMatchObject({ schemaVersion: 2, timelineItems: payload.timelineItems });
    const layer = createLandsatTemperatureLayer({
      descriptor: {
        datasetId: "landsat-temperature", available: true,
        manifestUrl: "/__local-data__/landsat-temperature/manifest.json", assetRoot: "/__local-data__/",
        timelineItems: payload.timelineItems, defaultObservation: observation.id,
      },
      loadManifest: async () => payload,
    });
    expect(layer.getTemporalControl().items[0]).toMatchObject({ kind: "heatwave", value: observation.id });
    expect(layer.getTemporalControl().items[0].ariaLabel).toContain("Heatwave observation");
    expect(layer.getOption("observation")).toBe(observation.id);
    expect(layer.getLegendModel().title).toMatch(/12:47|12\.47/);
    expect(layer.getLegendModel().title).toMatch(/CEST|GMT\+2/);
  });

  it("formats Landsat acquisition instants in Belgian local time across daylight saving", () => {
    setLanguage("en");
    expect(localDateTime("2026-06-22T10:33:40Z")).toMatch(/12:33|12\.33/);
    expect(localDateTime("2026-06-22T10:33:40Z")).toMatch(/CEST|GMT\+2/);
    expect(localDateTime("2026-01-22T10:33:40Z")).toMatch(/11:33|11\.33/);
    expect(localDateTime("2026-01-22T10:33:40Z")).toMatch(/CET|GMT\+1/);
  });

  it("validates the three-year Landgebruik contract and disables parcel detail outside 2025", async () => {
    const municipalities = ["Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen", "Sint-Genesius-Rode", "Sint-Pieters-Leeuw"];
    const sectors = Object.fromEntries(Array.from({ length: 154 }, (_, index) => [`S${index}`, { classes: [] }]));
    const parcelStatistic = {
      completeAreaHa: 100, parcelAreaHa: 20, parcelPercentage: 20, parcelCount: 8, cropGroups: [],
    };
    const years = Object.fromEntries([2019, 2022, 2025].map((year) => [year, {
      pmtilesVariants: { all: `${year}.pmtiles` }, sectorStats: sectors,
      municipalityStats: Object.fromEntries(municipalities.map((name) => [name, { classes: [] }])),
    }]));
    const payload = {
      schemaVersion: 1, datasetId: "landgebruik", kind: "compound-temporal",
      availableYears: [2019, 2022, 2025], defaultYear: 2025,
      classesOrScale: { items: Array.from({ length: 19 }, (_, index) => ({ value: index + 1, color: "#000" })) },
      years, source: {},
      agriculturalDetail: {
        availableYear: 2025,
        geojsonUrl: "landgebruik/agpa-2025.geojson",
        sectorStats: Object.fromEntries(Object.keys(sectors).map((id) => [id, parcelStatistic])),
        municipalityStats: Object.fromEntries(municipalities.map((name) => [name, parcelStatistic])),
      },
    };
    expect(validateLandgebruikManifest(payload)).toBe(payload);
    const layer = createLandgebruikLayer({
      descriptor: {
        datasetId: "landgebruik", defaultYear: 2025, available: true,
        manifestUrl: "/__local-data__/landgebruik/manifest.json", assetRoot: "/__local-data__/",
      },
      loadManifest: async () => payload,
    });
    expect(layer.getTemporalControl().values).toEqual([2019, 2022, 2025]);
    expect(layer.getSecondaryControl().options.find(({ id }) => id === "agriculture").disabled).toBe(false);
    expect(layer.setOption({}, "year", 2022)).toBe(true);
    expect(layer.getSecondaryControl().options.find(({ id }) => id === "agriculture").disabled).toBe(true);
  });

  it("rejects non-finite parcel properties and invalid percentage statistics", () => {
    const featureCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[4, 50], [4.1, 50], [4, 50.1], [4, 50]]] },
        properties: { sectorId: "A", municipality: "Halle", cropGroup: "Grassland", area_ha: 1.5 },
      }],
    };
    expect(validateAgriculturalParcelGeojson(featureCollection)).toBe(featureCollection);
    featureCollection.features[0].properties.area_ha = Number.NaN;
    expect(() => validateAgriculturalParcelGeojson(featureCollection)).toThrow("invalid feature");
  });
});
