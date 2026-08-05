import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEAT_METRIC,
  HEAT_METRICS,
  heatMetricColor,
  heatMetricColorExpression,
  heatMetricStatus,
  heatMetricValue,
  normalizeHeatMetric,
} from "../src/heat-metric.js";

const palette = {
  "no-data": "#EAE2DE",
  "score-6": "#B10064",
  "score-7": "#96004E",
  "score-8": "#7C003A",
  "institution-present-no-score": "#F1CE63",
};

const scored = {
  sectorId: "23003A001",
  status: "scored",
  scores: { final: 6, heat: 7, vulnerability: 8 },
};

describe("heat-vulnerability display metrics", () => {
  it("supports only the three stable metric identifiers", () => {
    expect(HEAT_METRICS).toEqual(["final", "heat", "vulnerability"]);
    expect(DEFAULT_HEAT_METRIC).toBe("final");
    expect(normalizeHeatMetric("heat")).toBe("heat");
    expect(normalizeHeatMetric("unknown")).toBe("final");
  });

  it("reads each published score and applies the exact shared palette", () => {
    expect(heatMetricValue(scored, "final")).toBe(6);
    expect(heatMetricValue(scored, "heat")).toBe(7);
    expect(heatMetricValue(scored, "vulnerability")).toBe(8);
    expect(heatMetricColor(scored, "final", palette)).toBe("#B10064");
    expect(heatMetricColor(scored, "heat", palette)).toBe("#96004E");
    expect(heatMetricColor(scored, "vulnerability", palette)).toBe("#7C003A");
  });

  it("normalizes null, out-of-range and institution values without inventing scores", () => {
    const missing = { ...scored, scores: { ...scored.scores, heat: null } };
    const outOfRange = { ...scored, scores: { ...scored.scores, heat: 11 } };
    const institution = { ...scored, scores: { ...scored.scores, heat: 9999 } };
    expect(heatMetricStatus(missing, "heat")).toBe("insufficient-data");
    expect(heatMetricStatus(outOfRange, "heat")).toBe("insufficient-data");
    expect(heatMetricStatus(institution, "heat")).toBe("institution-present-no-score");
    expect(heatMetricColor(missing, "heat", palette)).toBe("#EAE2DE");
    expect(heatMetricColor(outOfRange, "heat", palette)).toBe("#EAE2DE");
    expect(heatMetricColor(institution, "heat", palette)).toBe("#F1CE63");
  });

  it("builds a MapLibre match expression keyed by sector identifier", () => {
    const missing = {
      sectorId: "missing",
      status: "insufficient-data",
      scores: { final: null, heat: null, vulnerability: null },
    };
    expect(heatMetricColorExpression({ scored, missing }, "heat", palette)).toEqual([
      "match",
      ["get", "sectorId"],
      "23003A001",
      "#96004E",
      "missing",
      "#EAE2DE",
      "#EAE2DE",
    ]);
  });
});
