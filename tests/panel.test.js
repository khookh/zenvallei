
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../src/i18n.js";
import { createDetailPanel } from "../src/panel-shell.js";
import { renderSectorPanelModel } from "../src/panel.js";

const dataDir = path.resolve(import.meta.dirname, "..", "public", "data");
let methodology;
let records;

const urbanAtlas = {
  available: true,
  activeYear: 2021,
  generatedAt: "2026-08-05T10:00:00.000Z",
  source: {
    productUrl: "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021",
    doi: "https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a",
    accessedAt: "2026-08-05T10:00:00.000Z",
    validationStatus: "not-yet-validated",
    validationStatusCheckedAt: "2026-08-05T10:00:00.000Z",
  },
  classes: [
    { code: "11100", color: "#800000", artificialGroupKey: "urbanFabric" },
    { code: "12100", color: "#cc4df2", artificialGroupKey: "industryServices" },
    { code: "12220", color: "#b3b3b3", artificialGroupKey: "transport" },
    { code: "13300", color: "#b9a56e", artificialGroupKey: "constructionExtraction" },
    { code: "14110", color: "#8cdc00" },
    { code: "14120", color: "#74b800" },
    { code: "14130", color: "#5a8f00" },
    { code: "14200", color: "#afd2a5" },
    { code: "21000", color: "#ffffa8" },
    { code: "23000", color: "#e6e64d" },
    { code: "31000", color: "#008c00" },
    { code: "32000", color: "#ccf24d" },
  ],
  sectorStats: {
    "23003A001": {
      validAreaHa: 25,
      dominantClassCode: "31000",
      green: {
        areaHa: 10,
        percentage: 40,
        classes: [
          { code: "31000", areaHa: 5, sectorPercentage: 20, metricPercentage: 50 },
          { code: "32000", areaHa: 2, sectorPercentage: 8, metricPercentage: 20 },
          { code: "23000", areaHa: 1.25, sectorPercentage: 5, metricPercentage: 12.5 },
          { code: "14110", areaHa: 1, sectorPercentage: 4, metricPercentage: 10 },
          { code: "14120", areaHa: 0.5, sectorPercentage: 2, metricPercentage: 5 },
          { code: "14130", areaHa: 0.25, sectorPercentage: 1, metricPercentage: 2.5 },
        ],
      },
      artificial: {
        areaHa: 10,
        percentage: 40,
        classes: [
          { code: "11100", areaHa: 4, sectorPercentage: 16, metricPercentage: 40 },
          { code: "12100", areaHa: 2, sectorPercentage: 8, metricPercentage: 20 },
          { code: "12220", areaHa: 3, sectorPercentage: 12, metricPercentage: 30 },
          { code: "13300", areaHa: 1, sectorPercentage: 4, metricPercentage: 10 },
        ],
      },
      otherClasses: [
        { code: "14200", areaHa: 2, sectorPercentage: 8 },
        { code: "21000", areaHa: 3, sectorPercentage: 12 },
      ],
    },
  },
};

beforeAll(async () => {
  methodology = JSON.parse(await fs.readFile(path.join(dataDir, "methodology.json"), "utf8"));
  records = JSON.parse(await fs.readFile(path.join(dataDir, "scores.json"), "utf8")).sectors;
});

beforeEach(() => setLanguage("nl"));

function fixture(options = {}) {
  document.body.innerHTML = `
    <button id="trigger">open</button>
    <aside id="panel" aria-hidden="true" tabindex="-1"><button id="close">sluit</button><div id="content"></div></aside>`;
  const onClose = vi.fn();
  const api = createDetailPanel({
    panel: document.querySelector("#panel"),
    content: document.querySelector("#content"),
    closeButton: document.querySelector("#close"),
    getPanelModel: (layerId, record, panelState) => {
      const sharedData = {
        record,
        methodology,
        urbanAtlas: options.urbanAtlas,
      };
      if (layerId === "urban-atlas") return { template: "urban-atlas", ...sharedData };
      return { template: "heat", ...sharedData, heatMetric: panelState.heatMetric };
    },
    getAboutModel: () => ({
      methodology,
      urbanAtlas: options.urbanAtlas,
      provenance: options.provenance,
    }),
    onClose,
  });
  return { api, onClose };
}

describe("progressive detail panel", () => {
  it("renders the generic metric model used by simple future layers", () => {
    const html = renderSectorPanelModel({
      template: "metric-summary",
      record: { sectorId: "A", sectorName: "Testsector", municipality: "Halle" },
      title: "Tree canopy",
      value: 28.4,
      unit: "%",
      notes: ["Prepared outside the browser."],
    });
    expect(html).toContain("Testsector");
    expect(html).toContain("28,4");
    expect(html).toContain("Prepared outside the browser.");
  });
  it("shows public summary and policy-level component details", () => {
    const { api } = fixture();
    api.open(records["23003A001"], document.querySelector("#trigger"));
    const panel = document.querySelector("#panel");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.textContent).toContain("BEERSEL-KERN");
    expect(panel.textContent).toContain("Score 6 van 10");
    expect(panel.textContent).toContain("Relatieve rangschikking van het gemiddelde aantal hittegolfgraaddagen");
    expect(panel.textContent).toContain("bevolking, kwetsbare voorzieningen, SES");
    expect(panel.textContent).toContain("geen eenvoudig gemiddelde");
    expect(panel.textContent).toContain("Officieel broncijfer");
    expect(panel.textContent).toContain("zonder ze opnieuw te berekenen");
    expect(panel.textContent).toContain("3,75");
    expect(panel.textContent).toContain("gewicht 2");
    expect(panel.textContent).toContain("Bekijk de acht SES-deelindicatoren");
  });

  it("explains no-data sectors without turning blanks into zero", () => {
    const { api } = fixture();
    api.open(records["23027A183"]);
    expect(document.querySelector("#panel").textContent).toContain("Onvoldoende gegevens");
    expect(document.querySelector("#panel").textContent).toContain("onvoldoende bevolkings- of SES-gegevens");
  });

  it("renders complete English content and preserves expanded sections on a language update", () => {
    const { api } = fixture();
    api.open(records["23003A001"], document.querySelector("#trigger"));
    const indicatorDetails = document.querySelector('[data-section="indicators"]');
    const sesDetails = document.querySelector('[data-section="ses"]');
    indicatorDetails.open = true;
    sesDetails.open = true;
    setLanguage("en");
    api.setLanguage();
    const panel = document.querySelector("#panel");
    expect(panel.textContent).toContain("Score 6 out of 10");
    expect(panel.textContent).toContain("Heat");
    expect(panel.textContent).toContain("Vulnerability");
    expect(panel.textContent).toContain("3.75");
    expect(panel.textContent).toContain("weight 2");
    expect(document.querySelector('[data-section="indicators"]').open).toBe(true);
    expect(document.querySelector('[data-section="ses"]').open).toBe(true);
  });

  it("makes the selected heat metric the headline and preserves panel state", () => {
    const { api } = fixture();
    api.open(records["23003A001"], document.querySelector("#trigger"));
    document.querySelector('[data-section="indicators"]').open = true;

    api.setHeatMetric("heat");
    const panel = document.querySelector("#panel");
    expect(panel.querySelector(".score-orb strong").textContent).toBe("7");
    expect(panel.querySelector(".score-caption").textContent).toContain("Hitte: 7 van 10");
    expect(panel.textContent).toContain("meer langdurige blootstelling aan hitte");
    expect([...panel.querySelectorAll(".summary-card")].map((card) => card.textContent)).toEqual([
      expect.stringContaining("Eindscore"),
      expect.stringContaining("Kwetsbaarheid"),
    ]);
    expect(document.querySelector('[data-section="indicators"]').open).toBe(true);

    api.setHeatMetric("vulnerability");
    expect(panel.querySelector(".score-orb strong").textContent).toBe("8");
    expect(panel.querySelector(".score-caption").textContent).toContain("Kwetsbaarheid: 8 van 10");
    expect(panel.textContent).toContain("grotere samengestelde kwetsbaarheid");
    expect([...panel.querySelectorAll(".summary-card")].map((card) => card.textContent)).toEqual([
      expect.stringContaining("Eindscore"),
      expect.stringContaining("Hitte"),
    ]);

    setLanguage("en");
    api.setLanguage();
    expect(panel.querySelector(".score-caption").textContent).toContain("Vulnerability: 8 out of 10");
    expect(document.querySelector('[data-section="indicators"]').open).toBe(true);
  });

  it("translates insufficient-data and institution-without-score states", () => {
    const { api } = fixture();
    setLanguage("en");
    api.open(records["23027A183"]);
    expect(document.querySelector("#panel").textContent).toContain("Insufficient data");
    expect(document.querySelector("#panel").textContent).toContain("population or SES information is insufficient");

    api.open({
      ...records["23027A183"],
      status: "institution-present-no-score",
      scores: { ...records["23027A183"].scores, final: 9999 },
    });
    expect(document.querySelector("#panel").textContent).toContain("Vulnerable institution present");
  });

  it("keeps selected-metric no-data states explicit", () => {
    const { api } = fixture();
    api.open(records["23027A183"]);
    api.setHeatMetric("heat");
    expect(document.querySelector(".score-orb strong").textContent).toBe("n.v.t.");
    expect(document.querySelector("#panel").textContent).toContain("Onvoldoende gegevens");
  });

  it("rerenders a selected sector and closes dataset-specific details when the layer changes", () => {
    const { api } = fixture({ urbanAtlas });
    api.open(records["23003A001"], document.querySelector("#trigger"), "heat");
    document.querySelector('[data-section="indicators"]').open = true;
    api.setActiveLayer("urban-atlas");
    expect(document.querySelector("#panel").textContent).toContain("Groenbedekking");
    expect(document.querySelector("#panel").textContent).toContain("40%");
    expect(document.querySelector("#panel").textContent).toContain("Kruidachtige vegetatie");
    expect(document.querySelector("#panel").textContent).toContain("Weilanden");
    expect(document.querySelector("#panel").textContent).toContain("Artificialisering");
    expect(document.querySelector("#panel").textContent).toContain("40%");
    expect(document.querySelector("#panel").textContent).toContain("polygonen en klassen zijn afkomstig van Copernicus");
  });

  it("shows all six green categories and translated Urban Atlas methodology", () => {
    const { api } = fixture({ urbanAtlas });
    api.open(records["23003A001"], document.querySelector("#trigger"), "urban-atlas");
    const panel = document.querySelector("#panel");
    expect(panel.textContent).toContain("Bossen");
    expect(panel.textContent).toContain("Kruidachtige vegetatie");
    expect(panel.textContent).toContain("Weilanden");
    expect(panel.textContent).toContain("publieke toegang");
    expect(panel.textContent).toContain("private toegang");
    expect(panel.textContent).toContain("toegang onbekend");
    expect(panel.textContent).toContain("Bouwterreinen");
    expect(panel.textContent).toContain("Andere landbedekking");
    document.querySelector('[data-section="urban-atlas-methodology"]').open = true;
    setLanguage("en");
    api.setLanguage();
    expect(panel.textContent).toContain("Green coverage");
    expect(panel.textContent).toContain("Herbaceous vegetation");
    expect(panel.textContent).toContain("Pastures");
    expect(panel.textContent).toContain("not yet validated");
    expect(document.querySelector('[data-section="urban-atlas-methodology"]').open).toBe(true);
  });

  it("explains the active layers, Statbel sectors and calculation responsibility", () => {
    const provenance = {
      output: {
        sectorCount: 154,
        municipalityCounts: { Beersel: 39, Drogenbos: 7, Halle: 41, Linkebeek: 7, Pepingen: 15, "Sint-Genesius-Rode": 22, "Sint-Pieters-Leeuw": 23 },
      },
    };
    const { api } = fixture({ urbanAtlas, provenance });
    api.openAbout(document.querySelector("#trigger"));
    const panel = document.querySelector("#panel");
    expect(panel.textContent).toContain("Wat elke laag vertelt");
    expect(panel.textContent).toContain("Landgebruik");
    expect(panel.textContent).toContain("visuele interpretatie");
    expect(panel.textContent).toContain("Waarom 154 sectoren?");
    expect(panel.textContent).toContain("Statbel bepaalt hun codes en grenzen");
    expect(panel.textContent).toContain("Officiële producent");
    expect(panel.textContent).toContain("Wat wij toevoegen");
    expect(panel.textContent).toContain("OpenStreetMap is alleen de achtergrondkaart");
    expect(panel.textContent).toContain("Een persoonlijk en open V0.1-project");
    expect(panel.textContent).toContain("grote taalmodellen (LLM’s)");
    expect(panel.querySelector('a[href="https://github.com/khookh/zenvallei"]')?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(panel.textContent).toContain("Deze toepassing gebruikt geen cookies, analytics, accounts of blijvende identificatoren");
    expect(panel.querySelector('.about-privacy a[href="mailto:stefanodonne@gmail.com"]')?.textContent).toBe("stefanodonne@gmail.com");

    setLanguage("en");
    api.setLanguage();
    expect(panel.textContent).toContain("What each layer tells you");
    expect(panel.textContent).toContain("Land use");
    expect(panel.textContent).toContain("Why 154 sectors?");
    expect(panel.textContent).toContain("Statbel defines their codes and boundaries");
    expect(panel.textContent).toContain("Official producer");
    expect(panel.textContent).toContain("What we add");
    expect(panel.textContent).toContain("A personal and open V0.1 project");
    expect(panel.textContent).toContain("large language models (LLMs)");
    expect(panel.textContent).toContain("This application uses no cookies, analytics, accounts or persistent identifiers");
  });

  it("presents Landsat temperature as an overpass measurement with clear coverage", () => {
    setLanguage("en");
    const html = renderSectorPanelModel({
      template: "landsat-temperature",
      record: records["23003A001"],
      observation: {
        id: "landsat-2023-06-13", kind: "heatwave", acquiredAt: "2023-06-13T10:47:00Z",
        heatwaveIds: ["2023-06"], sceneIds: ["LC08_TEST"],
      },
      stats: {
        medianC: 36.4, meanC: 35.8, p10C: 29.1, p90C: 42.6,
        clearPercentage: 91.2, cloudAreaHa: 2.5, cloudPercentage: 4.1,
        otherNoDataAreaHa: 2.8, otherNoDataPercentage: 4.7,
        medianUncertaintyK: 0.65, pixelCount: 704,
      },
      manifest: {
        heatwaves: [{ id: "2023-06", start: "2023-06-08", end: "2023-06-17" }],
        source: { productUrl: "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature" },
        kmi: { definitionUrl: "https://www.meteo.be/" },
      },
    });
    document.querySelector("#content").innerHTML = html;
    const text = document.querySelector("#content").textContent;
    expect(text).toContain("Heatwave observation");
    expect(text).toContain("36.4");
    expect(text).toContain("not air temperature");
    expect(text).toContain("Clear coverage: 91.2%");
    expect(text).toContain("P10");
    expect(text).toContain("P90");
    expect(document.querySelector('[data-section="landsat-methodology"]').hasAttribute("open")).toBe(false);

    setLanguage("nl");
    const dutch = renderSectorPanelModel({
      template: "landsat-temperature",
      record: records["23003A001"],
      observation: { kind: "reference", acquiredAt: "2023-06-07T10:47:00Z", heatwaveIds: [], sceneIds: [] },
      stats: { medianC: 24.5, meanC: 24.1, p10C: 19, p90C: 30, clearPercentage: 95, pixelCount: 10 },
      manifest: { heatwaves: [], source: {}, kmi: {} },
    });
    expect(dutch).toContain("Waarneming tijdens een hittegolf");
    expect(dutch).toContain("geen luchttemperatuur");
  });

  it("renders continuous and categorical local notebook summaries without frontend-specific data", () => {
    const record = records["23003A001"];
    const continuous = renderSectorPanelModel({
      template: "notebook-test",
      record,
      manifest: {
        kind: "continuous", units: "NDVI",
        title: { en: "Halle NDVI test", nl: "Halle NDVI-test" },
        description: { en: "Python output", nl: "Python-uitvoer" },
      },
      stats: { validAreaHa: 12.5, sectorAreaHa: 20, minimum: -0.1, maximum: 0.9, mean: 0.55, median: 0.6 },
    });
    expect(continuous).toContain("Halle NDVI-test");
    expect(continuous).toContain("Mediaan");
    expect(continuous).toContain("0,6 NDVI");
    expect(continuous).toContain("maakt geen deel uit van het publieke dashboard");

    setLanguage("en");
    const categorical = renderSectorPanelModel({
      template: "notebook-test",
      record,
      manifest: {
        kind: "categorical", units: "",
        title: "Classification test", description: "Python output",
        legend: { items: [{ value: 1, label: "Class one", color: "#238b45" }] },
      },
      stats: { validAreaHa: 10, sectorAreaHa: 20, classes: [{ value: 1, areaHa: 10, percentage: 100 }] },
    });
    expect(categorical).toContain("Class breakdown");
    expect(categorical).toContain("Class one");
    expect(categorical).toContain("10 ha · 100%");
    expect(categorical).toContain("not part of the public dashboard");
  });

  it("renders local official rasters with readable summaries and technical coverage only in Methodology", () => {
    const record = records["23003A001"];
    const baseManifest = {
      source: { name: "Official source", url: "https://example.test/source" },
      years: { 2024: { status: "provisional" }, 2021: { status: "final" } },
    };
    setLanguage("en");
    const soil = renderSectorPanelModel({
      template: "local-official-raster", datasetId: "jaarbak", record, year: 2024,
      manifest: baseManifest,
      stats: { sealedAreaHa: 17.79, sealedPercentage: 34.59, unsealedAreaHa: 33.64, unsealedPercentage: 65.4, validAreaHa: 51.43, validPercentage: 99.99, noDataAreaHa: 0.01, noDataPercentage: 0.01 },
    });
    expect(soil).toContain("Sealed and unsealed ground");
    expect(soil).toContain("artificial material that is wholly or partly impermeable");
    expect(soil).toContain("The production method changed in 2023");
    expect(soil).toContain("data-section=\"local-raster-methodology\"");
    expect(soil.indexOf("Missing coverage")).toBeGreaterThan(soil.indexOf("local-raster-methodology"));

    const greenMap = renderSectorPanelModel({
      template: "local-official-raster", datasetId: "groenkaart", record, year: 2021,
      manifest: {
        ...baseManifest,
        classesOrScale: { items: [
          { value: 1, color: "#008000" }, { value: 2, color: "#b6ff00" },
          { value: 3, color: "#ffff00" }, { value: 4, color: "#b8b8b8" },
        ] },
      },
      stats: { classes: [1, 2, 3, 4].map((code) => ({ code, areaHa: 12.5, percentage: 25 })), validAreaHa: 50, validPercentage: 100, noDataAreaHa: 0, noDataPercentage: 0 },
    });
    expect(greenMap).toContain("Vegetation higher than 3 m");
    expect(greenMap).toContain("Vegetation lower than 3 m");
    expect(greenMap).toContain("Agricultural parcels");
    expect(greenMap).not.toContain("--score-color:#ffff00");

  });

  it("leads agricultural use with complete-area percentage and keeps crop shares explicit", () => {
    setLanguage("en");
    const html = renderSectorPanelModel({
      template: "landgebruik", mode: "agriculture", year: 2025,
      record: records["23027C091"],
      stats: { classes: [] },
      parcelStats: {
        completeAreaHa: 414.29, parcelAreaHa: 296.35, parcelPercentage: 71.53, parcelCount: 163,
        cropGroups: [{ sourceLabel: "Grasland", areaHa: 180, percentage: 60.74 }],
      },
      manifest: {
        source: {}, classesOrScale: { items: [] },
        agriculturalDetail: { cropGroups: [{ sourceLabel: "Grasland", color: "#BFFF7F" }], source: {} },
      },
    });
    expect(html).toContain("71.5");
    expect(html).toContain("296.35 ha across 163 mapped parcels");
    expect(html).toContain("complete Statbel-defined area");
    expect(html).toContain("mapped parcel area as their denominator");
  });

  it("presents Statbel income as a fiscal indicator without fabricating a distribution", () => {
    setLanguage("en");
    const html = renderSectorPanelModel({
      template: "income", year: 2023, record: records["23003A001"],
      income: { source: { pageUrl: "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector" } },
      stats: {
        sourceStatus: "available", medianNetTaxableIncome: 35420, averageNetTaxableIncome: 42110,
        numberOfDeclarations: 212, interquartileDifference: 18350,
        interquartileCoefficient: 41, interquartileAsymmetry: 6,
      },
    });
    expect(html).toMatch(/€35,420|35,420\s*€/);
    expect(html).toContain("not a salary, disposable household income or wealth measure");
    expect(html).toContain("does not publish a complete income-bracket distribution");
    expect(html).toContain("not adjusted for inflation");
    expect(html).toContain("data-section=\"income-methodology\"");
  });

  it("closes on Escape and reports the close action", () => {
    const { api, onClose } = fixture();
    api.open(records["23003A001"]);
    document.querySelector("#panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(api.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
