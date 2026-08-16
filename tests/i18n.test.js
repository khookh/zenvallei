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

  it("uses the same land-surface-temperature warning in Landsat and shared comparison panels", () => {
    for (const language of ["en", "nl"]) {
      expect(t("landsat.definition", {}, language)).toBe(t("comparison.surfaceTemperatureDefinition", {}, language));
    }
    expect(t("landsat.definition", {}, "en")).toBe(
      "This is land-surface temperature, not air temperature. It shows how hot buildings, streets, vegetation and other surfaces were around the NASA/USGS satellite overpass. These differences help explain urban heat islands and radiant heat at street level, but do not directly measure air temperature.",
    );
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
    expect(t("jaarbak.contextMeta", { year: 2024 }, "nl")).toBe("Bodemafdekking · 1 m · 2024");
    expect(t("groenkaart.contextMeta", { year: 2021 }, "nl")).toBe("Groenkaart Vlaanderen · 1 m · 2021");
    expect(t("landgebruik.contextMeta", { year: 2025 }, "nl")).toBe("Landgebruik Vlaanderen · 10 m · 2025");
    ["Flemish Government", "Flemish Department", "Government of Flanders, Department", "ANB and Digital Flanders", "Green Map Flanders", "Land use Flanders"]
      .forEach((obsolete) => expect(english).not.toContain(obsolete));
  });

  it("reserves JaarBAK for formal product and methodology references", () => {
    for (const language of ["en", "nl"]) {
      const keys = Object.entries(TRANSLATIONS[language])
        .filter(([, value]) => String(value).includes("JaarBAK"))
        .map(([key]) => key)
        .sort();
      expect(keys).toEqual(["jaarbak.methodology", "sources.productJaarbak"]);
    }
  });

  it("does not expose the retired Urban Atlas artificialisation terminology", () => {
    expect(Object.values(TRANSLATIONS.en).join(" ")).not.toMatch(/artificialisation/i);
    expect(Object.values(TRANSLATIONS.nl).join(" ")).not.toMatch(/artificialisering/i);
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

  it("uses one concise project and privacy statement in Dutch and English", () => {
    expect(t("intro.title", {}, "nl")).toBe("Over dit project");
    expect(t("project.summary", {}, "nl")).toContain("persoonlijk, open project");
    expect(t("project.summary", {}, "nl")).toContain("Zennevallei");
    expect(t("project.privacy", {}, "nl")).toContain("geen cookies, analytics");
    expect(t("intro.title", {}, "en")).toBe("About this project");
    expect(t("project.summary", {}, "en")).toContain("personal, open project");
    expect(t("project.summary", {}, "en")).toContain("currently limited to Zennevallei");
    expect(t("project.privacy", {}, "en")).toContain("No cookies, analytics");
  });

  it("uses the approved plain-language questions in About", () => {
    expect(t("about.heatQuestion", {}, "en")).toBe("Which neighbourhoods are most vulnerable during heatwaves?");
    expect(t("about.landsatQuestion", {}, "en")).toBe("How hot was the ground during past heatwaves?");
    expect(t("about.urbanAtlasQuestion", {}, "en")).toBe("What is the main land cover or land use in each mapped area?");
    expect(t("about.jaarbakQuestion", {}, "en")).toBe("Where is the ground covered by buildings, roads or other artificial surfaces?");
    expect(t("about.heatQuestion", {}, "nl")).toBe("Welke buurten zijn het kwetsbaarst tijdens hittegolven?");
    expect(t("about.landsatQuestion", {}, "nl")).toBe("Hoe warm was de grond tijdens voorbije hittegolven?");
  });

  it("identifies official Statbel sectors and removes retired overview controls", () => {
    expect(t("controls.sectorSearch", {}, "en")).toBe("Search for a Statbel statistical sector");
    expect(t("controls.searchHelp", {}, "en")).toContain("official areas defined by Statbel");
    expect(t("controls.sectorSearch", {}, "nl")).toBe("Zoek een statistische sector van Statbel");
    expect(t("controls.searchHelp", {}, "nl")).toContain("officiële gebieden die Statbel afbakent");
    for (const language of ["en", "nl"]) {
      expect(TRANSLATIONS[language]).not.toHaveProperty("controls.reset");
      expect(TRANSLATIONS[language]).not.toHaveProperty("panel.minimise");
      expect(TRANSLATIONS[language]).not.toHaveProperty("panel.expand");
    }
  });

  it("keeps every base and comparison context concise and plain-language", () => {
    const contextKeys = [
      "layers.context.heatText", "layers.context.heatScoreText", "layers.context.vulnerabilityText",
      "layers.context.urbanAtlasText", "landsat.contextText", "jaarbak.contextText",
      "jaarbak.densityContext", "groenkaart.contextText", "groenkaart.densityContext",
      "landgebruik.contextText", "landgebruik.agricultureContext", "population.currentContextText",
      "population.modelContextText", "income.contextText", "scenario.contextText",
      "heatIncome.contextText", "heatPopulation.contextText", "comparison.contextText",
      "soilComparison.contextTextExact", "landsatGreen.contextText", "greenIncome.contextText",
      "landsatIncome.contextText", "greenPopulation.contextText", "landsatPopulation.contextText",
      "soilPopulation.contextText", "soilIncome.contextText",
    ];
    for (const language of ["en", "nl"]) {
      for (const key of contextKeys) {
        const copy = t(key, { year: 2024, count: 154, metric: "Combined" }, language);
        if (!["scenario.contextText", "groenkaart.contextText"].includes(key)) {
          expect(copy, `${language}:${key}`).toContain("?");
        }
        expect(copy.length, `${language}:${key}`).toBeLessThanOrEqual(key === "landsat.contextText" ? 340 : 260);
      }
    }
    expect(t("greenPopulation.contextText", {}, "en"))
      .toBe("How much vegetation is close to residents? The charts show vegetation cover within 100 m across the represented population.");
    expect(t("landsatPopulation.contextText", {}, "en"))
      .toBe("How many residents were in areas with higher daytime ground temperatures? The charts distribute the represented population across the observed temperature range.");
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
