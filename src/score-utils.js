import { formatScore, t } from "./i18n.js";
import { escapeHtml } from "./security.js";

export { formatScore };
export { escapeHtml };

export function scoreClass(value, status = "scored") {
  if (value === 9999 || status === "institution-present-no-score") return "institution-present-no-score";
  if (status !== "scored" || !Number.isFinite(value)) return "no-data";
  return `score-${Math.round(value)}`;
}

export function scoreColor(value, palette, status = "scored") {
  return palette[scoreClass(value, status)] ?? palette["no-data"] ?? "#EAE2DE";
}

export function interpretationFor(record, translate = t) {
  if (record.status === "institution-present-no-score") {
    return translate("interpretation.institution");
  }
  if (record.status !== "scored" || !Number.isFinite(record.scores.final)) {
    return translate("interpretation.insufficient");
  }
  const score = record.scores.final;
  if (score <= 2) return translate("interpretation.low");
  if (score <= 4) return translate("interpretation.ratherLow");
  if (score <= 6) return translate("interpretation.medium");
  if (score <= 8) return translate("interpretation.high");
  return translate("interpretation.veryHigh");
}

export function scorePercentage(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value * 10));
}
