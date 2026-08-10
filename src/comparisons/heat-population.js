/**
 * Descriptive comparison between the published 2026 heat scores and
 * Statbel's 2025 population totals. The population grid is deliberately not
 * used here because its cell positions are privacy-adjusted.
 */
import { formatNumber, t } from "../i18n.js";
import { heatMetricStatus, heatMetricValue } from "../heat-metric.js";
import { authorityLink } from "../source-authorities.js";

const POPULATION_YEAR = 2025;
const HEAT_SOURCE_URL = "https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen";
const SECTOR_SOURCE_ID = "heat-sectors";
const POPULATION_SYMBOL_LAYER_ID = "heat-population-symbols";
const ICON_PREFIX = "heat-population-level";

export function populationLevel(value) {
  if (!Number.isFinite(value) || value <= 0) return value === 0 ? 0 : null;
  if (value < 250) return 1;
  if (value < 500) return 2;
  if (value < 1_000) return 3;
  if (value < 2_000) return 4;
  return 5;
}

function populationDataset(population) {
  return population?.datasets?.["statbel-2025"] ?? null;
}

function populationRecords(population) {
  return populationDataset(population)?.sectorStats ?? {};
}

export function buildHeatPopulationPoints(scores, population, metric) {
  const records = populationRecords(population);
  return Object.values(scores).flatMap((record) => {
    const score = heatMetricValue(record, metric);
    const demographic = records[record.sectorId];
    const residents = demographic?.population;
    const level = populationLevel(residents);
    if (heatMetricStatus(record, metric) !== "scored"
      || !Number.isFinite(score)
      || demographic?.sourceStatus !== "available"
      || !Number.isFinite(residents)
      || !level) return [];
    return [{
      sectorId: record.sectorId,
      sectorName: record.sectorName,
      municipality: record.municipality,
      population: residents,
      level,
      score,
    }];
  }).sort((left, right) => left.level - right.level
    || left.population - right.population
    || left.sectorId.localeCompare(right.sectorId));
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

/** Tukey summaries treat every comparable statistical sector as one record. */
export function summarizeHeatByPopulationLevel(points) {
  return Array.from({ length: 5 }, (_, index) => {
    const level = index + 1;
    const values = points.filter((point) => point.level === level)
      .map((point) => point.score)
      .sort((a, b) => a - b);
    if (!values.length) return { level, count: 0 };
    const q1 = quantile(values, .25);
    const median = quantile(values, .5);
    const q3 = quantile(values, .75);
    const interquartileRange = q3 - q1;
    const lowerFence = q1 - 1.5 * interquartileRange;
    const upperFence = q3 + 1.5 * interquartileRange;
    return {
      level,
      count: values.length,
      q1,
      median,
      q3,
      whiskerLow: values.find((value) => value >= lowerFence) ?? values[0],
      whiskerHigh: values.findLast((value) => value <= upperFence) ?? values.at(-1),
    };
  });
}

/** Sum residents by score; unlike the box plot, this chart weights by population. */
export function sumPopulationByHeatScore(points) {
  const totalPopulation = points.reduce((sum, point) => sum + point.population, 0);
  return Array.from({ length: 11 }, (_, score) => {
    const matching = points.filter((point) => point.score === score);
    const population = matching.reduce((sum, point) => sum + point.population, 0);
    return {
      score,
      population,
      sectorCount: matching.length,
      populationShare: totalPopulation ? population / totalPopulation * 100 : 0,
    };
  });
}

function iconId(level) {
  return `${ICON_PREFIX}-${level}`;
}

function insidePerson(x, y, offset, expansion = 0) {
  const headX = offset + 3.5;
  const headY = 2.7;
  const head = Math.hypot(x - headX, y - headY) <= 1.75 + expansion;
  const torso = x >= offset + 2.15 - expansion && x <= offset + 4.85 + expansion
    && y >= 4.5 - expansion && y <= 8.2 + expansion;
  const arms = x >= offset + .75 - expansion && x <= offset + 6.25 + expansion
    && y >= 5.2 - expansion && y <= 6.7 + expansion;
  const leftLeg = x >= offset + 1.85 - expansion && x <= offset + 3.15 + expansion
    && y >= 7.7 - expansion && y <= 11.7 + expansion;
  const rightLeg = x >= offset + 3.85 - expansion && x <= offset + 5.15 + expansion
    && y >= 7.7 - expansion && y <= 11.7 + expansion;
  return head || torso || arms || leftLeg || rightLeg;
}

/** Create a deterministic, platform-independent strip of one to five people. */
export function createPopulationIcon(level, pixelRatio = 3) {
  const logicalWidth = level * 7 + 1;
  const logicalHeight = 13;
  const width = logicalWidth * pixelRatio;
  const height = logicalHeight * pixelRatio;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = (column + .5) / pixelRatio;
      const y = (row + .5) / pixelRatio;
      let outer = false;
      let inner = false;
      for (let person = 0; person < level; person += 1) {
        const offset = person * 7;
        outer ||= insidePerson(x, y, offset, .62);
        inner ||= insidePerson(x, y, offset, 0);
      }
      if (!outer) continue;
      const index = (row * width + column) * 4;
      const color = inner ? [255, 253, 247] : [23, 63, 72];
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
  return { width, height, data, pixelRatio };
}

function registerPopulationIcons(map) {
  for (let level = 1; level <= 5; level += 1) {
    const id = iconId(level);
    if (!map.hasImage(id)) {
      const image = createPopulationIcon(level);
      map.addImage(id, { width: image.width, height: image.height, data: image.data }, { pixelRatio: image.pixelRatio });
    }
  }
}

function populationIconExpression(population) {
  const entries = Object.entries(populationRecords(population)).flatMap(([sectorId, record]) => {
    const level = record?.sourceStatus === "available" ? populationLevel(record.population) : null;
    return level ? [sectorId, iconId(level)] : [];
  });
  return ["match", ["get", "sectorId"], ...entries, ""];
}

export function createHeatPopulationComparison({ scores, population, heatLayer, populationLayer }) {
  const dataset = populationDataset(population);
  let active = false;
  let map;
  let highlightedSectorId = "";
  let activeMunicipality = "";
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const metric = () => heatLayer.getOption("metric");
  const allPoints = () => buildHeatPopulationPoints(scores, population, metric());
  const points = () => allPoints().filter((point) => (
    !activeMunicipality || point.municipality === activeMunicipality
  ));
  const scopeRecords = () => Object.values(scores).filter((record) => (
    !activeMunicipality || record.municipality === activeMunicipality
  ));

  return {
    id: "heat-population",
    primaryLayerId: "heat",
    secondaryLayerId: "population",
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      try {
        registerPopulationIcons(map);
        if (!map.getLayer(POPULATION_SYMBOL_LAYER_ID)) {
          map.addLayer({
            id: POPULATION_SYMBOL_LAYER_ID,
            type: "symbol",
            source: SECTOR_SOURCE_ID,
            layout: {
              visibility: "none",
              "icon-image": populationIconExpression(population),
              "icon-size": ["interpolate", ["linear"], ["zoom"], 9, .72, 12, .9, 14, 1.08],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
            paint: { "icon-opacity": .96 },
          }, "heat-sectors-outline");
        }
        heatLayer.setVisible(map, true);
        populationLayer.setVisible(map, false);
        map.setFilter(POPULATION_SYMBOL_LAYER_ID, activeMunicipality
          ? ["==", ["get", "municipality"], activeMunicipality]
          : null);
        map.setLayoutProperty(POPULATION_SYMBOL_LAYER_ID, "visibility", "visible");
        active = true;
        map.triggerRepaint();
        notify();
        return true;
      } catch (error) {
        if (map.getLayer(POPULATION_SYMBOL_LAYER_ID)) map.setLayoutProperty(POPULATION_SYMBOL_LAYER_ID, "visibility", "none");
        heatLayer.setVisible(map, true);
        active = false;
        throw error;
      }
    },
    deactivate() {
      if (!map) return;
      active = false;
      highlightedSectorId = "";
      if (map.getLayer(POPULATION_SYMBOL_LAYER_ID)) map.setLayoutProperty(POPULATION_SYMBOL_LAYER_ID, "visibility", "none");
      populationLayer.setVisible(map, false);
      heatLayer.setVisible(map, true);
      map.triggerRepaint();
      notify();
    },
    setMunicipality(municipality = "") {
      activeMunicipality = municipality;
      if (map?.getLayer(POPULATION_SYMBOL_LAYER_ID)) {
        map.setFilter(POPULATION_SYMBOL_LAYER_ID, municipality
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
    getLabel: () => t("heatPopulation.title"),
    getActiveNote: () => t("heatPopulation.activeNote", { area: activeMunicipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("heatPopulation.contextMeta", { count: points().length }),
      text: t("heatPopulation.contextText", { metric: t(`heatMetric.${metric()}`) }),
      note: t("heatPopulation.contextNote", { area: activeMunicipality || t("controls.allMunicipalities") }),
      sources: [
        authorityLink("departmentCare", HEAT_SOURCE_URL),
        authorityLink("statbel", dataset.source.sectorDownloadUrl),
      ],
    }),
    getLegendModel() {
      const legend = heatLayer.getLegendModel();
      return {
        ...legend,
        comparisonLegend: {
          title: t("heatPopulation.legendSection"),
          items: Array.from({ length: 5 }, (_, index) => ({
            label: t(`heatPopulation.levelShort${index + 1}`),
            accessibleLabel: t(`heatPopulation.levelAccessible${index + 1}`),
            personCount: index + 1,
            color: "#fffdf7",
          })),
        },
        footnote: t("heatPopulation.legendFootnote"),
      };
    },
    getPopupModel(feature, record) {
      const demographic = populationRecords(population)[record.sectorId];
      const score = heatMetricValue(record, metric());
      const comparable = heatMetricStatus(record, metric()) === "scored" && Number.isFinite(score);
      return {
        title: feature.properties.sectorName,
        subtitle: t("heatPopulation.popupSubtitle"),
        lines: demographic?.sourceStatus === "available" ? [
          t("heatPopulation.popupPopulation", { value: formatNumber(demographic.population, 0) }),
          comparable
            ? t("heatPopulation.popupScore", { metric: t(`heatMetric.${metric()}`), score: formatNumber(score, 0) })
            : t("heatPopulation.noHeatValue"),
        ] : [t("heatPopulation.noPopulationValue")],
      };
    },
    getPanelModel(record) {
      const comparablePoints = points();
      const comparablePopulation = comparablePoints.reduce((sum, point) => sum + point.population, 0);
      const records = scopeRecords();
      const totalPopulation = records.reduce((sum, item) => {
        const value = populationRecords(population)[item.sectorId];
        return sum + (value?.sourceStatus === "available" && Number.isFinite(value.population) ? value.population : 0);
      }, 0);
      const scoreColors = Object.fromEntries(heatLayer.getLegendModel().groups[0].items
        .map((item) => [Number(item.value), item.color]));
      return {
        template: "heat-population-comparison",
        record: record?.scope ? record : {
          scope: activeMunicipality ? "municipality" : "region",
          municipality: activeMunicipality,
          sectorId: "",
          sectorName: activeMunicipality || t("controls.allMunicipalities"),
          sectorCount: records.length,
        },
        metric: metric(),
        populationYear: POPULATION_YEAR,
        points: comparablePoints,
        levelSummaries: summarizeHeatByPopulationLevel(comparablePoints),
        populationByScore: sumPopulationByHeatScore(comparablePoints),
        scoreColors,
        totalSectorCount: records.length,
        excludedCount: records.length - comparablePoints.length,
        comparablePopulation,
        totalPopulation,
        excludedPopulation: totalPopulation - comparablePopulation,
        highlightedSectorId,
      };
    },
  };
}
