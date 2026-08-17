import { t } from "./i18n.js";

/**
 * Stable public names for the organisations behind the source data. Preparation
 * manifests retain exact upstream identifiers, while UI modules use these keys
 * so the same producer is never presented under several English names.
 */
export const SOURCE_AUTHORITIES = Object.freeze({
  governmentFlanders: { labelKey: "authority.governmentFlanders" },
  departmentCare: { labelKey: "authority.departmentCare" },
  departmentEnvironment: { labelKey: "authority.departmentEnvironment" },
  natureForests: { labelKey: "authority.natureForests" },
  digitalFlanders: { labelKey: "authority.digitalFlanders" },
  agricultureFisheries: { labelKey: "authority.agricultureFisheries" },
  statbel: { labelKey: "authority.statbel" },
  copernicusClms: { labelKey: "authority.copernicusClms" },
  landsat: { labelKey: "authority.landsat" },
  meteorologicalInstitute: { labelKey: "authority.meteorologicalInstitute" },
  greenwave: { labelKey: "authority.greenwave" },
});

/**
 * Analytical products are separate from their publishing organisations.  This
 * keeps two products from the same authority distinguishable in context and
 * source panels, and gives every product one canonical year and landing page.
 */
export const SOURCE_PRODUCTS = Object.freeze({
  heat: { authorityId: "departmentCare", labelKey: "sources.productHeat", url: "https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen" },
  jaarbak: { authorityId: "departmentEnvironment", labelKey: "sources.productJaarbak", url: "https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023" },
  landUse: { authorityId: "departmentEnvironment", labelKey: "sources.productLandUse", url: "https://www.vlaanderen.be/datavindplaats/catalogus/landgebruik-vlaanderen-toestand-2025" },
  agricultureParcels: { authorityId: "agricultureFisheries", labelKey: "sources.productAgricultureParcels", url: "https://www.vlaanderen.be/datavindplaats/catalogus/landbouwgebruikspercelen-lvgp", mapDialog: false },
  populationModel: { authorityId: "departmentEnvironment", labelKey: "sources.productPopulationModel", url: "https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019" },
  greenMap: { authorityId: "natureForests", labelKey: "sources.productGreenMap", url: "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021" },
  urbanAtlas: { authorityId: "copernicusClms", labelKey: "sources.productUrbanAtlas", url: "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021" },
  landsat: { authorityId: "landsat", labelKey: "sources.productLandsat", url: "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature" },
  heatwaves: { authorityId: "meteorologicalInstitute", labelKey: "sources.productHeatwaves", url: "https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel" },
  boundaries: { authorityId: "statbel", labelKey: "sources.productBoundaries", url: "https://statbel.fgov.be/en/open-data/statistical-sectors-2024" },
  income: { authorityId: "statbel", labelKey: "sources.productIncome", url: "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector" },
  populationGrid: { authorityId: "statbel", labelKey: "sources.productPopulationGrid", url: "https://statbel.fgov.be/en/themes/datalab/variable-cell-grid" },
  populationTotals: { authorityId: "statbel", labelKey: "sources.productPopulationTotals", url: "https://statbel.fgov.be/en/open-data/population-place-residence-nationality-marital-status-age-and-sex-16" },
  radoux: { authorityId: "governmentFlanders", labelKey: "sources.productRadoux", url: "https://doi.org/10.3390/rs17162815", mapDialog: false },
  xgboost: { authorityId: "greenwave", labelKey: "sources.productXgboost", url: "https://github.com/khookh/zenvallei/blob/main/playground/xgboost_2026_heatwave_regression_zennevallei.ipynb", mapDialog: false },
});

export function authorityName(authorityId) {
  const authority = SOURCE_AUTHORITIES[authorityId];
  if (!authority) throw new TypeError(`Unknown source authority '${authorityId}'.`);
  return t(authority.labelKey);
}

export function authorityLink(authorityId, url) {
  return { authorityId, label: authorityName(authorityId), url };
}

export function productLink(productId, url) {
  const product = SOURCE_PRODUCTS[productId];
  if (!product) throw new TypeError(`Unknown source product '${productId}'.`);
  return {
    productId,
    authorityId: product.authorityId,
    label: t(product.labelKey),
    url: url ?? product.url,
  };
}
