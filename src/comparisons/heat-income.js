/**
 * Descriptive comparison between the published 2026 heat scores and
 * Statbel's 2023 median taxable income. No regression or inferred values are
 * calculated here: the controller only joins existing sector records.
 */
import { formatCurrency, formatNumber, t } from "../i18n.js";
import { heatMetricStatus, heatMetricValue } from "../heat-metric.js";
import { productLink } from "../source-authorities.js";

const INCOME_YEAR = 2023;
const HEAT_SOURCE_URL = "https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen";
const SECTOR_SOURCE_ID = "heat-sectors";
const INCOME_SYMBOL_LAYER_ID = "heat-income-symbols";

export function incomeLevel(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 30_000) return { id: "low", symbol: "€" };
  if (value < 40_000) return { id: "middle", symbol: "€€" };
  return { id: "high", symbol: "€€€" };
}

function incomeRecords(income) {
  return income?.years?.[INCOME_YEAR]?.sectorStats ?? {};
}

function incomeSymbolExpression(income) {
  const entries = Object.entries(incomeRecords(income)).flatMap(([sectorId, record]) => {
    const level = record?.sourceStatus === "available" ? incomeLevel(record.medianNetTaxableIncome) : null;
    return level ? [sectorId, level.symbol] : [];
  });
  return ["match", ["get", "sectorId"], ...entries, ""];
}

export function buildHeatIncomePoints(scores, income, metric, year = INCOME_YEAR) {
  const incomeStats = income?.years?.[year]?.sectorStats ?? {};
  return Object.values(scores).flatMap((record) => {
    const score = heatMetricValue(record, metric);
    const fiscal = incomeStats[record.sectorId];
    if (heatMetricStatus(record, metric) !== "scored"
      || !Number.isFinite(score)
      || fiscal?.sourceStatus !== "available"
      || !Number.isFinite(fiscal.medianNetTaxableIncome)) return [];
    return [{
      sectorId: record.sectorId,
      sectorName: record.sectorName,
      municipality: record.municipality,
      income: fiscal.medianNetTaxableIncome,
      score,
    }];
  }).sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));
}

function quantile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const lowerValue = sortedValues[lower];
  const upperValue = sortedValues[lower + 1] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * fraction;
}

/**
 * Tukey summaries make the income distribution at each ordinal score visible
 * without fitting a continuous regression to the published 0–10 score classes.
 */
export function summarizeIncomeByScore(points) {
  return Array.from({ length: 11 }, (_, score) => {
    const values = points.filter((point) => point.score === score).map((point) => point.income).sort((a, b) => a - b);
    if (!values.length) return { score, count: 0 };
    const q1 = quantile(values, .25);
    const median = quantile(values, .5);
    const q3 = quantile(values, .75);
    const interquartileRange = q3 - q1;
    const lowerFence = q1 - 1.5 * interquartileRange;
    const upperFence = q3 + 1.5 * interquartileRange;
    return {
      score,
      count: values.length,
      q1,
      median,
      q3,
      whiskerLow: values.find((value) => value >= lowerFence) ?? values[0],
      whiskerHigh: values.findLast((value) => value <= upperFence) ?? values.at(-1),
    };
  });
}

export function createHeatIncomeComparison({ scores, income, heatLayer, incomeLayer }) {
  let active = false;
  let map;
  let highlightedSectorId = "";
  let activeMunicipality = "";
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const metric = () => heatLayer.getOption("metric");
  const allPoints = () => buildHeatIncomePoints(scores, income, metric(), INCOME_YEAR);
  const points = () => allPoints().filter((point) => (
    !activeMunicipality || point.municipality === activeMunicipality
  ));
  const scopeRecords = () => Object.values(scores).filter((record) => (
    !activeMunicipality || record.municipality === activeMunicipality
  ));

  return {
    id: "heat-income",
    primaryLayerId: "heat",
    secondaryLayerId: "income",
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      try {
        if (!map.getLayer(INCOME_SYMBOL_LAYER_ID)) {
          map.addLayer({
            id: INCOME_SYMBOL_LAYER_ID,
            type: "symbol",
            source: SECTOR_SOURCE_ID,
            layout: {
              visibility: "none",
              "text-field": incomeSymbolExpression(income),
              "text-size": ["interpolate", ["linear"], ["zoom"], 9, 9, 12, 12, 14, 14],
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              "text-letter-spacing": 0.02,
            },
            paint: {
              "text-color": "#173f48",
              "text-halo-color": "rgba(255,253,247,0.96)",
              "text-halo-width": 1.8,
              "text-halo-blur": 0.2,
            },
          }, "heat-sectors-outline");
        }
        heatLayer.setVisible(map, true);
        incomeLayer.setVisible(map, false);
        map.setFilter(INCOME_SYMBOL_LAYER_ID, activeMunicipality
          ? ["==", ["get", "municipality"], activeMunicipality]
          : null);
        map.setLayoutProperty(INCOME_SYMBOL_LAYER_ID, "visibility", "visible");
        active = true;
        map.triggerRepaint();
        notify();
        return true;
      } catch (error) {
        if (map.getLayer(INCOME_SYMBOL_LAYER_ID)) map.setLayoutProperty(INCOME_SYMBOL_LAYER_ID, "visibility", "none");
        heatLayer.setVisible(map, true);
        active = false;
        throw error;
      }
    },
    deactivate() {
      if (!map) return;
      active = false;
      highlightedSectorId = "";
      if (map.getLayer(INCOME_SYMBOL_LAYER_ID)) map.setLayoutProperty(INCOME_SYMBOL_LAYER_ID, "visibility", "none");
      incomeLayer.setVisible(map, false);
      heatLayer.setVisible(map, true);
      map.triggerRepaint();
      notify();
    },
    setMunicipality(municipality = "") {
      activeMunicipality = municipality;
      if (map?.getLayer(INCOME_SYMBOL_LAYER_ID)) {
        map.setFilter(INCOME_SYMBOL_LAYER_ID, municipality
          ? ["==", ["get", "municipality"], municipality]
          : null);
      }
      if (active) notify();
      return true;
    },
    refreshMetric() { if (active) notify(); },
    setHighlightedSector(sectorId = "") {
      if (highlightedSectorId === sectorId) return;
      highlightedSectorId = sectorId;
      if (active) notify();
    },
    getLabel: () => t("heatIncome.title"),
    getActiveNote: () => t("heatIncome.activeNote", { area: activeMunicipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("heatIncome.contextMeta", { count: points().length }),
      text: t("heatIncome.contextText", { metric: t(`heatMetric.${metric()}`) }),
      sources: [
        productLink("heat", HEAT_SOURCE_URL),
        productLink("income", income.source.pageUrl),
      ],
    }),
    getLegendModel() {
      const legend = heatLayer.getLegendModel();
      return {
        ...legend,
        comparisonLegend: {
          title: t("heatIncome.legendSection"),
          items: [
          { label: t("heatIncome.incomeLow"), symbol: "€", color: "#fffdf7" },
          { label: t("heatIncome.incomeMiddle"), symbol: "€€", color: "#fffdf7" },
          { label: t("heatIncome.incomeHigh"), symbol: "€€€", color: "#fffdf7" },
          { label: t("heatIncome.incomeUnavailable"), symbol: "–", color: "#eae2de" },
          ],
        },
        footnote: t("heatIncome.legendFootnote"),
      };
    },
    getPopupModel(feature, record) {
      const point = points().find(({ sectorId }) => sectorId === record.sectorId);
      return {
        title: feature.properties.sectorName,
        subtitle: t("heatIncome.popupSubtitle"),
        lines: point ? [
          t("heatIncome.popupIncome", { value: formatCurrency(point.income) }),
          t("heatIncome.popupScore", { metric: t(`heatMetric.${metric()}`), score: formatNumber(point.score, 0) }),
        ] : [t("heatIncome.noComparableValue")],
      };
    },
    getPanelModel(record) {
      const comparablePoints = points();
      const records = scopeRecords();
      return {
        template: "heat-income-comparison",
        record: record?.scope ? record : {
          scope: activeMunicipality ? "municipality" : "region",
          municipality: activeMunicipality,
          sectorId: "",
          sectorName: activeMunicipality || t("controls.allMunicipalities"),
          sectorCount: records.length,
        },
        metric: metric(),
        incomeYear: INCOME_YEAR,
        points: comparablePoints,
        scoreSummaries: summarizeIncomeByScore(comparablePoints),
        totalSectorCount: records.length,
        excludedCount: records.length - comparablePoints.length,
        highlightedSectorId,
      };
    },
  };
}
