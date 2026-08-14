import { formatNumber, t } from "../i18n.js";
import { escapeHtml } from "../score-utils.js";

export function renderMetricSummaryPanel(model) {
  const value = Number.isFinite(model.value) ? formatNumber(model.value) : t("value.notAvailable");
  const unit = model.unit ?? "%";
  const color = model.color ?? "#0b6e69";
  return `
    <div class="panel-hero land-cover-hero">
      <p class="panel-eyebrow">${escapeHtml(model.record.municipality)} · ${escapeHtml(model.record.sectorId)}</p>
      <h2 id="panel-title">${escapeHtml(model.record.sectorName)}</h2>
      <div class="score-hero" style="--hero-color:${escapeHtml(color)}">
        <div class="score-orb"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(unit)}</span></div>
        <div><span class="score-caption">${escapeHtml(model.title)}</span>${model.description ? `<p>${escapeHtml(model.description)}</p>` : ""}</div>
      </div>
    </div>
    ${model.notes?.length ? `<div class="panel-body methodology-copy">${model.notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</div>` : ""}`;
}
