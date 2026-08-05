import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../src/i18n.js";
import { createDetailPanel, renderSectorPanelModel } from "../src/panel.js";

const dataDir = path.resolve(import.meta.dirname, "..", "public", "data");
let methodology;
let records;

const landCover = {
  activeYear: 2020,
  generatedAt: "2026-08-05T10:00:00.000Z",
  source: { productUrl: "https://land.copernicus.eu/example" },
  classes: [
    { code: 10, key: "treeCover", color: "#006400" },
    { code: 30, key: "grassland", color: "#ffff4c" },
    { code: 40, key: "cropland", color: "#f096ff" },
    { code: 90, key: "builtUp", color: "#fa0000" },
  ],
  sectorStats: {
    "23003A001": {
      classifiedAreaHa: 24.5,
      vegetationAreaHa: 15,
      vegetationPercentage: 61.22,
      builtUpAreaHa: 5.5,
      builtUpPercentage: 22.45,
      dominantClassCode: 10,
      classes: [
        { code: 10, areaHa: 10, percentage: 40.82 },
        { code: 30, areaHa: 5, percentage: 20.41 },
        { code: 40, areaHa: 4, percentage: 16.33 },
        { code: 90, areaHa: 5.5, percentage: 22.45 },
      ],
    },
  },
  change: {
    available: true,
    baseYear: 2020,
    comparisonYear: 2026,
    sectorStats: {
      "23003A001": {
        gainedAreaHa: 1.25,
        gainedPercentage: 5,
        lostAreaHa: 0.75,
        lostPercentage: 3,
        netChangeAreaHa: 0.5,
        unchangedVegetationAreaHa: 17.2,
      },
    },
  },
};

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
        landCover: options.landCover,
        urbanAtlas: options.urbanAtlas,
      };
      if (layerId === "land-cover") return { template: "land-cover", ...sharedData };
      if (layerId === "urban-atlas") return { template: "urban-atlas", ...sharedData };
      return { template: "heat", ...sharedData, heatMetric: panelState.heatMetric };
    },
    getAboutModel: () => ({
      methodology,
      landCover: options.landCover,
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
    expect(document.querySelector("#panel").textContent).toContain("population or SES data is insufficient");

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

  it("shows Copernicus class statistics and updates them in English", () => {
    const { api } = fixture({ landCover, urbanAtlas });
    api.open(records["23003A001"], document.querySelector("#trigger"), "land-cover");
    const panel = document.querySelector("#panel");
    expect(panel.textContent).toContain("Dominante landbedekking");
    expect(panel.textContent).toContain("Boombedekking");
    expect(panel.textContent).toContain("Groenbedekking (bomen + gras)");
    expect(panel.textContent).toContain("61,22%");
    expect(panel.textContent).toContain("Bebouwde oppervlakte");
    expect(panel.textContent).toContain("22,45%");
    expect(panel.textContent).toContain("Berekend door deze toepassing");
    expect(panel.textContent).toContain("pixelklassen zijn afkomstig van Copernicus");
    expect(panel.textContent).not.toContain("Gekarteerd gebied");
    document.querySelector('[data-section="land-cover-classes"]').open = true;
    setLanguage("en");
    api.setLanguage();
    expect(panel.textContent).toContain("Dominant land cover");
    expect(panel.textContent).toContain("Tree cover");
    expect(panel.textContent).toContain("Green cover (trees + grass)");
    expect(panel.textContent).toContain("61.22%");
    expect(panel.textContent).toContain("Built-up area");
    expect(panel.textContent).toContain("22.45%");
    expect(panel.textContent).not.toContain("Mapped area");
    expect(document.querySelector('[data-section="land-cover-classes"]').open).toBe(true);
  });

  it("rerenders an open selected sector when the active layer changes", () => {
    const { api } = fixture({ landCover, urbanAtlas });
    api.open(records["23003A001"], document.querySelector("#trigger"), "heat");
    document.querySelector('[data-section="indicators"]').open = true;
    api.setActiveLayer("land-cover");
    expect(document.querySelector("#panel").textContent).toContain("Landbedekking per klasse");
    expect(document.querySelector('[data-section="land-cover-classes"]').open).toBe(true);
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
    const { api } = fixture({ landCover, urbanAtlas });
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

  it("explains the three layers, Statbel sectors and calculation responsibility", () => {
    const provenance = {
      output: {
        sectorCount: 154,
        municipalityCounts: { Beersel: 39, Drogenbos: 7, Halle: 41, Linkebeek: 7, Pepingen: 15, "Sint-Genesius-Rode": 22, "Sint-Pieters-Leeuw": 23 },
      },
    };
    const { api } = fixture({ landCover, urbanAtlas, provenance });
    api.openAbout(document.querySelector("#trigger"));
    const panel = document.querySelector("#panel");
    expect(panel.textContent).toContain("Drie lagen, drie vragen");
    expect(panel.textContent).toContain("10 m-pixels");
    expect(panel.textContent).toContain("semi-automatische verwerking en visuele interpretatie");
    expect(panel.textContent).toContain("Waarom 154 sectoren?");
    expect(panel.textContent).toContain("Statbel bepaalt hun codes en grenzen");
    expect(panel.textContent).toContain("Wie berekende wat?");
    expect(panel.textContent).toContain("OpenStreetMap is alleen de achtergrondkaart");

    setLanguage("en");
    api.setLanguage();
    expect(panel.textContent).toContain("Three layers, three questions");
    expect(panel.textContent).toContain("Why 154 sectors?");
    expect(panel.textContent).toContain("Statbel defines their codes and boundaries");
    expect(panel.textContent).toContain("Who calculated what?");
  });

  it("closes on Escape and reports the close action", () => {
    const { api, onClose } = fixture();
    api.open(records["23003A001"]);
    document.querySelector("#panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(api.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
