import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  TRANSLATIONS,
  applyDocumentTranslations,
  formatCurrency,
  formatScore,
  formatNumber,
  getLanguage,
  setLanguage,
  t,
} from "../src/i18n.js";

beforeEach(() => setLanguage(DEFAULT_LANGUAGE));

describe("English–Dutch translations", () => {
  it("starts in English", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(getLanguage()).toBe("en");
  });
  it("keeps both catalogues on the same stable contract", () => {
    expect(Object.keys(TRANSLATIONS.en).sort()).toEqual(Object.keys(TRANSLATIONS.nl).sort());
  });

  it("does not use em dashes in interface copy", () => {
    expect(JSON.stringify(TRANSLATIONS)).not.toContain(String.fromCodePoint(0x2014));
  });

  it("does not expose the provisional project name in interface copy", () => {
    expect(Object.values(TRANSLATIONS.nl).join(" ")).not.toMatch(/greenwave/i);
    expect(Object.values(TRANSLATIONS.en).join(" ")).not.toMatch(/greenwave/i);
  });

  it("uses canonical English authority and product names", () => {
    const english = Object.values(TRANSLATIONS.en).join(" ");
    expect(t("authority.departmentCare", {}, "en")).toBe("Department of Care, Government of Flanders");
    expect(t("authority.departmentEnvironment", {}, "en")).toBe("Department of Environment & Spatial Development, Government of Flanders");
    expect(t("authority.natureForests", {}, "en")).toBe("Agency for Nature and Forests, Government of Flanders");
    expect(t("authority.digitalFlanders", {}, "en")).toBe("Digital Flanders Agency");
    expect(t("authority.agricultureFisheries", {}, "en")).toBe("Agency for Agriculture and Fisheries, Government of Flanders");
    expect(t("authority.statbel", {}, "en")).toBe("Statbel, the Belgian statistical office");
    expect(t("authority.copernicusClms", {}, "en")).toBe("Copernicus Land Monitoring Service (CLMS)");
    expect(t("authority.landsat", {}, "en")).toBe("NASA/USGS Landsat");
    expect(t("authority.meteorologicalInstitute", {}, "en")).toBe("Royal Meteorological Institute of Belgium (RMI)");
    expect(t("layers.groenkaart", { year: 2021 }, "en")).toBe("Flanders Green Map 2021");
    expect(t("layers.landgebruik", {}, "en")).toBe("Flanders land use");
    expect(t("jaarbak.contextMeta", { year: 2024 }, "nl")).toBe("JaarBAK · binaire classificatie van 1 m · 2024");
    expect(t("groenkaart.contextMeta", { year: 2021 }, "nl")).toBe("Groenkaart Vlaanderen · vier klassen van 1 m · 2021");
    expect(t("landgebruik.contextMeta", { year: 2025 }, "nl")).toBe("Landgebruik Vlaanderen · classificatie van 10 m · 2025");
    expect(t("about.heatProducer", {}, "nl")).toBe("Departement Zorg van de Vlaamse overheid");
    ["Flemish Government", "Flemish Department", "Government of Flanders, Department", "ANB and Digital Flanders", "Green Map Flanders", "Land use Flanders"]
      .forEach((obsolete) => expect(english).not.toContain(obsolete));
  });

  it("falls back to English for unsupported languages and unknown keys", () => {
    expect(setLanguage("fr")).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(t("brand.title")).toBe("Heat vulnerability");
    expect(t("missing.translation.key")).toBe("missing.translation.key");
  });

  it("interpolates parameters and selects locale-aware plural variants", () => {
    expect(t("count.sectors", { count: 1 }, "nl")).toBe("1 sector");
    expect(t("count.sectors", { count: 154 }, "en")).toBe("154 sectors");
    expect(t("announcement.opened", { sector: "BEERSEL-KERN", municipality: "Beersel" }, "en"))
      .toBe("BEERSEL-KERN, Beersel. Details opened.");
    expect(t("layers.heatWithMetric", { metric: t("heatMetric.heat", {}, "en") }, "en"))
      .toBe("Heat vulnerability · Heat");
    expect(t("heatMetric.final", {}, "nl")).toBe("Eindscore");
    expect(t("heatMetric.final", {}, "en")).toBe("Combined");
  });

  it("provides the complete project introduction in natural Dutch and English", () => {
    expect(t("intro.title", {}, "nl")).toBe("Over dit project");
    expect(t("intro.body1", {}, "nl")).toContain("versie 0.1 van mijn persoonlijke project");
    expect(t("intro.body2", {}, "nl")).toContain("Departement Zorg van de Vlaamse overheid");
    expect(t("intro.body3", {}, "nl")).toContain("grote taalmodellen (LLM’s)");
    expect(t("intro.title", {}, "en")).toBe("About this project");
    expect(t("intro.body1", {}, "en")).toContain("version 0.1 of my personal project");
    expect(t("intro.body1", {}, "en")).toContain("urban heat-island effect");
    expect(t("intro.body2", {}, "en")).toContain("Copernicus and other sources");
    expect(t("intro.body3", {}, "en")).toContain("large language models (LLMs)");
  });

  it("formats fractional scores for the active locale without changing precision", () => {
    expect(formatScore(3.75, "nl")).toBe("3,75");
    expect(formatScore(3.75, "en")).toBe("3.75");
    expect(formatScore(9999, "en")).toBe("No score");
    expect(formatScore(null, "nl")).toBe("n.v.t.");
    expect(formatScore(null, "en")).toBe("N/A");
    expect(formatNumber(24.5, 2, "nl")).toBe("24,5");
    expect(formatNumber(24.5, 2, "en")).toBe("24.5");
    expect(formatCurrency(35420, "en")).toMatch(/€35,420|35,420\s*€/);
    expect(formatCurrency(35420, "nl")).toMatch(/€\s*35\.420|35\.420\s*€/);
  });

  it("updates document metadata, language and accessible attributes", () => {
    document.head.innerHTML = '<meta name="description" content="">';
    document.body.innerHTML = `
      <span data-i18n="brand.title"></span>
      <input data-i18n-placeholder="controls.searchPlaceholder">
      <button data-i18n-aria-label="controls.about"></button>`;
    setLanguage("en");
    applyDocumentTranslations();
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Zennevallei - heat resilience");
    expect(document.querySelector('meta[name="description"]').content).toContain("154 statistical sectors");
    expect(document.querySelector("span").textContent).toBe("Heat vulnerability");
    expect(document.querySelector("input").placeholder).toBe("Name or sector code");
    expect(document.querySelector("button").getAttribute("aria-label")).toBe("Open an explanation of this map");
  });
});
