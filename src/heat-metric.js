import { scoreColor } from "./score-utils.js";

export const HEAT_METRICS = Object.freeze(["final", "heat", "vulnerability"]);
export const DEFAULT_HEAT_METRIC = "final";

export function normalizeHeatMetric(metric) {
  return HEAT_METRICS.includes(metric) ? metric : DEFAULT_HEAT_METRIC;
}

export function heatMetricValue(record, metric = DEFAULT_HEAT_METRIC) {
  return record?.scores?.[normalizeHeatMetric(metric)] ?? null;
}

export function heatMetricStatus(record, metric = DEFAULT_HEAT_METRIC) {
  const value = heatMetricValue(record, metric);
  if (value === 9999 || record?.status === "institution-present-no-score") {
    return "institution-present-no-score";
  }
  if (!Number.isFinite(value) || value < 0 || value > 10) return "insufficient-data";
  return "scored";
}

export function heatMetricColor(record, metric, palette) {
  const value = heatMetricValue(record, metric);
  return scoreColor(value, palette, heatMetricStatus(record, metric));
}

export function heatMetricColorExpression(scores, metric, palette) {
  const normalizedMetric = normalizeHeatMetric(metric);
  const matches = Object.values(scores).flatMap((record) => [
    record.sectorId,
    heatMetricColor(record, normalizedMetric, palette),
  ]);
  return ["match", ["get", "sectorId"], ...matches, palette["no-data"] ?? "#EAE2DE"];
}
