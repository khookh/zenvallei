import { t } from "./i18n.js";
import { safeExternalUrl } from "./security.js";
import { authorityName } from "./source-authorities.js";

export const MAP_SOURCE_PRODUCTS = [
  { authorityId: "departmentCare", products: [
    ["sources.productHeat", "https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen"],
  ] },
  { authorityId: "departmentEnvironment", products: [
    ["sources.productJaarbak", "https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023"],
    ["sources.productLandUse", "https://www.vlaanderen.be/datavindplaats/catalogus/landgebruik-vlaanderen-toestand-2025"],
    ["sources.productPopulationModel", "https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019"],
  ] },
  { authorityId: "natureForests", products: [
    ["sources.productGreenMap", "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021"],
  ] },
  { authorityId: "copernicusClms", products: [
    ["sources.productUrbanAtlas", "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021"],
  ] },
  { authorityId: "landsat", products: [
    ["sources.productLandsat", "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature"],
  ] },
  { authorityId: "meteorologicalInstitute", products: [
    ["sources.productHeatwaves", "https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel"],
  ] },
  { authorityId: "statbel", products: [
    ["sources.productBoundaries", "https://statbel.fgov.be/en/open-data/statistical-sectors-2024"],
    ["sources.productIncome", "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector"],
    ["sources.productPopulationGrid", "https://statbel.fgov.be/en/themes/datalab/variable-cell-grid"],
    ["sources.productPopulationTotals", "https://statbel.fgov.be/en/open-data/population-place-residence-nationality-marital-status-age-and-sex-16"],
  ] },
];

function linksFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return [...template.content.querySelectorAll("a")].flatMap((anchor) => {
    const url = safeExternalUrl(anchor.getAttribute("href"));
    return url ? [{ label: anchor.textContent.trim(), url }] : [];
  });
}

function renderLinks(items) {
  const list = document.createElement("ul");
  items.forEach(({ label, url }) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = safeExternalUrl(url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    item.append(link);
    list.append(item);
  });
  return list;
}

/** One explicit product registry prevents comparisons from repeating their source datasets. */
export function createMapSourceDialog({ config }) {
  const dialog = document.createElement("dialog");
  dialog.className = "map-source-dialog";
  document.body.append(dialog);
  let button;

  const render = () => {
    const article = document.createElement("article");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = t("sources.title");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "map-source-dialog-close";
    close.setAttribute("aria-label", t("sources.close"));
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);

    const basemap = document.createElement("section");
    const basemapTitle = document.createElement("h3");
    basemapTitle.textContent = t("sources.basemap");
    const basemapCopy = document.createElement("p");
    basemapCopy.textContent = t("sources.basemapCopy");
    basemap.append(basemapTitle, basemapCopy, renderLinks(linksFromHtml(config.tileAttribution)));

    const data = document.createElement("section");
    const dataTitle = document.createElement("h3");
    dataTitle.textContent = t("sources.analytical");
    const dataCopy = document.createElement("p");
    dataCopy.textContent = t("sources.analyticalCopy");
    data.append(dataTitle, dataCopy);
    MAP_SOURCE_PRODUCTS.forEach(({ authorityId, products }) => {
      const group = document.createElement("div");
      group.className = "map-source-product-group";
      const heading = document.createElement("h4");
      heading.textContent = authorityName(authorityId);
      group.append(heading, renderLinks(products.map(([labelKey, url]) => ({ label: t(labelKey), url }))));
      data.append(group);
    });
    article.append(header, basemap, data);
    dialog.replaceChildren(article);
  };

  const control = {
    onAdd() {
      const container = document.createElement("div");
      container.className = "maplibregl-ctrl maplibregl-ctrl-group map-source-control-container";
      button = document.createElement("button");
      button.type = "button";
      button.className = "map-source-control";
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "i";
      button.append(glyph);
      button.addEventListener("click", () => {
        render();
        dialog.showModal();
        dialog.querySelector(".map-source-dialog-close")?.focus();
      });
      container.append(button);
      this.updateLanguage();
      return container;
    },
    onRemove() { button?.parentElement?.remove(); },
    updateLanguage() {
      if (!button) return;
      const label = t("sources.open");
      button.setAttribute("aria-label", label);
      button.title = label;
      if (dialog.open) render();
    },
  };
  dialog.addEventListener("close", () => button?.focus());
  return { control, updateLanguage: () => control.updateLanguage(), destroy: () => dialog.remove() };
}
