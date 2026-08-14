/** Statbel fiscal-income indicators joined to the shared 2024 sector geometry. */
import { formatCurrency, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { defineLayer } from "./layer-contract.js";
import { authorityName, productLink } from "../source-authorities.js";

const LAYER_ID = "statbel-income-fill";
const YEARS = Object.freeze([2019, 2020, 2021, 2022, 2023]);

export function validateIncomeManifest(income) {
  if (!income || income.schemaVersion !== 1 || income.datasetId !== "statbel-income"
    || income.kind !== "sector-temporal" || income.defaultYear !== 2023
    || JSON.stringify(income.availableYears) !== JSON.stringify(YEARS)
    || !Array.isArray(income.bands) || income.bands.length !== 7) {
    throw new TypeError("Unsupported Statbel income manifest.");
  }
  YEARS.forEach((year) => {
    if (Object.keys(income.years?.[year]?.sectorStats ?? {}).length !== 154) {
      throw new TypeError(`Statbel income ${year} must contain 154 sector records.`);
    }
  });
  return income;
}

function bandLabel(band) {
  if (band.minimum === null) return t("income.bandUnder", { value: formatCurrency(20000) });
  if (band.maximum === null) return t("income.bandOver", { value: formatCurrency(band.minimum) });
  return t("income.bandRange", {
    minimum: formatCurrency(band.minimum),
    maximum: formatCurrency(Math.floor(band.maximum)),
  });
}

export function incomeColorExpression(income, year) {
  const stats = income.years[year].sectorStats;
  return [
    "match", ["get", "sectorId"],
    ...Object.entries(stats).flatMap(([sectorId, record]) => {
      const band = income.bands.find(({ id }) => id === record.renderClass);
      return [sectorId, band?.color ?? income.noDataColor];
    }),
    income.noDataColor,
  ];
}

export function createIncomeLayer({ income: input }) {
  const income = validateIncomeManifest(input);
  let activeYear = income.defaultYear;
  const statsFor = (record) => income.years[activeYear].sectorStats[record.sectorId];

  return defineLayer({
    id: "income",
    categoryId: "demography",
    supportsMunicipalitySummary: false,
    isAvailable: () => true,
    getLabel: () => t("layers.income"),
    getContext: () => ({
      meta: t("income.contextMeta", { year: activeYear }),
      text: t("income.contextText"),
      sources: [productLink("income", income.source.pageUrl)],
    }),
    getLegendModel: () => ({
      title: t("income.legendTitle"),
      note: t("income.legendNote", { year: activeYear }),
      footnote: t("income.legendFootnote"),
      layout: "groups",
      groups: [{
        items: [
          ...income.bands.map((band) => ({ label: bandLabel(band), color: band.color })),
          { label: t("income.noData"), color: income.noDataColor },
        ],
      }],
    }),
    getPopupModel: (feature, record) => {
      const stats = statsFor(record);
      return {
        title: feature.properties.sectorName,
        subtitle: t("income.referenceYear", { year: activeYear }),
        lines: [stats?.sourceStatus === "available"
          ? t("income.popupMedian", { value: formatCurrency(stats.medianNetTaxableIncome) })
          : t("income.noData")],
      };
    },
    getPanelModel: (record) => ({
      template: "income",
      record,
      income,
      year: activeYear,
      stats: statsFor(record),
    }),
    getTemporalControl: () => ({
      optionName: "year",
      values: YEARS,
      activeValue: activeYear,
      label: t("income.yearLabel"),
      previousLabel: t("income.previousYear"),
      nextLabel: t("income.nextYear"),
    }),
    mount(map, { sectorSourceId, beforeLayerId }) {
      if (map.getLayer(LAYER_ID)) return true;
      map.addLayer({
        id: LAYER_ID,
        type: "fill",
        source: sectorSourceId,
        layout: { visibility: "none" },
        paint: {
          "fill-color": incomeColorExpression(income, activeYear),
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.84, 0.72],
        },
      }, beforeLayerId);
      return true;
    },
    setVisible(map, visible) {
      if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, "visibility", visible ? "visible" : "none");
    },
    applyFilter(map, filter) {
      if (map.getLayer(LAYER_ID)) map.setFilter(LAYER_ID, filter);
    },
    setOption(map, name, value) {
      const year = Number(value);
      if (name !== "year" || !YEARS.includes(year)) return false;
      activeYear = year;
      if (map.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, "fill-color", incomeColorExpression(income, activeYear));
      return true;
    },
    getOption: (name) => name === "year" ? activeYear : null,
    getAttributions() {
      const url = safeExternalUrl(income.source.pageUrl);
      return url
        ? [`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(authorityName("statbel"))}</a>`]
        : [];
    },
  });
}
