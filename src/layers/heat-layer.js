/** Official Department of Care sector scores, displayed without recalculation. */
import {
  DEFAULT_HEAT_METRIC,
  HEAT_METRICS,
  heatMetricColorExpression,
  heatMetricStatus,
  heatMetricValue,
  normalizeHeatMetric,
} from "../heat-metric.js";
import { formatScore, t } from "../i18n.js";
import { defineLayer } from "./layer-contract.js";

const MAP_LAYER_ID = "heat-sectors-fill";

/** Create the official heat-vulnerability sector layer. */
export function createHeatLayer({ scores, methodology, initialMetric = DEFAULT_HEAT_METRIC }) {
  let activeMetric = normalizeHeatMetric(initialMetric);

  const metricLabel = () => t(`heatMetric.${activeMetric}`);

  return defineLayer({
    id: "heat",
    categoryId: "heat",
    isAvailable: () => true,
    getLabel: () => activeMetric === DEFAULT_HEAT_METRIC
      ? t("layers.heat")
      : t("layers.heatWithMetric", { metric: metricLabel() }),
    getDatasetStatus: ({ sectorCount }) => activeMetric === DEFAULT_HEAT_METRIC
      ? t("dataset.readyHeat", { count: sectorCount })
      : t("dataset.readyHeatMetric", {
        count: sectorCount,
        metric: t(`heatMetric.scoreName.${activeMetric}`),
      }),
    getContext: ({ sectorCount }) => {
      const keys = activeMetric === "heat"
        ? ["layers.context.heatScoreMeta", "layers.context.heatScoreText"]
        : activeMetric === "vulnerability"
          ? ["layers.context.vulnerabilityMeta", "layers.context.vulnerabilityText"]
          : ["layers.context.heatMeta", "layers.context.heatText"];
      return {
        meta: t(keys[0], { count: sectorCount }),
        text: t(keys[1], { count: sectorCount }),
      };
    },
    getLegendModel: () => ({
      title: t(activeMetric === "heat"
        ? "legend.heatTitle"
        : activeMetric === "vulnerability"
          ? "legend.vulnerabilityTitle"
          : "legend.title"),
      note: "0–10",
      layout: "scale",
      groups: [
        {
          items: Array.from({ length: 11 }, (_, score) => ({
            label: String(score),
            value: String(score),
            color: methodology.palette[`score-${score}`],
          })),
        },
        {
          items: [
            { label: t("legend.noData"), color: methodology.palette["no-data"] },
            { label: t("legend.institution"), color: methodology.palette["institution-present-no-score"] },
          ],
        },
      ],
    }),
    getPopupModel: (feature, record) => {
      const status = heatMetricStatus(record, activeMetric);
      const line = status === "scored"
        ? t("popup.metricScore", {
          metric: t(`heatMetric.${activeMetric}`),
          score: formatScore(heatMetricValue(record, activeMetric)),
        })
        : status === "institution-present-no-score"
          ? t("popup.institution")
          : t("popup.metricNoScore", { metric: t(`heatMetric.${activeMetric}`) });
      return {
        title: feature.properties.sectorName,
        subtitle: feature.properties.municipality,
        lines: [line],
      };
    },
    getPanelModel: (record, shared) => ({
      template: "heat",
      record,
      methodology,
      landCover: shared.landCover,
      urbanAtlas: shared.urbanAtlas,
      vegetation: shared.vegetation,
      heatMetric: activeMetric,
    }),
    mount(map, { sectorSourceId }) {
      if (map.getLayer(MAP_LAYER_ID)) return true;
      map.addLayer({
        id: MAP_LAYER_ID,
        type: "fill",
        source: sectorSourceId,
        paint: {
          "fill-color": heatMetricColorExpression(scores, activeMetric, methodology.palette),
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.82, 0.68],
        },
      });
      return true;
    },
    setVisible(map, visible) {
      if (map.getLayer(MAP_LAYER_ID)) map.setLayoutProperty(MAP_LAYER_ID, "visibility", visible ? "visible" : "none");
    },
    applyFilter(map, filter) {
      if (map.getLayer(MAP_LAYER_ID)) map.setFilter(MAP_LAYER_ID, filter);
    },
    getSecondaryControl: () => ({
      id: "heat-metric",
      ariaLabel: t("heatMetric.region"),
      options: HEAT_METRICS.map((metric) => ({
        id: metric,
        label: t(`heatMetric.${metric}`),
        active: metric === activeMetric,
      })),
    }),
    setOption(map, name, value) {
      if (name !== "metric" || !HEAT_METRICS.includes(value)) return false;
      activeMetric = value;
      if (map.getLayer(MAP_LAYER_ID)) {
        map.setPaintProperty(MAP_LAYER_ID, "fill-color", heatMetricColorExpression(scores, activeMetric, methodology.palette));
      }
      return true;
    },
    getOption: (name) => name === "metric" ? activeMetric : null,
  });
}
