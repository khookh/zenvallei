
import { formatCurrency, formatDate, formatNumber, getLanguage, t } from "./i18n.js";
import {
  DEFAULT_HEAT_METRIC,
  HEAT_METRICS,
  heatMetricStatus,
  heatMetricValue,
  normalizeHeatMetric,
} from "./heat-metric.js";
import { escapeHtml, formatScore, interpretationFor, scoreColor, scorePercentage } from "./score-utils.js";
import { safeExternalUrl } from "./security.js";
import {
  compactEuroTick,
  heatIncomeLayout,
  heatPopulationBarLayout,
  heatPopulationBoxLayout,
  landsatHistogramLayout,
} from "./chart-layout.js";
import {
  dominantUrbanAtlasCategory,
  urbanAtlasCategoryBreakdown,
} from "./urban-atlas-categories.js";
import { SOURCE_PRODUCTS } from "./source-authorities.js";
import { renderAboutPanel } from "./panels/about-panel.js";
import { renderMetricSummaryPanel } from "./panels/metric-summary-panel.js";
import { scenarioDeltaHistogram } from "./panels/scenario-distribution.js";

const safeHref = (value) => escapeHtml(safeExternalUrl(value));

function isMunicipalitySummary(record) {
  return record.scope === "municipality";
}

function isRegionSummary(record) {
  return record.scope === "region";
}

function panelEyebrow(record) {
  if (isRegionSummary(record)) return t("panel.regionSummary", { count: record.sectorCount });
  if (isMunicipalitySummary(record)) {
    return t("panel.municipalitySummary", { count: record.sectorCount });
  }
  return `${record.municipality} · ${record.sectorId}`;
}

function panelAreaName(record) {
  if (isRegionSummary(record)) return t("controls.allMunicipalities");
  return record.sectorName ?? record.municipality;
}

function scopedStatistics(dataset, record) {
  if (isRegionSummary(record)) return dataset?.regionStats;
  if (isMunicipalitySummary(record)) return dataset?.municipalityStats?.[record.municipality];
  return dataset?.sectorStats?.[record.sectorId];
}

function scoreCard(labelKey, value, color) {
  return `
    <div class="summary-card score-summary-card">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong style="--score-color:${color}">${formatScore(value)}</strong>
      <small>${escapeHtml(t("score.outOf10"))}</small>
    </div>`;
}

function panelHeatMetricSelector(activeMetric) {
  return `
    <div class="panel-heat-metric-control" role="group" aria-label="${escapeHtml(t("heatMetric.region"))}">
      ${HEAT_METRICS.map((metric) => `
        <button
          class="panel-heat-metric-button ${metric === activeMetric ? "is-active" : ""}"
          type="button"
          data-panel-heat-metric="${metric}"
          data-focus-key="panel-heat-metric-${metric}"
          aria-pressed="${metric === activeMetric}"
        >${escapeHtml(t(`heatMetric.${metric}`))}</button>`).join("")}
    </div>`;
}

function metricCard(labelKey, value, color = "#0b6e69", className = "") {
  return `
    <div class="summary-card land-cover-metric ${escapeHtml(className)}">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong style="--score-color:${color}">${escapeHtml(value)}</strong>
    </div>`;
}

function indicatorRow(component, value, palette, status = "scored") {
  const color = scoreColor(value, palette, Number.isFinite(value) ? "scored" : status);
  const width = scorePercentage(value);
  const weight = component.weight
    ? `<span class="weight">${escapeHtml(t("panel.weight", { weight: formatScore(component.weight) }))}</span>`
    : "";
  return `
    <div class="indicator-row">
      <div class="indicator-label"><span>${escapeHtml(t(`component.${component.key}`))}</span>${weight}</div>
      <div class="indicator-value">
        <div class="score-track" aria-hidden="true"><span style="width:${width}%;--bar-color:${color}"></span></div>
        <strong>${formatScore(value)}</strong>
      </div>
    </div>`;
}

function componentGroupKey(component) {
  if (component.groupKey) return component.groupKey;
  return {
    Bevolking: "population",
    "Kwetsbare voorzieningen": "facilities",
    "Sociaal-economisch": "socioeconomic",
    Groen: "green",
  }[component.group] ?? component.group;
}

function sesDetails(record, methodology) {
  return `
    <details class="nested-details" data-section="ses">
      <summary data-focus-key="ses-summary">${escapeHtml(t("panel.sesDetails"))}</summary>
      <div class="nested-content">
        ${methodology.sesComponents.map((component) => indicatorRow(
          component,
          record.scores.sesComponents[component.key],
          methodology.palette,
          record.status,
        )).join("")}
      </div>
    </details>`;
}

function groupedComponents(record, methodology) {
  const groups = new Map();
  methodology.vulnerabilityComponents.forEach((component) => {
    const groupKey = componentGroupKey(component);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(component);
  });
  return [...groups.entries()].map(([groupKey, components]) => `
    <section class="indicator-group">
      <h4>${escapeHtml(t(`group.${groupKey}`))}</h4>
      ${components.map((component) => indicatorRow(
        component,

        record.scores.components[component.key],
        methodology.palette,
        record.status,
      )).join("")}
      ${groupKey === "socioeconomic" ? sesDetails(record, methodology) : ""}
    </section>`).join("");
}

const metricPresentation = Object.freeze({
  final: { labelKey: "panel.final", definitionKey: "panel.finalDefinition" },
  heat: { labelKey: "panel.heat", definitionKey: "panel.heatDefinition" },
  vulnerability: { labelKey: "panel.vulnerability", definitionKey: "panel.vulnerabilityDefinition" },
});

function statusLabel(record, metric) {
  const status = heatMetricStatus(record, metric);
  if (status === "scored") {
    const score = formatScore(heatMetricValue(record, metric));
    return metric === DEFAULT_HEAT_METRIC
      ? t("score.final", { score })
      : t("score.metric", { metric: t(metricPresentation[metric].labelKey), score });
  }
  if (status === "institution-present-no-score") return t("score.institutionPresent");
  return t("score.insufficient");
}

function heatMetricInterpretation(record, metric) {
  const status = heatMetricStatus(record, metric);
  if (status === "institution-present-no-score") return t("interpretation.institution");
  if (status !== "scored") return t("interpretation.insufficient");
  if (metric === "heat") return t("interpretation.heatSelected");
  if (metric === "vulnerability") return t("interpretation.vulnerabilitySelected");
  return interpretationFor(record);
}

function renderHeatRecord(record, methodology, urbanAtlas, heatMetric = DEFAULT_HEAT_METRIC) {
  const selectedMetric = normalizeHeatMetric(heatMetric);
  const selectedValue = heatMetricValue(record, selectedMetric);
  const selectedStatus = heatMetricStatus(record, selectedMetric);
  const selectedColor = scoreColor(selectedValue, methodology.palette, selectedStatus);
  const isScored = selectedStatus === "scored";
  const relatedMetrics = HEAT_METRICS.filter((metric) => metric !== selectedMetric);
  return `
    ${panelHeatMetricSelector(selectedMetric)}
    <div class="panel-hero">
      <p class="panel-eyebrow">${escapeHtml(record.municipality)} · ${escapeHtml(record.sectorId)}</p>
      <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
      <div class="score-hero ${isScored ? "" : "score-hero--status"}" style="--hero-color:${selectedColor}">
        <div class="score-orb"><strong>${formatScore(isScored ? selectedValue : null)}</strong>${isScored ? "<span>/ 10</span>" : ""}</div>
        <div><span class="score-caption">${escapeHtml(statusLabel(record, selectedMetric))}</span><p>${escapeHtml(heatMetricInterpretation(record, selectedMetric))}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">↗</span> ${escapeHtml(t("score.relativeNote"))}</p>
    </div>
    <div class="panel-body">
      <section aria-labelledby="synthesis-title">
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.buildKicker"))}</p><h3 id="synthesis-title">${escapeHtml(t("panel.relatedScoresTitle"))}</h3></div>
        <div class="summary-grid">
          ${relatedMetrics.map((metric) => {
            const presentation = metricPresentation[metric];
            const value = heatMetricValue(record, metric);
            const status = heatMetricStatus(record, metric);
            return scoreCard(
              presentation.labelKey,
              value,
              scoreColor(value, methodology.palette, status),
            );
          }).join("")}
        </div>
      </section>
      <details class="detail-accordion" data-section="indicators">
        <summary data-focus-key="indicators-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("panel.detailsTitle"))}</span></summary>
        <div class="accordion-content">
          <div class="methodology-copy related-score-definitions">
            ${relatedMetrics.map((metric) => `<p><strong>${escapeHtml(t(metricPresentation[metric].labelKey))}:</strong> ${escapeHtml(t(metricPresentation[metric].definitionKey))}</p>`).join("")}
          </div>
          ${groupedComponents(record, methodology)}
        </div>
      </details>
      <details class="detail-accordion methodology-accordion" data-section="methodology">
        <summary data-focus-key="methodology-summary"><span>${escapeHtml(t("panel.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("panel.methodologyText"))}</p>
          <p>${escapeHtml(t("panel.heatSourceNote"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("panel.warningText"))}</p>
        </div>
      </details>
    </div>`;
}

function urbanAtlasDefinition(urbanAtlas, code) {
  return urbanAtlas?.classes?.find((entry) => String(entry.code) === String(code));
}

function urbanAtlasClassLabel(urbanAtlas, code) {
  const definition = urbanAtlasDefinition(urbanAtlas, code);
  return definition ? t(`urbanAtlas.class.${definition.code}`) : String(code);
}

function urbanAtlasRow(entry, urbanAtlas, {
  showMetricPercentage = true,
  percentageKey = "urbanAtlas.sectorShare",
} = {}) {
  const definition = urbanAtlasDefinition(urbanAtlas, entry.code);
  if (!definition) return "";
  return `
    <div class="land-cover-row urban-atlas-row">
      <span class="land-cover-swatch" style="--swatch:${escapeHtml(definition.color)}" aria-hidden="true"></span>
      <span>${escapeHtml(urbanAtlasClassLabel(urbanAtlas, entry.code))}</span>
      <strong>

        ${escapeHtml(t("unit.hectares", { value: formatNumber(entry.areaHa) }))}
        <small>${escapeHtml(t(percentageKey, { value: formatNumber(entry.sectorPercentage) }))}${showMetricPercentage ? ` · ${escapeHtml(t("urbanAtlas.metricShare", { value: formatNumber(entry.metricPercentage) }))}` : ""}</small>
      </strong>
    </div>`;
}

function urbanAtlasCategoryLabel(category) {
  return t(`urbanAtlas.category.${category.id}`);
}

function urbanAtlasCategoryItems(stats) {
  return urbanAtlasCategoryBreakdown(stats).map((category) => ({
    ...category,
    label: urbanAtlasCategoryLabel(category),
  }));
}

function urbanAtlasCategoryDetails(stats, urbanAtlas) {
  return urbanAtlasCategoryItems(stats).map((category) => {
    const classes = category.classes.filter(({ areaHa }) => areaHa > 0);
    return `<section class="urban-atlas-breakdown-group">
      <h4>${escapeHtml(category.label)}</h4>
      ${classes.length
        ? classes.map((entry) => urbanAtlasRow({
          ...entry,
          sectorPercentage: stats.validAreaHa > 0 ? entry.areaHa / stats.validAreaHa * 100 : 0,
        }, urbanAtlas, { showMetricPercentage: false, percentageKey: "urbanAtlas.validShare" })).join("")
        : `<p class="urban-atlas-empty-group">${escapeHtml(t("urbanAtlas.categoryEmpty"))}</p>`}
    </section>`;
  }).join("");
}

function renderUrbanAtlasRecord(record, urbanAtlas) {
  const stats = scopedStatistics(urbanAtlas, record);
  const categories = urbanAtlasCategoryItems(stats);
  const dominant = dominantUrbanAtlasCategory(stats);
  const dominantLabel = dominant ? urbanAtlasCategoryLabel(dominant) : t("urbanAtlas.noData");
  const dominantColor = dominant?.color ?? "#b4b4b4";
  const validationKey = urbanAtlas?.source?.validationStatus === "not-yet-validated"
    ? "urbanAtlas.validationNotYet"
    : "urbanAtlas.validationUnknown";
  return `
    <div class="panel-hero land-cover-hero urban-atlas-hero">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
      <div class="score-hero" style="--hero-color:${dominantColor}">
        <div class="land-cover-orb" style="--class-color:${dominantColor}" aria-hidden="true"></div>
        <div><span class="score-caption">${escapeHtml(t("urbanAtlas.largestCategory"))}</span><p class="land-cover-dominant">${escapeHtml(dominantLabel)}${dominant ? ` · ${escapeHtml(t("unit.percentage", { value: formatNumber(dominant.percentage) }))}` : ""}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("urbanAtlas.eyebrow", { year: urbanAtlas.activeYear }))}</p>
    </div>
    <div class="panel-body">
      ${stats ? `
        <section aria-labelledby="urban-atlas-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("urbanAtlas.eyebrow", { year: urbanAtlas.activeYear }))}</p><h3 id="urban-atlas-summary-title">${escapeHtml(t("urbanAtlas.summaryTitle"))}</h3></div>
          ${localComposition(categories, t("urbanAtlas.summaryTitle"))}
          <div class="local-breakdown-list urban-atlas-category-summary">${categories.map(localClassRow).join("")}</div>
        </section>
        <details class="detail-accordion" data-section="urban-atlas-details">
          <summary data-focus-key="urban-atlas-details-summary"><span>${escapeHtml(t("urbanAtlas.detailsTitle"))}</span></summary>
          <div class="accordion-content">${urbanAtlasCategoryDetails(stats, urbanAtlas)}<p class="urban-atlas-valid-area">${escapeHtml(t("urbanAtlas.validArea", { area: formatNumber(stats.validAreaHa) }))}</p></div>
        </details>` : `<p class="panel-empty-state">${escapeHtml(t("urbanAtlas.noData"))}</p>`}
      <details class="detail-accordion methodology-accordion" data-section="urban-atlas-methodology">
        <summary data-focus-key="urban-atlas-methodology-summary"><span>${escapeHtml(t("urbanAtlas.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("urbanAtlas.productionText"))}</p>
          <p>${escapeHtml(t("urbanAtlas.methodologyText"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.comparisonWarning"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.accessWarning"))}</p>
          <p>${escapeHtml(t("urbanAtlas.classificationWarning"))}</p>
          <p>${escapeHtml(t(validationKey, { date: formatDate(urbanAtlas?.source?.validationStatusCheckedAt) }))}</p>
          ${urbanAtlas?.source?.accessedAt ? `<p>${escapeHtml(t("source.accessed", { date: formatDate(urbanAtlas.source.accessedAt) }))}</p>` : ""}
          ${urbanAtlas?.generatedAt ? `<p>${escapeHtml(t("source.processed", { date: formatDate(urbanAtlas.generatedAt) }))}</p>` : ""}
        </div>
      </details>
    </div>`;
}

function translatedNotebookValue(value, fallback = "") {
  if (typeof value === "string") return value;
  return value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;
}

function renderNotebookTestRecord(model) {
  const { record, manifest, stats } = model;
  const title = translatedNotebookValue(manifest.title, t("layers.notebookTest"));
  const description = translatedNotebookValue(manifest.description);
  const areaCards = stats ? `
    <div class="summary-grid notebook-test-area-grid">
      ${metricCard("notebookTest.validArea", `${formatNumber(stats.validAreaHa)} ha`)}
      ${metricCard("notebookTest.sectorArea", `${formatNumber(stats.sectorAreaHa)} ha`)}
    </div>` : "";
  const continuous = stats && manifest.kind === "continuous" ? `
    <div class="summary-grid notebook-test-stat-grid">
      ${metricCard("notebookTest.median", `${formatNumber(stats.median, 4)} ${escapeHtml(manifest.units ?? "")}`.trim())}
      ${metricCard("notebookTest.mean", `${formatNumber(stats.mean, 4)} ${escapeHtml(manifest.units ?? "")}`.trim())}
      ${metricCard("notebookTest.minimum", formatNumber(stats.minimum, 4))}
      ${metricCard("notebookTest.maximum", formatNumber(stats.maximum, 4))}
    </div>` : "";
  const categorical = stats && manifest.kind === "categorical" ? `
    <section class="notebook-test-classes">
      <h3>${escapeHtml(t("notebookTest.classBreakdown"))}</h3>
      ${(stats.classes ?? []).map((entry) => {
        const definition = manifest.legend.items.find((item) => String(item.value) === String(entry.value));
        return `
          <div class="class-row">
            <span class="class-swatch" style="--swatch:${escapeHtml(definition?.color ?? "#777")}"></span>
            <span>${escapeHtml(translatedNotebookValue(definition?.label, String(entry.value)))}</span>
            <strong>${escapeHtml(`${formatNumber(entry.areaHa)} ha · ${formatNumber(entry.percentage)}%`)}</strong>
          </div>`;
      }).join("")}
    </section>` : "";
  return `
    <article class="panel-article notebook-test-panel">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      <p class="panel-intro"><strong>${escapeHtml(title)}</strong></p>

      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      <p class="notebook-test-note">${escapeHtml(t("notebookTest.localOnly"))}</p>
      ${stats ? `${areaCards}${continuous}${categorical}` : `<p>${escapeHtml(t("notebookTest.noData"))}</p>`}
    </article>`;
}

function localAreaValue(areaHa, percentage) {
  return `${t("unit.percentage", { value: formatNumber(percentage) })} · ${t("unit.hectares", { value: formatNumber(areaHa) })}`;
}

function localSource(manifest) {
  if (!manifest?.source?.url) return "";
  return `<p><a href="${safeHref(manifest.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("officialData.source"))}: ${escapeHtml(manifest.source.name ?? manifest.datasetId)}</a></p>`;
}

function localComposition(items, label) {
  const ariaLabel = items.map((item) => `${item.label} ${formatNumber(item.percentage)}%`).join(", ");
  return `
    <div class="local-composition" role="img" aria-label="${escapeHtml(`${label}: ${ariaLabel}`)}">
      ${items.filter((item) => item.percentage > 0).map((item) => `
        <span style="width:${Math.max(0, item.percentage)}%;--segment:${escapeHtml(item.color)}"></span>`).join("")}
    </div>`;
}

function localClassRow({ label, definition = "", color, areaHa, percentage, secondary = "" }) {
  return `
    <div class="local-breakdown-row">
      <span class="local-breakdown-swatch" style="--swatch:${escapeHtml(color)}" aria-hidden="true"></span>
      <div class="local-breakdown-label"><strong>${escapeHtml(label)}</strong>${definition ? `<span>${escapeHtml(definition)}</span>` : ""}</div>
      <div class="local-breakdown-value"><strong>${escapeHtml(t("unit.percentage", { value: formatNumber(percentage) }))}</strong><span>${escapeHtml(t("unit.hectares", { value: formatNumber(areaHa) }))}</span>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ""}</div>
    </div>`;
}

function localHero(record, subtitle, heroContent, note) {
  return `
    <div class="panel-hero land-cover-hero local-layer-hero">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
      <p class="panel-subtitle">${escapeHtml(subtitle)}</p>
      ${heroContent}
      <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(note)}</p>
    </div>`;
}

function renderJaarbakSummary(stats, record, year) {
  const composition = [
    { label: t("jaarbak.sealed"), areaHa: stats.sealedAreaHa, percentage: stats.sealedPercentage, color: "#e8292f" },
    { label: t("jaarbak.unsealed"), areaHa: stats.unsealedAreaHa, percentage: stats.unsealedPercentage, color: "#8ecf7c" },
  ];
  return `
    ${localHero(record, t("layers.jaarbak", { year }), `
      <div class="score-hero" style="--hero-color:#e8292f">
        <div class="score-orb"><strong>${escapeHtml(formatNumber(stats.sealedPercentage))}</strong><span>%</span></div>
        <div><span class="score-caption">${escapeHtml(t("jaarbak.sealed"))}</span><p>${escapeHtml(t("unit.hectares", { value: formatNumber(stats.sealedAreaHa) }))}</p></div>
      </div>`, t("jaarbak.contextMeta", { year }))}
    <div class="panel-body local-layer-body">
      <section aria-labelledby="jaarbak-summary-title">
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.jaarbak", { year }))}</p><h3 id="jaarbak-summary-title">${escapeHtml(t("jaarbak.summaryTitle"))}</h3></div>
        ${localComposition(composition, t("jaarbak.summaryTitle"))}
        <div class="local-breakdown-list">
          ${composition.map(localClassRow).join("")}
        </div>
        ${year >= 2023 ? `<p class="local-method-warning"><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("jaarbak.methodChangeNote"))}</p>` : ""}
      </section>`;
}

function renderGroenkaartSummary(stats, manifest, record, year) {
  const definitions = new Map((manifest.classesOrScale?.items ?? []).map((item) => [String(item.value), item]));
  const byCode = new Map((stats.classes ?? []).map((item) => [String(item.code), item]));
  const keyByCode = { 1: "highGreen", 2: "lowGreen", 3: "agriculture", 4: "nonGreen" };
  const composition = [1, 2, 3, 4].map((code) => {
    const item = byCode.get(String(code)) ?? { areaHa: 0, percentage: 0 };
    const key = keyByCode[code];
    return {
      label: t(`groenkaart.${key}`),
      definition: t(`groenkaart.${key}Definition`),
      color: definitions.get(String(code))?.color ?? "#657575",
      areaHa: item.areaHa,
      percentage: item.percentage,
    };
  });
  const dominant = [...composition].sort((a, b) => b.areaHa - a.areaHa)[0];
  return `
    ${localHero(record, t("layers.groenkaart", { year }), `
      <div class="score-hero">
        <div class="land-cover-orb" style="--class-color:${escapeHtml(dominant.color)}" aria-hidden="true"></div>
        <div><span class="score-caption">${escapeHtml(t("groenkaart.dominant"))}</span><p class="land-cover-dominant">${escapeHtml(dominant.label)} · ${escapeHtml(t("unit.percentage", { value: formatNumber(dominant.percentage) }))}</p></div>
      </div>`, t("groenkaart.contextMeta", { year }))}
    <div class="panel-body local-layer-body">
      <section aria-labelledby="groenkaart-summary-title">
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.groenkaart", { year }))}</p><h3 id="groenkaart-summary-title">${escapeHtml(t("groenkaart.summaryTitle"))}</h3></div>
        ${localComposition(composition, t("groenkaart.summaryTitle"))}
        <h4 class="local-breakdown-title">${escapeHtml(t("groenkaart.classBreakdown"))}</h4>
        <div class="local-breakdown-list">${composition.map(localClassRow).join("")}</div>
      </section>`;
}

function renderLocalOfficialRaster(model) {
  const { datasetId, manifest, record, stats, year } = model;
  const methodKey = { jaarbak: "jaarbak.methodology", groenkaart: "groenkaart.methodology" }[datasetId];
  const body = !stats
    ? `<div class="panel-hero local-layer-hero"><p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p><h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2></div><div class="panel-body"><p class="panel-empty-state">${escapeHtml(t("officialData.noData"))}</p>`
    : datasetId === "jaarbak"
      ? renderJaarbakSummary(stats, record, year)
      : renderGroenkaartSummary(stats, manifest, record, year);
  return `
    <article class="panel-article local-official-panel">
      ${body}
      ${stats ? `<details class="detail-accordion" data-section="local-raster-details">
        <summary data-focus-key="local-raster-details-summary"><span>${escapeHtml(t("panel.detailsKicker"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <h4>${escapeHtml(t("officialData.coverageTitle"))}</h4>
          <p>${escapeHtml(t("officialData.coverageTitle"))}: ${escapeHtml(localAreaValue(stats.validAreaHa, stats.validPercentage))}. ${escapeHtml(t(datasetId === "jaarbak" ? "jaarbak.noData" : "groenkaart.noData"))}: ${escapeHtml(localAreaValue(stats.noDataAreaHa, stats.noDataPercentage))}.</p>
        </div>
      </details>` : ""}
      <details class="detail-accordion methodology-accordion" data-section="local-raster-methodology">
        <summary data-focus-key="local-raster-methodology-summary"><span>${escapeHtml(t("officialData.methodology"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t(datasetId === "jaarbak" ? "jaarbak.definition" : "groenkaart.contextText"))}</p>
          <p>${escapeHtml(t(methodKey))}</p>
          <p>${escapeHtml(t(datasetId === "jaarbak" ? "jaarbak.derivedNote" : "groenkaart.derivedNote"))}</p>
          ${manifest.years?.[year]?.status === "provisional" ? `<p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("officialData.provisionalYear"))}</p>` : ""}
          ${manifest.density ? `
            <p>${escapeHtml(t("density.methodology"))}</p>
            <p>${escapeHtml(t("density.radiusEvidence"))}</p>
            <ul class="source-list">

              <li><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC6462107/" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referencePnas"))}</a></li>
              <li><a href="https://doi.org/10.1016/j.buildenv.2023.111029" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referenceBuildingEnvironment"))}</a></li>
              <li><a href="https://www.sciensano.be/sites/default/files/beele_et_al_2024_lurp_spatial_config_green_space_1.pdf" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referenceLeuven"))}</a></li>
            </ul>` : ""}
          ${year >= 2023 && datasetId === "jaarbak" ? `<p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("jaarbak.methodChangeNote"))}</p>` : ""}
          ${stats ? `<p>${escapeHtml(t("officialData.completeArea"))} ${escapeHtml(t("officialData.visualDerivative"))}</p>` : ""}
          ${localSource(manifest)}
        </div>
      </details>
    </div></article>`;
}

function landsatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(getLanguage() === "nl" ? "nl-BE" : "en-GB", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Brussels", timeZoneName: "short",
  }).format(new Date(value));
}

function temperaturePosition(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, (value - 15) / 35 * 100));
}

function landsatDistribution(stats) {
  const values = [
    ["p10", stats.p10C], ["median", stats.medianC], ["p90", stats.p90C],
  ];
  return `
    <div class="landsat-distribution" role="img" aria-label="${escapeHtml(t("landsat.distributionAccessible", {
      p10: formatNumber(stats.p10C, 1), median: formatNumber(stats.medianC, 1), p90: formatNumber(stats.p90C, 1),
    }))}">
      <div class="landsat-temperature-ramp" aria-hidden="true">
        ${values.map(([key, value]) => `<i class="landsat-temperature-marker is-${key}" style="--position:${temperaturePosition(value)}%"></i>`).join("")}
      </div>
      <div class="landsat-distribution-values" aria-hidden="true">
        ${values.map(([key, value]) => `<span class="is-${key}"><b>${escapeHtml(t(`landsat.${key}`))}</b><strong>${escapeHtml(formatNumber(value, 1))} °C</strong></span>`).join("")}
      </div>
    </div>`;
}

function comparisonStepPath(percentages, maximum, layout) {
  const { left, top, width, height } = layout.plot;
  if (!percentages.length) return "";
  let path = `M ${left} ${top + height}`;
  percentages.forEach((value, index) => {
    const x0 = left + index / percentages.length * width;
    const x1 = left + (index + 1) / percentages.length * width;
    const y = top + height - Math.min(maximum, value) / maximum * height;
    path += ` H ${x0.toFixed(2)} V ${y.toFixed(2)} H ${x1.toFixed(2)}`;
  });
  return `${path} V ${top + height}`;
}

const LANDSAT_PIXEL_AREA_HA = 30 * 30 / 10_000;

export function representedLandsatAreaHa(pixelCount) {
  return Number.isFinite(pixelCount) ? pixelCount * LANDSAT_PIXEL_AREA_HA : 0;
}

function comparisonChartContext(model) {
  const heatwave = model.landsatManifest?.heatwaves?.find(({ id }) => model.observation?.heatwaveIds?.includes(id));
  const period = heatwave
    ? t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) })
    : t("landsat.kindHeatwave");
  const soil = model.template === "landsat-jaarbak-comparison";
  return {
    title: t(soil ? "comparison.expandedSoilTitle" : "comparison.expandedUrbanTitle"),
    description: t(soil ? "comparison.expandedSoilDescription" : "comparison.expandedUrbanDescription", {
      area: panelAreaName(model.record),
      observed: landsatDateTime(model.observation?.acquiredAt),
      period,
      surfaces: model.selectedSeries.map(({ label }) => label).join(", "),
      year: model.secondaryYear ?? 2021,
    }),
  };
}

function comparisonHistogram(model, { expanded = false, showExpand = true } = {}) {
  const exactArea = (stats) => Array.isArray(stats?.binAreaM2);
  const distributionValues = (stats) => exactArea(stats) ? stats.binAreaM2 : stats?.binCounts ?? [];
  const distributionTotal = (stats) => exactArea(stats)
    ? Number(stats.clearObservedAreaHa ?? 0) * 10_000 : Number(stats?.clearPixelCount ?? 0);
  const available = model.selectedSeries.filter((series) => distributionTotal(series.stats) >= (exactArea(series.stats) ? 1_000 : 10));
  if (!model.selectedSeries.length) return `<p class="panel-empty-state">${escapeHtml(t("comparison.noSelectedSeries"))}</p>`;
  const percentages = available.map((series) => distributionValues(series.stats).map((count) => (
    distributionTotal(series.stats) ? count / distributionTotal(series.stats) * 100 : 0
  )));
  const maximum = Math.max(1, Math.ceil(Math.max(0, ...percentages.flat()) / 5) * 5);
  const dashes = ["none", "10 5", "3 4", "12 4 3 4"];
  const edges = model.manifest.binEdges;
  const labels = edges.slice(0, -1).map((minimum, index) => t("comparison.binLabel", {
    minimum: formatNumber(minimum, 1),
    maximum: formatNumber(edges[index + 1], 1),
    values: model.selectedSeries.map((series) => t("comparison.binValue", {
      series: series.label,
      percentage: formatNumber(distributionTotal(series.stats)
        ? Number(distributionValues(series.stats)[index] ?? 0) / distributionTotal(series.stats) * 100 : 0, 1),
    })).join(", "),
  }));
  const prefix = expanded ? "comparison-chart-expanded" : "comparison-chart-inline";
  const layout = landsatHistogramLayout();
  const { plot } = layout;
  const yTicks = [0, .25, .5, .75, 1].map((fraction) => ({
    y: plot.top + plot.height - fraction * plot.height,
    label: `${formatNumber(maximum * fraction, maximum < 10 ? 1 : 0)}%`,
  }));
  const xTicks = Array.from({ length: 8 }, (_, index) => 15 + index * 5);
  const chartContext = comparisonChartContext(model);
  const chips = model.selectedSeries.map((series) => `<span class="comparison-series-chip" style="--series:${escapeHtml(series.color)}">
    <i aria-hidden="true"></i><b>${escapeHtml(series.label)}</b><span>${exactArea(series.stats)
      ? `${escapeHtml(formatNumber(series.stats?.clearObservedAreaHa ?? 0, 2))} ha &middot; ${escapeHtml(formatNumber(series.stats?.contributingLandsatCount ?? 0, 0))} ${escapeHtml(t("comparison.landsatObservations"))}`
      : `${escapeHtml(t("comparison.clearPixels"))}: ${escapeHtml(formatNumber(series.stats?.clearPixelCount ?? 0, 0))}${expanded ? ` &middot; ${escapeHtml(t("comparison.representedArea", { value: formatNumber(representedLandsatAreaHa(series.stats?.clearPixelCount ?? 0), 1) }))}` : ""}`}</span>
  </span>`).join("");
  const tails = expanded ? `<div class="comparison-chart-tails">
    ${model.selectedSeries.map((series) => `<p><strong>${escapeHtml(series.label)}</strong> ${escapeHtml(t(exactArea(series.stats) ? "comparison.outsideScaleArea" : "comparison.outsideScale", {
      underflow: formatNumber(exactArea(series.stats) ? (series.stats?.underflowAreaM2 ?? 0) / 10_000 : series.stats?.underflowCount ?? 0, exactArea(series.stats) ? 2 : 0),
      overflow: formatNumber(exactArea(series.stats) ? (series.stats?.overflowAreaM2 ?? 0) / 10_000 : series.stats?.overflowCount ?? 0, exactArea(series.stats) ? 2 : 0),
    }))}</p>`).join("")}
  </div>` : "";
  return `<div class="comparison-chart ${expanded ? "is-expanded" : ""}" data-comparison-chart>
    <div class="comparison-chart-heading">
      <div class="comparison-series-chips">${chips}</div>
      ${expanded || !showExpand ? "" : `<button class="comparison-chart-expand" type="button" data-expand-comparison-chart aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("comparison.histogramTitle") }))}">${escapeHtml(t("chart.expand"))}</button>`}
    </div>
    <div class="comparison-plot" style="--plot-left:${plot.left / layout.width * 100}%;--plot-right:${(layout.width - plot.left - plot.width) / layout.width * 100}%;--plot-top:${plot.top / layout.height * 100}%;--plot-bottom:${(layout.height - plot.top - plot.height) / layout.height * 100}%">
    <svg viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(chartContext.title)}</title>
      <desc id="${prefix}-description">${escapeHtml(`${chartContext.description} ${t("comparison.histogramExplanation")}`)}</desc>
      <g class="comparison-grid" aria-hidden="true">
        ${yTicks.map(({ y }) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y}" y2="${y}"></line>`).join("")}
      </g>
      <text class="comparison-axis-label comparison-axis-y" transform="translate(26 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("comparison.histogramAxisY"))}</text>
      <text class="comparison-axis-label" x="${plot.left + plot.width / 2}" y="${layout.height - 20}" text-anchor="middle">${escapeHtml(t("comparison.histogramAxisX"))}</text>
      <g class="comparison-axis-values" aria-hidden="true">
        ${xTicks.map((value) => `<text x="${layout.x(value)}" y="${plot.top + plot.height + 27}" text-anchor="middle">${value}${value === 50 ? "°C" : ""}</text>`).join("")}
        ${yTicks.map(({ y, label }) => `<text x="${plot.left - 12}" y="${y + 4}" text-anchor="end">${label}</text>`).join("")}
      </g>
      ${available.map((series, index) => {
        const path = comparisonStepPath(percentages[index], maximum, layout);
        return `<path class="comparison-curve-halo" d="${path}"></path>
          <path class="comparison-curve" d="${path}" style="--curve:${escapeHtml(series.color)};stroke-dasharray:${dashes[index]}"></path>`;
      }).join("")}
      <line class="comparison-crosshair" data-comparison-crosshair x1="${plot.left}" x2="${plot.left}" y1="${plot.top}" y2="${plot.top + plot.height}" hidden></line>
    </svg>
    <div class="comparison-bin-hitareas" role="toolbar" aria-label="${escapeHtml(t("comparison.histogramTitle"))}">
      ${labels.map((label, index) => `<button type="button" data-histogram-bin="${index}" data-focus-key="${prefix}-bin-${index}" data-histogram-x="${plot.left + (index + .5) / labels.length * plot.width}" data-histogram-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></button>`).join("")}
    </div>
    </div>
    <p class="comparison-bin-output" data-histogram-output aria-live="polite">${escapeHtml(labels[Math.floor(labels.length / 2)] ?? "")}</p>
    ${tails}
  </div>`;
}

function comparisonChartDialog(model) {
  const context = comparisonChartContext(model);
  return `<dialog class="comparison-chart-dialog" data-comparison-chart-dialog aria-label="${escapeHtml(t("comparison.histogramTitle"))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(context.title)}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("comparison.closeHistogram"))}">×</button></header>
      <p class="comparison-dialog-description">${escapeHtml(context.description)}</p>
      <p>${escapeHtml(t("comparison.histogramExplanation"))}</p>
      ${comparisonHistogram(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("comparison.academicDetails"))}</p>
    </div>
  </dialog>`;
}

function comparisonSeriesCard(series) {
  const stats = series.stats;
  if (!stats) return "";
  const exactArea = Number.isFinite(stats.clearObservedAreaHa);
  const total = exactArea
    ? stats.clearObservedAreaHa + stats.cloudObservedAreaHa + stats.otherMissingAreaHa
    : stats.clearPixelCount + stats.cloudPixelCount + stats.otherMissingPixelCount;

  const cloudShare = total ? (exactArea ? stats.cloudObservedAreaHa : stats.cloudPixelCount) / total * 100 : 0;
  const sampleCount = exactArea ? stats.contributingLandsatCount : stats.clearPixelCount;
  const warning = (exactArea ? stats.clearObservedAreaHa < .1 : stats.clearPixelCount < 10)
    ? t(exactArea ? "comparison.tooFewArea" : "comparison.tooFewPixels")
    : sampleCount < 30 ? t("comparison.limitedSample", { count: sampleCount }) : "";
  return `<article class="comparison-series-card" style="--series:${escapeHtml(series.color)}">
    <header><i aria-hidden="true"></i><h4>${escapeHtml(series.label)}</h4></header>
    ${warning ? `<p class="comparison-sample-warning">${escapeHtml(warning)}</p>` : ""}
    <dl>
      <div><dt>${escapeHtml(t("landsat.median"))}</dt><dd>${stats.medianC == null ? "-" : `${escapeHtml(formatNumber(stats.medianC, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t("landsat.mean"))}</dt><dd>${stats.meanC == null ? "-" : `${escapeHtml(formatNumber(stats.meanC, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t("comparison.temperatureRange"))}</dt><dd>${stats.p10C == null ? "-" : `${escapeHtml(formatNumber(stats.p10C, 1))}–${escapeHtml(formatNumber(stats.p90C, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t(exactArea ? "comparison.clearObservedArea" : "comparison.clearPixels"))}</dt><dd>${escapeHtml(formatNumber(exactArea ? stats.clearObservedAreaHa : stats.clearPixelCount, exactArea ? 2 : 0))}${exactArea ? " ha" : ""}</dd></div>
      ${exactArea ? `<div><dt>${escapeHtml(t("comparison.landsatObservations"))}</dt><dd>${escapeHtml(formatNumber(stats.contributingLandsatCount, 0))}</dd></div>` : ""}
      <div><dt>${escapeHtml(t("comparison.cloudShare"))}</dt><dd>${escapeHtml(formatNumber(cloudShare, 1))}%</dd></div>
    </dl>
  </article>`;
}

function renderLandsatUrbanAtlasComparison(model) {
  const { record, urbanAtlas, observation, landsatManifest } = model;
  const heatwave = landsatManifest?.heatwaves?.find(({ id }) => observation?.heatwaveIds?.includes(id));
  const uaStats = scopedStatistics(urbanAtlas, record);
  const uaCategories = urbanAtlasCategoryItems(uaStats);
  return `<div class="panel-hero comparison-hero">
    <p class="panel-eyebrow">${escapeHtml(t("comparison.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
    <p class="panel-subtitle">${escapeHtml(landsatDateTime(observation?.acquiredAt))}</p>
    ${heatwave ? `<p>${escapeHtml(t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) }))}</p>` : ""}
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("comparison.seriesCount", { count: model.selectedSeries.length }))}</p>
  </div>
  <div class="panel-body comparison-body">
    <section>
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("comparison.title"))}</p><h3>${escapeHtml(t("comparison.histogramTitle"))}</h3></div>
      <p class="comparison-definition">${escapeHtml(t("comparison.surfaceTemperatureDefinition"))}</p>
      ${comparisonHistogram(model)}
      ${comparisonChartDialog(model)}
    </section>
    <section aria-labelledby="comparison-series-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.detailsKicker"))}</p><h3 id="comparison-series-title">${escapeHtml(t("comparison.seriesMetrics"))}</h3></div>
      <div class="comparison-series-list">${model.selectedSeries.map(comparisonSeriesCard).join("")}</div>
    </section>
    ${uaStats ? `<section aria-labelledby="comparison-ua-title">
      <div class="section-heading"><p class="section-kicker">URBAN ATLAS 2021</p><h3 id="comparison-ua-title">${escapeHtml(t("comparison.urbanAtlasResults"))}</h3></div>
      ${localComposition(uaCategories, t("urbanAtlas.summaryTitle"))}
      <div class="local-breakdown-list urban-atlas-category-summary">${uaCategories.map(localClassRow).join("")}</div>
    </section>
    <details class="detail-accordion" data-section="comparison-urban-atlas-details">
      <summary data-focus-key="comparison-urban-atlas-details-summary"><span>${escapeHtml(t("urbanAtlas.detailsTitle"))}</span></summary>
      <div class="accordion-content">${urbanAtlasCategoryDetails(uaStats, urbanAtlas)}</div>
    </details>` : `<p class="panel-empty-state">${escapeHtml(t("comparison.noScopeData"))}</p>`}
    <details class="detail-accordion methodology-accordion" data-section="comparison-methodology">
      <summary data-focus-key="comparison-methodology-summary"><span>${escapeHtml(t("comparison.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("comparison.methodologyPixel"))}</p>
        <p>${escapeHtml(t("comparison.methodologyTime"))}</p>
        <p>${escapeHtml(t("comparison.cloudExplanation"))}</p>
        <p>${escapeHtml(t("comparison.methodologyStatistics"))}</p>
        <p>${escapeHtml(t("landsat.methodology"))}</p>
        <p>${escapeHtml(t("urbanAtlas.classificationWarning"))}</p>
      </div>
    </details>
  </div>`;
}

function renderLandsatJaarbakComparison(model) {
  const { record, observation, landsatManifest, surfaceStats } = model;
  const heatwave = landsatManifest?.heatwaves?.find(({ id }) => observation?.heatwaveIds?.includes(id));
  const sealed = surfaceStats?.sealedPercentage ?? 0;
  const unsealed = surfaceStats?.unsealedPercentage ?? 0;
  const densityModel = model.densityScatter?.pixelPoints ? {
    comparisonId: "landsat-jaarbak-density", record,
    title: t("soilComparison.densityChartTitle"), definition: t("soilComparison.densityChartDefinition"),
    xLabel: model.densityScatter.xLabel, yLabel: model.densityScatter.yLabel,
    xKey: "density", yKey: "temperature", pixelPoints: model.densityScatter.pixelPoints,
    regression: model.densityScatter.regression,
    slopeScale: 10,
    slopeUnit: t("soilComparison.densitySlopeUnit"),
    observation,
    secondaryYear: model.secondaryYear,
    expandedDescription: t("soilComparison.expandedDensityDescription", {
      area: panelAreaName(record),
      observed: landsatDateTime(observation?.acquiredAt),
      year: model.secondaryYear,
      heatwave: heatwave
        ? t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) })
        : t("landsat.kindHeatwave"),
    }),
    caveat: t("sealedUrban.pixelRegressionCaveat"),
  } : null;
  return `<div class="panel-hero comparison-hero">
    <p class="panel-eyebrow">${escapeHtml(t("soilComparison.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
    <p class="panel-subtitle">${escapeHtml(landsatDateTime(observation?.acquiredAt))}</p>
    ${heatwave ? `<p>${escapeHtml(t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) }))}</p>` : ""}
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("soilComparison.matchedYear", { year: model.secondaryYear }))}</p>
  </div>
  <div class="panel-body comparison-body">
    <section aria-labelledby="soil-temperature-distribution-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("soilComparison.title"))}</p><h3 id="soil-temperature-distribution-title">${escapeHtml(t("comparison.histogramTitle"))}</h3></div>
      <p class="comparison-definition">${escapeHtml(t("comparison.surfaceTemperatureDefinition"))}</p>
      <p class="section-intro">${escapeHtml(t("comparison.histogramExplanation"))}</p>
      ${comparisonHistogram(model)}
      ${comparisonChartDialog(model)}
    </section>
    <section aria-labelledby="soil-density-analysis-title">
      <div class="section-heading soil-density-heading"><p class="section-kicker">${escapeHtml(t("soilComparison.densityAnalysisKicker"))}</p><h3 id="soil-density-analysis-title">${escapeHtml(t("soilComparison.densityChartTitle"))}</h3></div>
      ${densityModel ? `${sealedUrbanScatterChart(densityModel)}${sealedUrbanScatterDialog(densityModel)}` : `<p class="panel-empty-state">${escapeHtml(t("soilComparison.densityUnavailable"))}</p>`}
      ${model.densityScatter?.regression ? `<div class="summary-grid sealed-regression-grid">
        ${metricCard("sealedUrban.sample", formatNumber(model.densityScatter.regression.n, 0), "#315e66")}
        ${metricCard("sealedUrban.slope", `${formatNumber(model.densityScatter.regression.slope * 10, 3)} ${t("soilComparison.densitySlopeUnit")}`, "#8f1d2c")}
      </div>` : ""}
    </section>
    <section aria-labelledby="soil-comparison-series-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.detailsKicker"))}</p><h3 id="soil-comparison-series-title">${escapeHtml(t("comparison.seriesMetrics"))}</h3></div>
      <div class="comparison-series-list">${model.selectedSeries.map(comparisonSeriesCard).join("")}</div>
    </section>
    ${surfaceStats ? `<section aria-labelledby="soil-composition-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.jaarbak", { year: model.secondaryYear }).toUpperCase())}</p><h3 id="soil-composition-title">${escapeHtml(t("soilComparison.results"))}</h3></div>
      <div class="local-composition" role="img" aria-label="${escapeHtml(`${t("soilComparison.sealed")} ${formatNumber(sealed, 1)}%, ${t("soilComparison.unsealed")} ${formatNumber(unsealed, 1)}%`)}">
        <span style="width:${sealed}%;--segment:#e8292f"></span><span style="width:${unsealed}%;--segment:#8ecf7c"></span>
      </div>
      <div class="summary-grid">
        ${metricCard("soilComparison.sealed", `${formatNumber(sealed, 1)}% · ${formatNumber(surfaceStats.sealedAreaHa, 1)} ha`, "#8f1d2c")}
        ${metricCard("soilComparison.unsealed", `${formatNumber(unsealed, 1)}% · ${formatNumber(surfaceStats.unsealedAreaHa, 1)} ha`, "#176b43")}
      </div>
      <p class="calculation-note">${escapeHtml(t("soilComparison.assignment"))}</p>
    </section>` : `<p class="panel-empty-state">${escapeHtml(t("comparison.noScopeData"))}</p>`}
    <details class="detail-accordion methodology-accordion" data-section="soil-comparison-methodology">
      <summary data-focus-key="soil-comparison-methodology-summary"><span>${escapeHtml(t("comparison.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("soilComparison.assignment"))}</p>
        <p>${escapeHtml(t("soilComparison.densityMethodology"))}</p>
        <p>${escapeHtml(t("soilComparison.methodTime"))}</p>
        ${model.secondaryStatus === "provisional" ? `<p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("soilComparison.provisional"))}</p>` : ""}
        <p>${escapeHtml(t("comparison.cloudExplanation"))}</p>
        <p>${escapeHtml(t("comparison.methodologyStatistics"))}</p>
      </div>
    </details>
  </div>`;
}

function heatIncomeScatter(model, { expanded = false } = {}) {
  const layout = heatIncomeLayout();
  const { plot } = layout;
  const x = layout.x;
  const y = layout.y;
  const xTicks = [20_000, 30_000, 40_000, 50_000];
  const yTicks = Array.from({ length: 11 }, (_, index) => index);
  const selectedPoint = model.points.find(({ sectorId }) => sectorId === model.highlightedSectorId);
  const initialPoint = selectedPoint ?? model.points[Math.floor(model.points.length / 2)];
  const prefix = expanded ? "heat-income-chart-expanded" : "heat-income-chart-inline";
  const pointLabel = (point) => t("heatIncome.pointLabel", {
    sector: point.sectorName,
    code: point.sectorId,
    municipality: point.municipality,
    income: formatCurrency(point.income),
    metric: t(`heatMetric.${model.metric}`),
    score: formatNumber(point.score, 0),
  });
  return `<div class="heat-income-chart ${expanded ? "is-expanded" : ""}" data-sector-comparison-chart data-heat-income-chart>
    ${expanded ? "" : `<div class="heat-income-chart-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("heatIncome.chartTitle", { metric: t(`heatMetric.${model.metric}`) }) }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <p class="heat-income-boxplot-explanation">${escapeHtml(t("heatIncome.boxPlotExplanation"))}</p>
    <svg viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("heatIncome.chartTitle", { metric: t(`heatMetric.${model.metric}`) }))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("heatIncome.chartDescription", { count: model.points.length, area: panelAreaName(model.record) }))}</desc>
      <g class="heat-income-grid" aria-hidden="true">
        ${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}
      </g>
      <g class="heat-income-boxplots" aria-hidden="true">
        ${(model.scoreSummaries ?? []).filter(({ count }) => count > 0).map((summary) => `<g>
          <line class="heat-income-whisker" x1="${x(summary.whiskerLow)}" x2="${x(summary.whiskerHigh)}" y1="${y(summary.score)}" y2="${y(summary.score)}"></line>
          <line class="heat-income-whisker-cap" x1="${x(summary.whiskerLow)}" x2="${x(summary.whiskerLow)}" y1="${y(summary.score) - 8}" y2="${y(summary.score) + 8}"></line>
          <line class="heat-income-whisker-cap" x1="${x(summary.whiskerHigh)}" x2="${x(summary.whiskerHigh)}" y1="${y(summary.score) - 8}" y2="${y(summary.score) + 8}"></line>
          <rect x="${x(summary.q1)}" y="${y(summary.score) - 12}" width="${Math.max(1, x(summary.q3) - x(summary.q1))}" height="24" rx="4"></rect>
          <line class="heat-income-box-median" x1="${x(summary.median)}" x2="${x(summary.median)}" y1="${y(summary.score) - 12}" y2="${y(summary.score) + 12}"></line>
          <text class="heat-income-row-count" x="${plot.left + plot.width + 10}" y="${y(summary.score) + 4}">n=${summary.count}</text>
        </g>`).join("")}
      </g>
      <g class="heat-income-axis-values" aria-hidden="true">
        ${xTicks.map((value) => `<text class="heat-income-x-tick" x="${x(value)}" y="${plot.top + plot.height + 30}" text-anchor="middle">${escapeHtml(compactEuroTick(value))}</text>`).join("")}
        ${yTicks.map((value) => `<text x="${plot.left - 14}" y="${y(value) + 5}" text-anchor="end">${value}</text>`).join("")}
      </g>
      <text class="heat-income-axis-label" x="${plot.left + plot.width / 2}" y="${layout.height - 22}" text-anchor="middle">${escapeHtml(t("heatIncome.axisIncome"))}</text>
      <text class="heat-income-axis-label heat-income-axis-y" transform="translate(28 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("heatIncome.axisScore", { metric: t(`heatMetric.${model.metric}`) }))}</text>
      <g class="heat-income-points" role="group" aria-label="${escapeHtml(t("heatIncome.pointsLabel"))}">
        ${model.points.map((point, index) => {
          const highlighted = point.sectorId === model.highlightedSectorId;
          return `<circle cx="${x(point.income).toFixed(2)}" cy="${y(point.score).toFixed(2)}" r="5" role="button" tabindex="${highlighted || (!model.highlightedSectorId && index === 0) ? 0 : -1}" class="heat-income-point ${highlighted ? "is-selected" : ""}" data-scatter-sector="${escapeHtml(point.sectorId)}" data-scatter-label="${escapeHtml(pointLabel(point))}" aria-label="${escapeHtml(pointLabel(point))}"></circle>`;
        }).join("")}
      </g>
    </svg>
    <p class="heat-income-output" data-scatter-output aria-live="polite">${initialPoint ? escapeHtml(pointLabel(initialPoint)) : escapeHtml(t("heatIncome.noComparableValue"))}</p>
  </div>`;
}

function heatIncomeChartDialog(model) {
  return `<dialog class="comparison-chart-dialog heat-income-chart-dialog" data-comparison-chart-dialog aria-label="${escapeHtml(t("heatIncome.expandedTitle", { metric: t(`heatMetric.${model.metric}`), area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("heatIncome.expandedTitle", { metric: t(`heatMetric.${model.metric}`), area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("comparison.closeHistogram"))}">×</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("heatIncome.expandedDescription", { metric: t(`heatMetric.${model.metric}`), count: model.points.length, area: panelAreaName(model.record) }))}</p>
      ${heatIncomeScatter(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("heatIncome.academicDetails"))}</p>
    </div>
  </dialog>`;
}

function renderHeatIncomeComparison(model) {
  return `<div class="panel-hero comparison-hero heat-income-hero">
    <p class="panel-eyebrow">${escapeHtml(t("heatIncome.heroKicker", { area: panelAreaName(model.record) }))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(t("heatIncome.chartTitle", { metric: t(`heatMetric.${model.metric}`) }))}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("heatIncome.sampleCount", { count: model.points.length, excluded: model.excludedCount }))}</p>
  </div>
  <div class="panel-body comparison-body heat-income-body">
    <section aria-labelledby="heat-income-summary-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("heatIncome.title"))}</p><h3 id="heat-income-summary-title">${escapeHtml(t("heatIncome.relationshipTitle"))}</h3></div>
      ${panelHeatMetricSelector(model.metric)}
      ${heatIncomeScatter(model)}
      ${heatIncomeChartDialog(model)}
    </section>
    <details class="detail-accordion methodology-accordion" data-section="heat-income-methodology">
      <summary data-focus-key="heat-income-methodology-summary"><span>${escapeHtml(t("heatIncome.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("heatIncome.definition"))}</p>
        <p>${escapeHtml(t("heatIncome.scopeNote", { area: panelAreaName(model.record) }))}</p>
        <p>${escapeHtml(t("heatIncome.methodologySources"))}</p>
        <p>${escapeHtml(t("heatIncome.methodologyScores"))}</p>
        <p>${escapeHtml(t("heatIncome.methodologyIncome"))}</p>
        <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("heatIncome.methodologyCaveat"))}</p>
      </div>
    </details>
  </div>`;
}

function stableSectorOffset(sectorId) {
  let hash = 2166136261;
  for (const character of sectorId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1001 / 1000 - .5) * .42;
}

function heatPopulationPointLabel(model, point) {
  return t("heatPopulation.pointLabel", {
    sector: point.sectorName,
    code: point.sectorId,
    municipality: point.municipality,
    population: formatNumber(point.population, 0),
    density: formatNumber(point.densityPerHa, 1),
    metric: t(`heatMetric.${model.metric}`),
    score: formatNumber(point.score, 0),
  });
}

function heatPopulationBoxPlot(model, { expanded = false, showExpand = false } = {}) {
  const layout = heatPopulationBoxLayout();
  const { plot } = layout;
  const yTicks = [0, 2, 4, 6, 8, 10];
  const selectedPoint = model.points.find(({ sectorId }) => sectorId === model.highlightedSectorId);
  const initialPoint = selectedPoint ?? model.points[0];
  const prefix = expanded ? "heat-population-box-expanded" : "heat-population-box-inline";
  return `<div class="heat-population-chart ${expanded ? "is-expanded" : ""}" data-sector-comparison-chart data-heat-population-box-chart>
    <div class="heat-population-chart-title-row"><h4>${escapeHtml(t("heatPopulation.boxTitle"))}</h4>
      ${expanded || !showExpand ? "" : `<button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="heat-population-boxes" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("heatPopulation.boxTitle") }))}">${escapeHtml(t("chart.expand"))}</button>`}
    </div>
    <p class="heat-population-chart-intro">${escapeHtml(t("heatPopulation.boxPlotExplanation"))}</p>
    <svg viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("heatPopulation.boxTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("heatPopulation.boxDescription", { count: model.points.length, area: panelAreaName(model.record) }))}</desc>
      <g class="heat-population-grid" aria-hidden="true">
        ${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${layout.y(value)}" y2="${layout.y(value)}"></line>`).join("")}
      </g>
      <g class="heat-population-boxplots" aria-hidden="true">
        ${(model.levelSummaries ?? []).filter(({ count }) => count > 0).map((summary) => {
          const centre = layout.x(summary.level);
          const left = layout.x(summary.level - .22);
          const right = layout.x(summary.level + .22);
          return `<g>
            <line class="heat-population-whisker" x1="${centre}" x2="${centre}" y1="${layout.y(summary.whiskerLow)}" y2="${layout.y(summary.whiskerHigh)}"></line>
            <line class="heat-population-whisker-cap" x1="${left}" x2="${right}" y1="${layout.y(summary.whiskerLow)}" y2="${layout.y(summary.whiskerLow)}"></line>
            <line class="heat-population-whisker-cap" x1="${left}" x2="${right}" y1="${layout.y(summary.whiskerHigh)}" y2="${layout.y(summary.whiskerHigh)}"></line>
            <rect x="${left}" y="${layout.y(summary.q3)}" width="${right - left}" height="${Math.max(1, layout.y(summary.q1) - layout.y(summary.q3))}" rx="5"></rect>
            <line class="heat-population-box-median" x1="${left}" x2="${right}" y1="${layout.y(summary.median)}" y2="${layout.y(summary.median)}"></line>
            <text class="heat-population-group-count" x="${centre}" y="${plot.top - 10}" text-anchor="middle">n=${summary.count}</text>
          </g>`;
        }).join("")}
      </g>
      <g class="heat-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 14}" y="${layout.y(value) + 5}" text-anchor="end">${value}</text>`).join("")}
        ${Array.from({ length: 5 }, (_, index) => index + 1).map((level) => `<text class="heat-population-range-tick" x="${layout.x(level)}" y="${plot.top + plot.height + 36}" text-anchor="middle">${escapeHtml(t(`heatPopulation.densityBand${level}`))}</text>`).join("")}
      </g>
      <text class="heat-population-axis-label" x="${plot.left + plot.width / 2}" y="${layout.height - 24}" text-anchor="middle">${escapeHtml(t("heatPopulation.axisPopulationDensity"))}</text>
      <text class="heat-population-axis-label" transform="translate(28 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("heatPopulation.axisScore", { metric: t(`heatMetric.${model.metric}`) }))}</text>
      <g class="heat-population-points" role="group" aria-label="${escapeHtml(t("heatPopulation.pointsLabel"))}">
        ${model.points.map((point, index) => {
          const highlighted = point.sectorId === model.highlightedSectorId;
          const label = heatPopulationPointLabel(model, point);
          return `<circle cx="${layout.x(point.densityBand + stableSectorOffset(point.sectorId)).toFixed(2)}" cy="${layout.y(point.score).toFixed(2)}" r="5" role="button" tabindex="${highlighted || (!model.highlightedSectorId && index === 0) ? 0 : -1}" class="heat-population-point ${highlighted ? "is-selected" : ""}" data-scatter-sector="${escapeHtml(point.sectorId)}" data-scatter-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></circle>`;
        }).join("")}
      </g>
    </svg>
    <p class="heat-population-output" data-scatter-output aria-live="polite">${initialPoint ? escapeHtml(heatPopulationPointLabel(model, initialPoint)) : ""}</p>
  </div>`;
}

function compactPopulationTick(value) {
  if (!value) return "0";
  return `${formatNumber(value / 1_000, value < 10_000 ? 1 : 0)}k`;
}

function heatPopulationBarChart(model, { expanded = false, showExpand = false } = {}) {
  const maximum = Math.max(...model.populationByScore.map(({ population }) => population), 1);
  const axisMaximum = Math.ceil(maximum / 5_000) * 5_000;
  const layout = heatPopulationBarLayout(axisMaximum);
  const { plot } = layout;
  const yTicks = Array.from({ length: 5 }, (_, index) => axisMaximum / 4 * index);
  const bandWidth = plot.width / 11;
  const barWidth = bandWidth * .68;
  const prefix = expanded ? "heat-population-bars-expanded" : "heat-population-bars-inline";
  const barLabel = (entry) => t("heatPopulation.barLabel", {
    score: entry.score,
    population: formatNumber(entry.population, 0),
    sectors: entry.sectorCount,
    share: formatNumber(entry.populationShare, 1),
    cumulativePopulation: formatNumber(entry.atOrAbovePopulation, 0),
    cumulativeShare: formatNumber(entry.atOrAbovePopulationShare, 1),
  });
  return `<div class="heat-population-chart ${expanded ? "is-expanded" : ""}" data-heat-population-bar-chart>
    <div class="heat-population-chart-title-row"><h4>${escapeHtml(t("heatPopulation.barTitle"))}</h4>
      ${expanded || !showExpand ? "" : `<button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="heat-population-bars" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("heatPopulation.barTitle") }))}">${escapeHtml(t("chart.expand"))}</button>`}
    </div>
    <p class="heat-population-chart-intro">${escapeHtml(t("heatPopulation.barDefinition"))}</p>
    <svg viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("heatPopulation.barTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("heatPopulation.barDescription", { area: panelAreaName(model.record) }))}</desc>
      <g class="heat-population-grid" aria-hidden="true">
        ${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${layout.y(value)}" y2="${layout.y(value)}"></line>`).join("")}
      </g>
      <g class="heat-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 14}" y="${layout.y(value) + 5}" text-anchor="end">${escapeHtml(compactPopulationTick(value))}</text>`).join("")}
        ${model.populationByScore.map(({ score }) => `<text x="${layout.x(score)}" y="${plot.top + plot.height + 30}" text-anchor="middle">${score}</text>`).join("")}
      </g>
      <text class="heat-population-axis-label" x="${plot.left + plot.width / 2}" y="${layout.height - 20}" text-anchor="middle">${escapeHtml(t("heatPopulation.axisHeatScore", { metric: t(`heatMetric.${model.metric}`) }))}</text>
      <text class="heat-population-axis-label" transform="translate(28 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("heatPopulation.axisResidents"))}</text>
      <g class="heat-population-bars" role="group" aria-label="${escapeHtml(t("heatPopulation.barTitle"))}">
        ${model.populationByScore.map((entry, index) => {
          const barHeight = plot.top + plot.height - layout.y(entry.population);
          const label = barLabel(entry);
          return `<rect x="${layout.x(entry.score) - barWidth / 2}" y="${layout.y(entry.population)}" width="${barWidth}" height="${Math.max(1, barHeight)}" rx="4" style="--bar:${escapeHtml(model.scoreColors[entry.score] ?? "#6b7d81")}" role="button" tabindex="${index === 0 ? 0 : -1}" data-population-score-bar data-bar-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></rect>`;
        }).join("")}
      </g>
    </svg>
    <p class="heat-population-output" data-population-bar-output aria-live="polite">${escapeHtml(barLabel(model.populationByScore[0]))}</p>
  </div>`;
}

function heatPopulationCharts(model, { expanded = false } = {}) {
  return `<div class="heat-population-charts ${expanded ? "is-expanded" : ""}">
    ${heatPopulationBoxPlot(model, { expanded, showExpand: !expanded })}
    ${heatPopulationBarChart(model, { expanded, showExpand: !expanded })}
  </div>`;
}

function heatPopulationBarDialog(model) {
  return `<dialog class="comparison-chart-dialog heat-population-chart-dialog" data-comparison-chart-dialog data-chart-dialog-id="heat-population-bars" aria-label="${escapeHtml(t("heatPopulation.expandedBarTitle", { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("heatPopulation.expandedBarTitle", { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("heatPopulation.closeResidentsChart"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("heatPopulation.expandedBarDescription", { metric: t(`heatMetric.${model.metric}`), area: panelAreaName(model.record) }))}</p>
      ${heatPopulationBarChart(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("heatPopulation.cumulativeDenominator", {
        population: formatNumber(model.comparablePopulation, 0),
        excluded: formatNumber(model.excludedPopulation, 0),
      }))}</p>
    </div>
  </dialog>`;
}

function heatPopulationChartDialog(model) {
  return `<dialog class="comparison-chart-dialog heat-population-chart-dialog" data-comparison-chart-dialog data-chart-dialog-id="heat-population-boxes" aria-label="${escapeHtml(t("heatPopulation.expandedTitle", { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("heatPopulation.expandedTitle", { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("heatPopulation.closeCharts"))}">×</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("heatPopulation.expandedDescription", { metric: t(`heatMetric.${model.metric}`), area: panelAreaName(model.record) }))}</p>
      ${heatPopulationBoxPlot(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("heatPopulation.academicDetails"))}</p>
    </div>
  </dialog>`;
}

function renderHeatPopulationComparison(model) {
  return `<div class="panel-hero comparison-hero heat-population-hero">
    <p class="panel-eyebrow">${escapeHtml(t("heatPopulation.heroKicker", { area: panelAreaName(model.record) }))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(t("heatPopulation.relationshipTitle"))}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("heatPopulation.sampleCount", { count: model.points.length, excluded: model.excludedCount }))}</p>
  </div>
  <div class="panel-body comparison-body heat-population-body">
    <section aria-labelledby="heat-population-summary-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("heatPopulation.title"))}</p><h3 id="heat-population-summary-title">${escapeHtml(t("heatPopulation.relationshipTitle"))}</h3></div>
      ${panelHeatMetricSelector(model.metric)}
      <p class="heat-population-coverage"><strong>${escapeHtml(t("heatPopulation.comparablePopulation", {
        population: formatNumber(model.comparablePopulation, 0),
        total: formatNumber(model.totalPopulation, 0),
        excluded: formatNumber(model.excludedPopulation, 0),
      }))}</strong></p>
      ${heatPopulationCharts(model)}
      ${heatPopulationChartDialog(model)}
      ${heatPopulationBarDialog(model)}
    </section>
    <details class="detail-accordion" data-section="heat-population-details">
      <summary data-focus-key="heat-population-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("heatPopulation.detailsTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("heatPopulation.definition"))}</p>
        <p>${escapeHtml(t("heatPopulation.scopeNote", { area: panelAreaName(model.record) }))}</p>
        <p>${escapeHtml(t("heatPopulation.boxPlotExplanation"))}</p>
        <p>${escapeHtml(t("heatPopulation.weightExplanation"))}</p>
        <p>${escapeHtml(t("heatPopulation.excludedExplanation", { count: model.excludedCount, population: formatNumber(model.excludedPopulation, 0) }))}</p>
      </div>
    </details>
    <details class="detail-accordion methodology-accordion" data-section="heat-population-methodology">
      <summary data-focus-key="heat-population-methodology-summary"><span>${escapeHtml(t("heatPopulation.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("heatPopulation.methodologySources"))}</p>
        <p>${escapeHtml(t("heatPopulation.methodologyScores"))}</p>
        <p>${escapeHtml(t("heatPopulation.methodologyPopulation"))}</p>
        <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("heatPopulation.methodologyCaveat"))}</p>
      </div>
    </details>
  </div>`;
}

function renderLandsatTemperature(model) {
  const { record, manifest, observation, stats } = model;
  const kind = "Heatwave";

  const kindLabel = t("landsat.kindHeatwave");
  const heatwave = manifest?.heatwaves?.find(({ id }) => observation?.heatwaveIds?.includes(id));
  const heatwavePeriod = heatwave
    ? t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) })
    : "";
  const hasTemperature = Number.isFinite(stats?.medianC);
  const sourceUrl = safeHref(manifest?.source?.productUrl);
  return `
    <article class="panel-article landsat-panel">
      <div class="panel-hero landsat-hero">
        <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
        <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
        <p class="landsat-observation-badge is-${kind.toLowerCase()}">${escapeHtml(kindLabel)} · ${escapeHtml(landsatDateTime(observation?.acquiredAt))}</p>
        ${hasTemperature ? `<div class="score-hero landsat-score-hero">
          <div class="score-orb"><strong>${escapeHtml(formatNumber(stats.medianC, 1))}</strong><span>°C</span></div>
          <div><span class="score-caption">${escapeHtml(t("landsat.medianHeadline"))}</span><p>${escapeHtml(t("landsat.clearSkyOnly"))}</p></div>
        </div>` : `<p class="panel-empty-state">${escapeHtml(t("landsat.noClearData"))}</p>`}
        ${heatwavePeriod ? `<p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(heatwavePeriod)}</p>` : ""}
      </div>
      <div class="panel-body landsat-body">
        <section aria-labelledby="landsat-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.landsatTemperature"))}</p><h3 id="landsat-summary-title">${escapeHtml(t("landsat.summaryTitle"))}</h3></div>
          <p class="landsat-definition">${escapeHtml(t("landsat.definition"))}</p>
          ${hasTemperature ? landsatDistribution(stats) : ""}
        </section>
        <details class="detail-accordion" data-section="landsat-observation-details">
          <summary data-focus-key="landsat-observation-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("landsat.detailsTitle"))}</span></summary>
          <div class="accordion-content">
            <div class="summary-grid landsat-summary-grid">
              ${metricCard("landsat.mean", Number.isFinite(stats?.meanC) ? `${formatNumber(stats.meanC, 1)} °C` : t("value.notAvailable"), "#71216c")}
              ${metricCard("landsat.cloudArea", t("landsat.areaPercentage", { area: formatNumber(stats?.cloudAreaHa ?? 0), percentage: formatNumber(stats?.cloudPercentage ?? 0, 1) }), "#53666b")}
              ${metricCard("landsat.otherMissing", t("landsat.areaPercentage", { area: formatNumber(stats?.otherNoDataAreaHa ?? 0), percentage: formatNumber(stats?.otherNoDataPercentage ?? 0, 1) }), "#53666b")}
              ${metricCard("landsat.uncertainty", Number.isFinite(stats?.medianUncertaintyK) ? `${formatNumber(stats.medianUncertaintyK, 2)} K` : t("value.notAvailable"), "#53666b")}
            </div>
            <p class="calculation-note">${escapeHtml(t("landsat.pixelCount", { count: stats?.pixelCount ?? 0 }))}</p>
          </div>
        </details>
        <details class="detail-accordion methodology-accordion" data-section="landsat-methodology">
          <summary data-focus-key="landsat-methodology-summary"><span>${escapeHtml(t("officialData.methodology"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t("landsat.methodology"))}</p>
            <p>${escapeHtml(t("landsat.referenceMethod"))}</p>
            <p>${escapeHtml(t("landsat.missing2025"))}</p>
            <p class="provenance-note"><strong>${escapeHtml(t("provenance.localSummary"))}</strong><span>${escapeHtml(t("landsat.derivedNote"))}</span></p>
            <p>${escapeHtml(t("landsat.sceneIds"))}</p>
            <ul>${(observation?.sceneIds ?? []).map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join("")}</ul>
            ${sourceUrl ? `<p><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landsat.officialProduct"))}</a></p>` : ""}
            ${manifest?.kmi?.definitionUrl ? `<p><a href="${safeHref(manifest.kmi.definitionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landsat.kmiDefinition"))}</a></p>` : ""}
          </div>
        </details>
      </div>
    </article>`;
}

function incomeAsymmetryLabel(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 1) return t("income.asymmetryBalanced");
  return t(value > 0 ? "income.asymmetryRight" : "income.asymmetryLeft");
}

function incomeMetricCard(labelKey, value) {
  return `
    <div class="summary-card income-summary-card">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function renderIncome(model) {
  const { record, income, year, stats } = model;
  const available = stats?.sourceStatus === "available" && Number.isFinite(stats.medianNetTaxableIncome);
  const sourceUrl = safeHref(income?.source?.pageUrl);
  const heroValue = available
    ? `<div class="income-hero-metric"><strong>${escapeHtml(formatCurrency(stats.medianNetTaxableIncome))}</strong><span>${escapeHtml(t("income.medianHeadline"))}</span></div>`
    : `<p class="panel-empty-state">${escapeHtml(t("income.noData"))}</p>`;
  return `
    <article class="panel-article income-panel">
      <div class="panel-hero income-hero">
        <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
        <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
        <p class="panel-subtitle">${escapeHtml(t("income.referenceYear", { year }))}</p>
        ${heroValue}
        <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("income.sourceName"))}</p>
      </div>
      <div class="panel-body income-body">
        <section aria-labelledby="income-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.income"))}</p><h3 id="income-summary-title">${escapeHtml(t("income.medianHeadline"))}</h3></div>
          ${available ? `
            <div class="summary-grid income-summary-grid">
              ${incomeMetricCard("income.average", formatCurrency(stats.averageNetTaxableIncome))}
              ${incomeMetricCard("income.declarations", formatNumber(stats.numberOfDeclarations, 0))}
            </div>
            <section class="income-spread" aria-labelledby="income-spread-title">
              <h4 id="income-spread-title">${escapeHtml(t("income.spreadTitle"))}</h4>
              <div class="local-breakdown-list">
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileDifference"))}</span><strong>${escapeHtml(formatCurrency(stats.interquartileDifference))}</strong></div>
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileCoefficient"))}</span><strong>${escapeHtml(`${formatNumber(stats.interquartileCoefficient, 0)}%`)}</strong></div>
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileAsymmetry"))}</span><strong>${escapeHtml(`${formatNumber(stats.interquartileAsymmetry, 0)}%`)}</strong><small>${escapeHtml(incomeAsymmetryLabel(stats.interquartileAsymmetry))}</small></div>
              </div>
            </section>`
            : `<p class="panel-empty-state income-missing-copy">${escapeHtml(t("income.notPublishedExplanation"))}</p>`}
        </section>
        ${available ? `<details class="detail-accordion" data-section="income-details">
          <summary data-focus-key="income-details-summary"><span>${escapeHtml(t("panel.detailsKicker"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t("income.definition"))}</p>
            <p><strong>${escapeHtml(t("income.average"))}:</strong> ${escapeHtml(t("income.averageExplanation"))}</p>
            <p><strong>${escapeHtml(t("income.declarations"))}:</strong> ${escapeHtml(t("income.declarationsExplanation"))}</p>
            <p><strong>${escapeHtml(t("income.interquartileDifference"))}:</strong> ${escapeHtml(t("income.interquartileDifferenceExplanation"))}</p>
            <p><strong>${escapeHtml(t("income.interquartileCoefficient"))}:</strong> ${escapeHtml(t("income.interquartileCoefficientExplanation"))}</p>
            <p><strong>${escapeHtml(t("income.interquartileAsymmetry"))}:</strong> ${escapeHtml(t("income.interquartileAsymmetryExplanation"))}</p>
            <p>${escapeHtml(t("income.distributionUnavailable"))}</p>
          </div>
        </details>` : ""}
        <details class="detail-accordion methodology-accordion" data-section="income-methodology">
          <summary data-focus-key="income-methodology-summary"><span>${escapeHtml(t("income.methodologyTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t("income.methodology"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("income.nominalWarning"))}</p>
            ${sourceUrl ? `<p><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("income.sourceName"))}</a></p>` : ""}
          </div>
        </details>
      </div>
    </article>`;
}

function renderPopulation(model) {
  const { record, datasetId, dataset, stats } = model;
  const available = stats?.sourceStatus === "available" && Number.isFinite(stats.population);
  const current = datasetId === "statbel-2025";
  const sourceUrl = safeHref(dataset?.source?.pageUrl);
  return `
    <article class="panel-article population-panel">
      <div class="panel-hero population-hero">
        <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
        <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
        <p class="panel-subtitle">${escapeHtml(t(current ? "population.currentDataset" : "population.modelDataset"))}</p>
        ${available ? `<div class="income-hero-metric"><strong>${escapeHtml(formatNumber(stats.population, 0))}</strong><span>${escapeHtml(t(current ? "population.populationHeadline" : "population.estimatedPopulationHeadline"))}</span></div>`
          : `<p class="panel-empty-state">${escapeHtml(t("population.noData"))}</p>`}
        <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t(current ? "population.statbelSource" : "population.flandersSource"))}</p>
      </div>
      <div class="panel-body population-body">
        <section aria-labelledby="population-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.population"))}</p><h3 id="population-summary-title">${escapeHtml(t("population.panelTitle"))}</h3></div>
          ${available ? `<div class="summary-grid population-summary-grid">
            ${incomeMetricCard("population.densityMetric", t("population.densityValue", { value: formatNumber(stats.densityPerHa, 1) }))}
            ${incomeMetricCard("population.areaMetric", t("unit.hectares", { value: formatNumber(stats.areaHa, 1) }))}
          </div>` : `<p class="panel-empty-state">${escapeHtml(t("population.notPublishedExplanation"))}</p>`}
        </section>
        ${available ? `<details class="detail-accordion" data-section="population-details">
          <summary data-focus-key="population-details-summary"><span>${escapeHtml(t("panel.detailsKicker"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t(current ? "population.panelCurrentExplanation" : "population.panelModelExplanation"))}</p>
            <p><strong>${escapeHtml(t("population.densityMetric"))}:</strong> ${escapeHtml(t("population.densityExplanation"))}</p>
            <p><strong>${escapeHtml(t("population.areaMetric"))}:</strong> ${escapeHtml(t("population.areaExplanation"))}</p>
          </div>
        </details>` : ""}
        <details class="detail-accordion methodology-accordion" data-section="population-methodology">
          <summary data-focus-key="population-methodology-summary"><span>${escapeHtml(t("population.methodologyTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t(current ? "population.methodologyCurrent" : "population.methodologyModel"))}</p>
            <p>${escapeHtml(t(current ? "population.derivedCurrent" : "population.derivedModel"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("population.comparisonWarning"))}</p>
            ${sourceUrl ? `<p><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(dataset.source.name)}</a></p>` : ""}
          </div>
        </details>
      </div>
    </article>`;
}

function packedPixelPoints(values) {
  return ArrayBuffer.isView(values) && !(values instanceof DataView);
}

function pixelPointCount(values) {
  return packedPixelPoints(values) ? Math.floor(values.length / 2) : values?.length ?? 0;
}

function sealedScatterBounds(model) {
  const values = model.pixelPoints ?? model.points?.map((point) => [point[model.xKey], point[model.yKey]]) ?? [];
  let xRawMinimum = Infinity;
  let xRawMaximum = -Infinity;
  let yMinimumValue = Infinity;
  let yMaximumValue = -Infinity;
  if (packedPixelPoints(values)) {
    for (let index = 0; index < values.length; index += 2) {
      xRawMinimum = Math.min(xRawMinimum, values[index]);
      xRawMaximum = Math.max(xRawMaximum, values[index]);
      yMinimumValue = Math.min(yMinimumValue, values[index + 1]);
      yMaximumValue = Math.max(yMaximumValue, values[index + 1]);
    }
  } else {
    values.forEach(([xValue, yValue]) => {
      if (Number.isFinite(xValue)) { xRawMinimum = Math.min(xRawMinimum, xValue); xRawMaximum = Math.max(xRawMaximum, xValue); }
      if (Number.isFinite(yValue)) { yMinimumValue = Math.min(yMinimumValue, yValue); yMaximumValue = Math.max(yMaximumValue, yValue); }
    });
  }
  if (!Number.isFinite(xRawMinimum)) { xRawMinimum = 0; xRawMaximum = 1; }
  const xPadding = model.xKey === "density" ? 0 : Math.max(1, (xRawMaximum - xRawMinimum) * .06);
  const xMinimum = model.xKey === "density" ? 0 : Math.floor((xRawMinimum - xPadding) / 1000) * 1000;
  const xMaximum = model.xKey === "density" ? 100 : Math.ceil((xRawMaximum + xPadding) / 1000) * 1000;
  const yRawMinimum = model.yKey === "density" ? 0 : (Number.isFinite(yMinimumValue) ? yMinimumValue : 15);
  const yRawMaximum = model.yKey === "density" ? 100 : (Number.isFinite(yMaximumValue) ? yMaximumValue : 50);
  const yPadding = model.yKey === "temperature" ? Math.max(1, (yRawMaximum - yRawMinimum) * .06) : 0;
  return {
    xMinimum, xMaximum,
    yMinimum: model.yKey === "density" ? 0 : Math.floor(yRawMinimum - yPadding),
    yMaximum: model.yKey === "density" ? 100 : Math.ceil(yRawMaximum + yPadding),
  };
}

function sealedScatterValue(value, key) {
  if (key === "income") return formatCurrency(value);
  if (key === "temperature") return `${formatNumber(value, 1)} °C`;
  return `${formatNumber(value, 1)}%`;
}

function sealedScatterPointLabel(model, point) {
  return `${point.sectorName} (${point.sectorId}), ${point.municipality}: ${sealedScatterValue(point[model.xKey], model.xKey)} · ${sealedScatterValue(point[model.yKey], model.yKey)}`;
}

function sealedUrbanScatterChart(model, { expanded = false, showExpand = true, dialogTarget = null } = {}) {
  const pixel = Array.isArray(model.pixelPoints) || packedPixelPoints(model.pixelPoints);
  const points = pixel ? model.pixelPoints : model.points;
  const bounds = sealedScatterBounds(model);
  const width = expanded ? 1100 : 440;
  const height = expanded ? 650 : 410;
  const plot = expanded
    ? { left: 132, top: 48, width: 900, height: 430 }
    : { left: 74, top: 36, width: 336, height: 250 };
  const x = (value) => plot.left + (value - bounds.xMinimum) / Math.max(1e-9, bounds.xMaximum - bounds.xMinimum) * plot.width;
  const y = (value) => plot.top + plot.height - (value - bounds.yMinimum) / Math.max(1e-9, bounds.yMaximum - bounds.yMinimum) * plot.height;
  const xTicks = Array.from({ length: 5 }, (_, index) => bounds.xMinimum + (bounds.xMaximum - bounds.xMinimum) / 4 * index);
  const yTicks = Array.from({ length: 6 }, (_, index) => bounds.yMinimum + (bounds.yMaximum - bounds.yMinimum) / 5 * index);
  const regression = model.regression;
  const line = regression ? {
    x1: bounds.xMinimum,
    y1: regression.intercept + regression.slope * bounds.xMinimum,
    x2: bounds.xMaximum,
    y2: regression.intercept + regression.slope * bounds.xMaximum,
  } : null;
  const prefix = `${model.comparisonId}-${expanded ? "expanded" : "inline"}`;
  const initial = !pixel ? points.find(({ sectorId }) => sectorId === model.highlightedSectorId) ?? points[0] : null;
  return `<div class="sealed-urban-scatter ${expanded ? "is-expanded" : ""}" data-sector-comparison-chart>
    ${expanded || !showExpand ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart${dialogTarget ? ` data-dialog-target="${escapeHtml(dialogTarget)}"` : ""} aria-label="${escapeHtml(t("chart.expandNamed", { chart: model.title }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <div class="sealed-scatter-stage">
      ${pixel ? `<canvas width="${width}" height="${height}" data-pixel-scatter-canvas data-pixel-scatter-source="${model.comparisonId === "landsat-jaarbak-density" ? "densityScatter" : "pixelPoints"}"
        data-comparison-id="${escapeHtml(model.comparisonId)}"
        data-plot-left="${plot.left}" data-plot-top="${plot.top}" data-plot-width="${plot.width}" data-plot-height="${plot.height}"
        data-x-min="${bounds.xMinimum}" data-x-max="${bounds.xMaximum}" data-y-min="${bounds.yMinimum}" data-y-max="${bounds.yMaximum}" aria-hidden="true"></canvas>` : ""}
      <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
        <title id="${prefix}-title">${escapeHtml(model.title)}</title>
        <desc id="${prefix}-description">${escapeHtml(t("sealedUrban.chartDescription", { count: pixelPointCount(points), area: panelAreaName(model.record) }))}</desc>
        <g class="sealed-scatter-grid" aria-hidden="true">
          ${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}
        </g>
        ${pixel ? `<rect class="sealed-scatter-hitarea" data-pixel-scatter-hit x="${plot.left}" y="${plot.top}" width="${plot.width}" height="${plot.height}" tabindex="0" aria-label="${escapeHtml(t("sealedUrban.keyboardInstructions"))}"></rect>` : ""}
        ${line ? `<line class="sealed-scatter-regression" x1="${x(line.x1)}" y1="${y(line.y1)}" x2="${x(line.x2)}" y2="${y(line.y2)}"></line>` : ""}
        ${pixel ? "" : `<g class="sealed-scatter-points" role="group" aria-label="${escapeHtml(model.title)}">${points.map((point, index) => {
          const label = sealedScatterPointLabel(model, point);
          const highlighted = point.sectorId === model.highlightedSectorId;
          return `<circle cx="${x(point[model.xKey]).toFixed(2)}" cy="${y(point[model.yKey]).toFixed(2)}" r="5" role="button" tabindex="${highlighted || (!model.highlightedSectorId && index === 0) ? 0 : -1}" class="sealed-scatter-point ${highlighted ? "is-selected" : ""}" data-scatter-sector="${escapeHtml(point.sectorId)}" data-scatter-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></circle>`;
        }).join("")}</g>`}
        <g class="sealed-scatter-axis-values" aria-hidden="true">
          ${xTicks.map((value) => `<text x="${x(value)}" y="${plot.top + plot.height + 31}" text-anchor="middle">${escapeHtml(model.xKey === "income" ? compactEuroTick(value) : `${formatNumber(value, 0)}%`)}</text>`).join("")}
          ${yTicks.map((value) => `<text x="${plot.left - 14}" y="${y(value) + 5}" text-anchor="end">${escapeHtml(model.yKey === "temperature" ? formatNumber(value, 0) : `${formatNumber(value, 0)}%`)}</text>`).join("")}
        </g>
        <text class="sealed-scatter-axis-label" x="${plot.left + plot.width / 2}" y="${height - 26}" text-anchor="middle">${escapeHtml(model.xLabel)}</text>
        <text class="sealed-scatter-axis-label" transform="translate(30 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(model.yLabel)}</text>
      </svg>
    </div>
    <p class="sealed-scatter-output" data-scatter-output aria-live="polite">${escapeHtml(pixel
      ? t("sealedUrban.pixelReadout", { count: formatNumber(pixelPointCount(points), 0) })
      : initial ? sealedScatterPointLabel(model, initial) : t("sealedUrban.noComparableValue"))}</p>
  </div>`;
}

function incomeOutcomeBoxChart(model, { expanded = false, showExpand = true } = {}) {
  if (!model.incomeBoxKind) return "";
  const summaries = model.incomeCategories?.sectors;
  const categories = [
    { id: "low", symbol: "€", color: "#4c7a89" },
    { id: "middle", symbol: "€€", color: "#7554a3" },
    { id: "high", symbol: "€€€", color: "#9b3c62" },
  ].map((category) => ({ ...category, summary: summaries?.[category.id] }))
    .filter(({ summary }) => summary && summary.count >= 5);
  const key = model.incomeBoxKind === "temperature" ? "landsatIncome"
    : model.incomeBoxKind === "green" ? "greenIncome" : "soilIncome";
  if (!categories.length) return `<p class="panel-empty-state">${escapeHtml(t(`${key}.categoryUnavailable`))}</p>`;
  const width = expanded ? 980 : 440;
  const height = expanded ? 560 : 350;
  const plot = expanded ? { left: 104, top: 30, width: 820, height: 390 } : { left: 72, top: 24, width: 338, height: 220 };
  const values = categories.flatMap(({ summary }) => [summary.whiskerLow, summary.whiskerHigh]);
  const low = Math.floor(Math.min(...values) - 1);
  const high = Math.ceil(Math.max(...values) + 1);
  const x = (index) => plot.left + plot.width * (index + .5) / categories.length;
  const y = (value) => plot.top + plot.height - (value - low) / Math.max(1, high - low) * plot.height;
  const boxWidth = Math.min(expanded ? 100 : 56, plot.width / categories.length * .42);
  const yTicks = Array.from({ length: 5 }, (_, index) => low + (high - low) * index / 4);
  const title = t(`${key}.sectorBoxesTitle`);
  const unit = model.incomeBoxKind === "temperature" ? "°C" : "%";
  const valueKey = model.yKey;
  return `<div class="income-temperature-box-chart ${expanded ? "is-expanded" : ""}" data-income-box-chart>
    ${expanded || !showExpand ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="${escapeHtml(model.comparisonId)}-income-boxes" aria-label="${escapeHtml(t("chart.expandNamed", { chart: title }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <h4>${escapeHtml(title)}</h4>
    <p>${escapeHtml(t(`${key}.sectorBoxesIntro`))}</p>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
      <g class="green-population-grid">${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}</g>
      ${categories.map(({ summary, symbol, color }, index) => {
        const centre = x(index);
        const categoryId = symbol.length === 1 ? "low" : symbol.length === 2 ? "middle" : "high";
        const sectorDots = model.points.filter((point) => {
          const id = point.income < 30_000 ? "low" : point.income < 40_000 ? "middle" : "high";
          return id === categoryId;
        });
        const label = t(`${key}.categoryReadout`, { category: symbol, count: summary.count,
          mean: formatNumber(summary.mean, 1), median: formatNumber(summary.median, 1),
          q1: formatNumber(summary.q1, 1), q3: formatNumber(summary.q3, 1) });
        return `<g role="button" tabindex="${index === 0 ? 0 : -1}" data-income-box-group data-box-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
          <line class="heat-population-whisker" x1="${centre}" x2="${centre}" y1="${y(summary.whiskerLow)}" y2="${y(summary.whiskerHigh)}"></line>
          <rect x="${centre - boxWidth / 2}" y="${y(summary.q3)}" width="${boxWidth}" height="${Math.max(2, y(summary.q1) - y(summary.q3))}" fill="${color}" opacity=".78"></rect>
          <line class="heat-population-median" x1="${centre - boxWidth / 2}" x2="${centre + boxWidth / 2}" y1="${y(summary.median)}" y2="${y(summary.median)}"></line>
          <circle cx="${centre}" cy="${y(summary.mean)}" r="5" fill="#fff" stroke="${color}" stroke-width="3"></circle>
          ${sectorDots.map((point, dotIndex) => `<circle cx="${centre + ((dotIndex % 7) - 3) * 2.8}" cy="${y(point[valueKey])}" r="2.3" fill="#173f49" opacity=".58"><title>${escapeHtml(`${point.sectorName}: ${formatNumber(point[valueKey], 1)}${unit}`)}</title></circle>`).join("")}
        </g>`;
      }).join("")}
      <g class="green-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 12}" y="${y(value) + 5}" text-anchor="end">${escapeHtml(formatNumber(value, 1))}${unit}</text>`).join("")}
        ${categories.map(({ summary, symbol }, index) => `<text x="${x(index)}" y="${plot.top + plot.height + 27}" text-anchor="middle"><tspan x="${x(index)}">${symbol}</tspan><tspan x="${x(index)}" dy="17">n=${summary.count}</tspan></text>`).join("")}
      </g>
      <text class="green-population-axis-label" x="${plot.left + plot.width / 2}" y="${height - 18}" text-anchor="middle">${escapeHtml(t("landsatIncome.axisCategory"))}</text>
      <text class="green-population-axis-label" transform="translate(29 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(model.yLabel)}</text>
    </svg>
    <p class="sealed-scatter-output" data-income-box-output aria-live="polite">${escapeHtml(t(`${key}.categoryReadout`, {
      category: categories[0].symbol, count: categories[0].summary.count,
      mean: formatNumber(categories[0].summary.mean, 1), median: formatNumber(categories[0].summary.median, 1),
      q1: formatNumber(categories[0].summary.q1, 1), q3: formatNumber(categories[0].summary.q3, 1),
    }))}</p>
  </div>`;
}

function sealedUrbanScatterDialog(model) {
  const regression = model.regression;
  const inference = regression?.inference;
  const inferenceReason = t(`sealedUrban.inferenceStatus.${inference?.status ?? "missing"}`);
  const unavailableInference = t("sealedUrban.notReportableWithReason", { reason: inferenceReason });
  const pValue = inference?.status === "available" && Number.isFinite(inference.pValue)
    ? inference.pValue < .001 ? "p < 0.001" : `p = ${formatNumber(inference.pValue, 3)}`
    : unavailableInference;
  const effectiveSample = Number.isFinite(inference?.effectiveSampleSize)
    ? formatNumber(inference.effectiveSampleSize, 1) : unavailableInference;
  const count = pixelPointCount(model.pixelPoints ?? model.points ?? []);
  const analysedArea = regression?.analysedAreaHa ?? (model.pixelPoints ? count * .09 : null);
  const dialogId = `${model.comparisonId}-scatter`;
  return `<dialog class="comparison-chart-dialog sealed-scatter-dialog" data-comparison-chart-dialog data-chart-dialog-id="${escapeHtml(dialogId)}" aria-label="${escapeHtml(model.title)}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(model.title)}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("sealedUrban.closeChart"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(model.expandedDescription ?? t("sealedUrban.expandedDescription", { area: panelAreaName(model.record) }))}</p>
      ${sealedUrbanScatterChart(model, { expanded: true })}
      ${regression ? `<div class="summary-grid sealed-regression-grid comparison-chart-summary">
        ${metricCard("sealedUrban.sample", formatNumber(regression.n ?? regression.count ?? count, 0), "#315e66")}
        ${Number.isFinite(analysedArea) ? metricCard(
          model.areaLabelKey ?? (model.pixelPoints ? "soilComparison.nominalObservedArea" : "sealedUrban.eligibleArea"),
          t("unit.hectares", { value: formatNumber(analysedArea, 1) }), "#176b43",
        ) : ""}
        ${metricCard("sealedUrban.rSquared", regression.rSquared == null ? t("value.notAvailable") : formatNumber(regression.rSquared, 3), "#6d4ca0")}
        ${metricCard("sealedUrban.pearsonR", regression.pearsonR == null ? t("value.notAvailable") : formatNumber(regression.pearsonR, 3), "#315e66")}
        ${metricCard("sealedUrban.spearmanRho", regression.spearmanRho == null ? t("value.notAvailable") : formatNumber(regression.spearmanRho, 3), "#176b43")}
        ${metricCard("sealedUrban.spatialPValue", pValue, "#6d4ca0")}
        ${metricCard("sealedUrban.effectiveSpatialSample", effectiveSample, "#315e66")}
        ${metricCard("sealedUrban.slope", `${formatNumber(regression.slope * (model.slopeScale ?? 1), 3)} ${model.slopeUnit ?? ""}`.trim(), "#8f1d2c")}
        ${model.yKey === "temperature" ? metricCard("soilComparison.intercept", `${formatNumber(regression.intercept, 2)} °C`, "#53666b") : ""}
        ${model.secondaryYear ? metricCard("soilComparison.matchedDensityYear", String(model.secondaryYear), "#53666b") : ""}
      </div>` : ""}
      ${regression ? `<p class="comparison-academic-note comparison-spatial-inference-note">${escapeHtml(t("sealedUrban.expandedSpatialAdjustment"))}</p>` : ""}
      ${regression ? `<p class="comparison-academic-note">${escapeHtml(t("sealedUrban.expandedStatisticsDefinition"))}</p>` : ""}
      <p class="comparison-academic-note">${escapeHtml(model.caveat)}</p>
    </div>
  </dialog>`;
}

function incomeOutcomeBoxDialog(model) {
  if (!model.incomeBoxKind) return "";
  const key = model.incomeBoxKind === "temperature" ? "landsatIncome"
    : model.incomeBoxKind === "green" ? "greenIncome" : "soilIncome";
  return `<dialog class="comparison-chart-dialog sealed-scatter-dialog" data-comparison-chart-dialog data-chart-dialog-id="${escapeHtml(model.comparisonId)}-income-boxes" aria-label="${escapeHtml(t(`${key}.sectorBoxesTitle`))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t(`${key}.sectorBoxesTitle`))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("sealedUrban.closeChart"))}">&times;</button></header>
      ${incomeOutcomeBoxChart(model, { expanded: true })}
    </div>
  </dialog>`;
}

function renderSealedUrbanScatter(model) {
  const regression = model.regression;
  const count = model.pixelPoints ? pixelPointCount(model.pixelPoints) : model.points.length;
  return `<div class="panel-hero comparison-hero sealed-urban-hero">
    <p class="panel-eyebrow">${escapeHtml(t("sealedUrban.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(model.title)}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("sealedUrban.sampleCount", { count: formatNumber(count, 0) }))}</p>
  </div>
  <div class="panel-body comparison-body sealed-urban-body">
    <section aria-labelledby="sealed-scatter-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("sealedUrban.analysis"))}</p><h3 id="sealed-scatter-title">${escapeHtml(model.title)}</h3></div>
      ${sealedUrbanScatterChart(model, { dialogTarget: model.incomeBoxKind ? `${model.comparisonId}-scatter` : null })}
      ${incomeOutcomeBoxChart(model)}
      ${sealedUrbanScatterDialog(model)}
      ${incomeOutcomeBoxDialog(model)}
      <div class="summary-grid sealed-regression-grid">
        ${metricCard("sealedUrban.slope", regression ? `${formatNumber(regression.slope * model.slopeScale, 3)} ${model.slopeUnit}` : t("value.notAvailable"), "#8f1d2c")}
      </div>
    </section>
    <details class="detail-accordion" data-section="sealed-scatter-details">
      <summary data-focus-key="sealed-scatter-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("sealedUrban.detailsTitle"))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(model.definition)}</p>${model.selectedClassLabels?.length ? `<p>${escapeHtml(t("sealedUrban.selectedClasses", { classes: model.selectedClassLabels.join(", ") }))}</p>` : ""}<p>${escapeHtml(t("sealedUrban.olsDefinition"))}</p></div>
    </details>
    <details class="detail-accordion methodology-accordion" data-section="sealed-scatter-methodology">
      <summary data-focus-key="sealed-scatter-methodology-summary"><span>${escapeHtml(t("sealedUrban.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(model.methodology)}</p><p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(model.caveat)}</p></div>
    </details>
  </div>`;
}

function percentagePopulationCurveLabel(point, model) {
  return t(`${model.copyPrefix}.cumulativeReadout`, {
    value: formatNumber(point.value, 1),
    selected: formatNumber(point.selectedResidents, 0),
    selectedShare: formatNumber(point.selectedShare, 1),
    remaining: formatNumber(point.remainingResidents, 0),
    remainingShare: formatNumber(point.remainingShare, 1),
    interval: `${formatNumber(point.intervalLower, 0)}–${formatNumber(point.intervalUpper, 0)}%`,
    intervalResidents: formatNumber(point.intervalResidents, 0),
    cells: formatNumber(point.intervalCellCount, 0),
  });
}

function percentagePopulationCumulativeChart(model, { expanded = false } = {}) {
  if (!model.curve?.length || !model.totalResidents) return `<p class="panel-empty-state">${escapeHtml(t("sealedUrban.noComparableValue"))}</p>`;
  const width = expanded ? 1100 : 440;
  const height = expanded ? 650 : 430;
  const plot = expanded ? { left: 112, top: 38, width: 920, height: 455 }
    : { left: 78, top: 28, width: 330, height: 270 };
  const x = (value) => plot.left + value / model.totalResidents * plot.width;
  const y = (value) => plot.top + plot.height - value / 100 * plot.height;
  const yTicks = [0, 25, 50, 75, 100];
  const xTicks = Array.from({ length: 5 }, (_, index) => model.totalResidents * index / 4);
  let path = `M ${plot.left} ${y(model.curve[0].value)}`;
  model.curve.forEach((point, index) => {
    path += ` H ${x(point.cumulativeResidents)}`;
    if (model.curve[index + 1]) path += ` V ${y(model.curve[index + 1].value)}`;
  });
  const dialogId = `${model.comparisonId}-cumulative`;
  const prefix = `${dialogId}-${expanded ? "expanded" : "inline"}`;
  return `<div class="green-population-chart percentage-population-chart ${model.copyPrefix === "greenPopulation" ? "is-green-profile" : "is-soil-profile"} ${expanded ? "is-expanded" : ""}" data-green-population-chart>
    ${expanded ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="${dialogId}" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t(`${model.copyPrefix}.cumulativeTitle`) }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description" data-cumulative-population-plot data-plot-left="${plot.left}" data-plot-right="${plot.left + plot.width}">
      <title id="${prefix}-title">${escapeHtml(t(`${model.copyPrefix}.cumulativeTitle`))}</title>
      <desc id="${prefix}-description">${escapeHtml(t(`${model.copyPrefix}.cumulativeDescription`, { area: panelAreaName(model.record), residents: formatNumber(model.totalResidents, 0) }))}</desc>
      <g class="green-population-grid" aria-hidden="true">${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}</g>
      <path class="population-temperature-step" d="${path}"></path>
      <line class="population-temperature-guide" data-population-temperature-guide x1="${plot.left}" x2="${plot.left}" y1="${plot.top}" y2="${plot.top + plot.height}" hidden></line>
      <g class="population-temperature-hit-points">${model.curve.map((point, index) => {
        const start = index ? model.curve[index - 1].cumulativeResidents : 0;
        const label = percentagePopulationCurveLabel(point, model);
        return `<rect role="button" tabindex="${index === 0 ? 0 : -1}" data-green-population-group data-guide-x="${x(point.cumulativeResidents)}" data-box-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" x="${x(start)}" y="${plot.top}" width="${Math.max(.01, x(point.cumulativeResidents) - x(start))}" height="${plot.height}"></rect>`;
      }).join("")}</g>
      <g class="green-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 13}" y="${y(value) + 5}" text-anchor="end">${value}%</text>`).join("")}
        ${xTicks.map((value) => `<text x="${x(value)}" y="${plot.top + plot.height + 27}" text-anchor="middle">${escapeHtml(formatNumber(value, 0))}</text>`).join("")}
      </g>
      <text class="green-population-axis-label" x="${plot.left + plot.width / 2}" y="${height - 20}" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisCumulativeResidents"))}</text>
      <text class="green-population-axis-label" transform="translate(27 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t(`${model.copyPrefix}.axisValue`))}</text>
    </svg>
    <p class="green-population-output" data-green-population-output aria-live="polite">${escapeHtml(percentagePopulationCurveLabel(model.curve[0], model))}</p>
  </div>`;
}

function percentagePopulationHistogramLabel(bin, model) {
  return t(`${model.copyPrefix}.histogramReadout`, {
    interval: `${formatNumber(bin.lower, 0)}–${formatNumber(bin.upper, 0)}%`,
    residents: formatNumber(bin.residents, 0), share: formatNumber(bin.share, 1),
    represented: formatNumber(model.totalResidents, 0), cells: formatNumber(bin.cellCount, 0),
  });
}

function percentagePopulationHistogram(model, { expanded = false } = {}) {
  if (!model.bins?.length || !model.totalResidents) return `<p class="panel-empty-state">${escapeHtml(t("sealedUrban.noComparableValue"))}</p>`;
  const width = expanded ? 1100 : 440;
  const height = expanded ? 650 : 430;
  const plot = expanded ? { left: 112, top: 38, width: 920, height: 455 }
    : { left: 82, top: 28, width: 326, height: 270 };
  const maximum = Math.max(1, ...model.bins.map(({ residents }) => residents));
  const x = (index) => plot.left + plot.width * index / model.bins.length;
  const y = (value) => plot.top + plot.height - value / maximum * plot.height;
  const barWidth = Math.max(2, plot.width / model.bins.length - 2);
  const yTicks = Array.from({ length: 5 }, (_, index) => maximum * index / 4);
  const tickStep = expanded ? 2 : 4;
  const dialogId = `${model.comparisonId}-histogram`;
  const prefix = `${dialogId}-${expanded ? "expanded" : "inline"}`;
  return `<div class="green-population-chart percentage-population-chart ${model.copyPrefix === "greenPopulation" ? "is-green-profile" : "is-soil-profile"} ${expanded ? "is-expanded" : ""}" data-green-population-chart>
    ${expanded ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="${dialogId}" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t(`${model.copyPrefix}.histogramTitle`) }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t(`${model.copyPrefix}.histogramTitle`))}</title>
      <desc id="${prefix}-description">${escapeHtml(t(`${model.copyPrefix}.histogramDescription`, { area: panelAreaName(model.record), residents: formatNumber(model.totalResidents, 0) }))}</desc>
      <g class="green-population-grid" aria-hidden="true">${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}</g>
      <g class="population-temperature-bars">${model.bins.map((bin, index) => `<rect role="button" tabindex="${index === 0 ? 0 : -1}" data-green-population-group data-box-label="${escapeHtml(percentagePopulationHistogramLabel(bin, model))}" aria-label="${escapeHtml(percentagePopulationHistogramLabel(bin, model))}" x="${x(index) + 1}" y="${y(bin.residents)}" width="${barWidth}" height="${Math.max(2, y(0) - y(bin.residents))}"></rect>`).join("")}</g>
      <g class="green-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 13}" y="${y(value) + 5}" text-anchor="end">${escapeHtml(formatNumber(value, 0))}</text>`).join("")}
        ${model.bins.map((bin, index) => index % tickStep === 0 ? `<text x="${x(index) + barWidth / 2}" y="${plot.top + plot.height + 27}" text-anchor="middle">${escapeHtml(formatNumber(bin.lower, 0))}%</text>` : "").join("")}
      </g>
      <text class="green-population-axis-label" x="${plot.left + plot.width / 2}" y="${height - 20}" text-anchor="middle">${escapeHtml(t(`${model.copyPrefix}.axisIntervals`))}</text>
      <text class="green-population-axis-label" transform="translate(27 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisResidents"))}</text>
    </svg>
    <p class="green-population-output" data-green-population-output aria-live="polite">${escapeHtml(percentagePopulationHistogramLabel(model.bins.find(({ residents }) => residents > 0) ?? model.bins[0], model))}</p>
  </div>`;
}

function percentagePopulationDialog(model, kind) {
  const cumulative = kind === "cumulative";
  return `<dialog class="comparison-chart-dialog green-population-dialog" data-comparison-chart-dialog data-chart-dialog-id="${escapeHtml(model.comparisonId)}-${kind}" aria-label="${escapeHtml(t(`${model.copyPrefix}.${cumulative ? "cumulativeExpandedTitle" : "histogramExpandedTitle"}`, { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t(`${model.copyPrefix}.${cumulative ? "cumulativeExpandedTitle" : "histogramExpandedTitle"}`, { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("greenPopulation.closeChart"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t(`${model.copyPrefix}.expandedContext`, { residents: formatNumber(model.totalResidents, 0), area: panelAreaName(model.record) }))}</p>
      ${cumulative ? percentagePopulationCumulativeChart(model, { expanded: true }) : percentagePopulationHistogram(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t(`${model.copyPrefix}.academicNote`))}</p>
    </div>
  </dialog>`;
}

function renderPercentagePopulationComparison(model) {
  return `<div class="panel-hero comparison-hero green-population-hero">
    <p class="panel-eyebrow">${escapeHtml(t(`${model.copyPrefix}.heroKicker`))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(t(`${model.copyPrefix}.title`))}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t(`${model.copyPrefix}.sampleCount`, { count: model.points.length }))}</p>
  </div>
  <div class="panel-body comparison-body green-population-body">
    <section aria-labelledby="green-population-chart-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t(`${model.copyPrefix}.analysis`))}</p><h3 id="green-population-chart-title">${escapeHtml(t(`${model.copyPrefix}.cumulativeTitle`))}</h3></div>
      <p>${escapeHtml(t(`${model.copyPrefix}.inlineIntro`, { residents: formatNumber(model.totalResidents, 0), cells: formatNumber(model.points.length, 0) }))}</p>
      ${percentagePopulationCumulativeChart(model)}
      ${percentagePopulationDialog(model, "cumulative")}
      <div class="section-heading comparison-secondary-heading"><h3>${escapeHtml(t(`${model.copyPrefix}.histogramTitle`))}</h3></div>
      ${percentagePopulationHistogram(model)}
      ${percentagePopulationDialog(model, "histogram")}
      <div class="summary-grid sealed-regression-grid">
        ${metricCard(`${model.copyPrefix}.mean`, model.weightedMean == null ? t("value.notAvailable") : `${formatNumber(model.weightedMean, 1)}%`, model.copyPrefix === "greenPopulation" ? "#176b43" : "#a50f15")}
      </div>
    </section>
    <details class="detail-accordion" data-section="green-population-details">
      <summary data-focus-key="green-population-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t(`${model.copyPrefix}.detailsTitle`))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(t(`${model.copyPrefix}.definition`))}</p>${model.selectedClassLabels?.length ? `<p>${escapeHtml(t("greenPopulation.selectedClasses", { classes: model.selectedClassLabels.join(", ") }))}</p>` : ""}<p>${escapeHtml(t(`${model.copyPrefix}.residentWeighting`))}</p><p>${escapeHtml(t(`${model.copyPrefix}.zeroPopulation`, { count: model.zeroPopulationCount }))}</p></div>
    </details>
    <details class="detail-accordion methodology-accordion" data-section="green-population-methodology">
      <summary data-focus-key="green-population-methodology-summary"><span>${escapeHtml(t(`${model.copyPrefix}.methodologyTitle`))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(t(`${model.copyPrefix}.methodology`))}</p><p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t(`${model.copyPrefix}.academicNote`))}</p></div>
    </details>
  </div>`;
}

function landsatPopulationCurveLabel(point) {
  return t("landsatPopulation.cumulativeReadout", {
    temperature: formatNumber(point.temperature, 1),
    above: formatNumber(point.atOrAboveResidents, 0),
    aboveShare: formatNumber(point.atOrAboveShare, 1),
    below: formatNumber(point.coolerResidents, 0),
    belowShare: formatNumber(point.coolerShare, 1),
    interval: `${formatNumber(point.intervalLower, 1)}–${formatNumber(point.intervalUpper, 1)}°C`,
    intervalResidents: formatNumber(point.intervalResidents, 0),
    measurements: formatNumber(point.contributingCount, 0),
    cells: formatNumber(point.intervalCellCount, 0),
  });
}

function landsatPopulationCumulativeChart(model, { expanded = false } = {}) {
  if (!model.curve?.length || !model.totalResidents) return `<p class="panel-empty-state">${escapeHtml(t("sealedUrban.noComparableValue"))}</p>`;
  const width = expanded ? 1100 : 440;
  const height = expanded ? 650 : 430;
  const plot = expanded ? { left: 112, top: 38, width: 920, height: 455 }
    : { left: 78, top: 28, width: 330, height: 270 };
  const low = Math.floor(model.temperatureMinimum - 1);
  const high = Math.ceil(model.temperatureMaximum + 1);
  const x = (value) => plot.left + value / model.totalResidents * plot.width;
  const y = (value) => plot.top + plot.height - (value - low) / Math.max(1, high - low) * plot.height;
  const yTicks = Array.from({ length: 5 }, (_, index) => low + (high - low) * index / 4);
  const xTicks = Array.from({ length: 5 }, (_, index) => model.totalResidents * index / 4);
  let path = `M ${plot.left} ${y(model.curve[0].temperature)}`;
  model.curve.forEach((point, index) => {
    path += ` H ${x(point.cumulativeResidents)}`;
    if (model.curve[index + 1]) path += ` V ${y(model.curve[index + 1].temperature)}`;
  });
  const prefix = `landsat-population-cumulative-${expanded ? "expanded" : "inline"}`;
  return `<div class="green-population-chart landsat-population-chart ${expanded ? "is-expanded" : ""}" data-green-population-chart>
    ${expanded ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="landsat-population-cumulative" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("landsatPopulation.cumulativeTitle") }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description" data-cumulative-population-plot data-plot-left="${plot.left}" data-plot-right="${plot.left + plot.width}">
      <title id="${prefix}-title">${escapeHtml(t("landsatPopulation.cumulativeTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("landsatPopulation.cumulativeDescription", { area: panelAreaName(model.record), residents: formatNumber(model.totalResidents, 0) }))}</desc>
      <g class="green-population-grid" aria-hidden="true">${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}</g>
      <path class="population-temperature-step" d="${path}"></path>
      <line class="population-temperature-guide" data-population-temperature-guide x1="${plot.left}" x2="${plot.left}" y1="${plot.top}" y2="${plot.top + plot.height}" hidden></line>
      <g class="population-temperature-hit-points">${model.curve.map((point, index) => {
        const start = index ? model.curve[index - 1].cumulativeResidents : 0;
        return `<rect role="button" tabindex="${index === 0 ? 0 : -1}" data-green-population-group data-guide-x="${x(point.cumulativeResidents)}" data-box-label="${escapeHtml(landsatPopulationCurveLabel(point))}" aria-label="${escapeHtml(landsatPopulationCurveLabel(point))}" x="${x(start)}" y="${plot.top}" width="${Math.max(.01, x(point.cumulativeResidents) - x(start))}" height="${plot.height}"></rect>`;
      }).join("")}</g>
      <g class="green-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 13}" y="${y(value) + 5}" text-anchor="end">${escapeHtml(formatNumber(value, 1))}°C</text>`).join("")}
        ${xTicks.map((value) => `<text x="${x(value)}" y="${plot.top + plot.height + 27}" text-anchor="middle">${escapeHtml(formatNumber(value, 0))}</text>`).join("")}
      </g>
      <text class="green-population-axis-label" x="${plot.left + plot.width / 2}" y="${height - 20}" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisCumulativeResidents"))}</text>
      <text class="green-population-axis-label" transform="translate(27 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisTemperature"))}</text>
    </svg>
    <p class="green-population-output" data-green-population-output aria-live="polite">${escapeHtml(landsatPopulationCurveLabel(model.curve[0]))}</p>
  </div>`;
}

function landsatPopulationHistogramLabel(bin, model) {
  return t("landsatPopulation.histogramReadout", {
    interval: `${formatNumber(bin.lower, 1)}–${formatNumber(bin.upper, 1)}°C`,
    residents: formatNumber(bin.residents, 0), share: formatNumber(bin.share, 1),
    cells: formatNumber(bin.cellCount, 0), measurements: formatNumber(bin.contributingCount, 0),
    represented: formatNumber(model.totalResidents, 0),
  });
}

function landsatPopulationHistogram(model, { expanded = false } = {}) {
  if (!model.bins?.length) return `<p class="panel-empty-state">${escapeHtml(t("sealedUrban.noComparableValue"))}</p>`;
  const width = expanded ? 1100 : 440;
  const height = expanded ? 650 : 430;
  const plot = expanded ? { left: 112, top: 38, width: 920, height: 455 }
    : { left: 82, top: 28, width: 326, height: 270 };
  const maximum = Math.max(...model.bins.map(({ residents }) => residents));
  const x = (index) => plot.left + plot.width * index / model.bins.length;
  const y = (value) => plot.top + plot.height - value / Math.max(1, maximum) * plot.height;
  const barWidth = Math.max(2, plot.width / model.bins.length - 2);
  const yTicks = Array.from({ length: 5 }, (_, index) => maximum * index / 4);
  const tickStep = Math.max(1, Math.ceil(model.bins.length / (expanded ? 9 : 5)));
  const prefix = `landsat-population-histogram-${expanded ? "expanded" : "inline"}`;
  return `<div class="green-population-chart landsat-population-chart ${expanded ? "is-expanded" : ""}" data-green-population-chart>
    ${expanded ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="landsat-population-histogram" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("landsatPopulation.histogramTitle") }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("landsatPopulation.histogramTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("landsatPopulation.histogramDescription", { area: panelAreaName(model.record), residents: formatNumber(model.totalResidents, 0) }))}</desc>
      <g class="green-population-grid" aria-hidden="true">${yTicks.map((value) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(value)}" y2="${y(value)}"></line>`).join("")}</g>
      <g class="population-temperature-bars">${model.bins.map((bin, index) => `<rect role="button" tabindex="${index === 0 ? 0 : -1}" data-green-population-group data-box-label="${escapeHtml(landsatPopulationHistogramLabel(bin, model))}" aria-label="${escapeHtml(landsatPopulationHistogramLabel(bin, model))}" x="${x(index) + 1}" y="${y(bin.residents)}" width="${barWidth}" height="${Math.max(2, y(0) - y(bin.residents))}"></rect>`).join("")}</g>
      <g class="green-population-axis-values" aria-hidden="true">
        ${yTicks.map((value) => `<text x="${plot.left - 13}" y="${y(value) + 5}" text-anchor="end">${escapeHtml(formatNumber(value, 0))}</text>`).join("")}
        ${model.bins.map((bin, index) => index % tickStep === 0 ? `<text x="${x(index) + barWidth / 2}" y="${plot.top + plot.height + 27}" text-anchor="middle">${escapeHtml(formatNumber(bin.lower, 1))}°</text>` : "").join("")}
      </g>
      <text class="green-population-axis-label" x="${plot.left + plot.width / 2}" y="${height - 20}" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisTemperatureIntervals"))}</text>
      <text class="green-population-axis-label" transform="translate(27 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("landsatPopulation.axisResidents"))}</text>
    </svg>
    <p class="green-population-output" data-green-population-output aria-live="polite">${escapeHtml(landsatPopulationHistogramLabel(model.bins[0], model))}</p>
  </div>`;
}

function landsatPopulationDialog(model, kind) {
  const cumulative = kind === "cumulative";
  const titleKey = cumulative ? "landsatPopulation.cumulativeExpandedTitle" : "landsatPopulation.histogramExpandedTitle";
  return `<dialog class="comparison-chart-dialog green-population-dialog" data-comparison-chart-dialog data-chart-dialog-id="landsat-population-${kind}" aria-label="${escapeHtml(t(titleKey, { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t(titleKey, { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("greenPopulation.closeChart"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("landsatPopulation.expandedContext", { residents: formatNumber(model.totalResidents, 0), date: landsatDateTime(model.observation?.acquiredAt), area: panelAreaName(model.record) }))}</p>
      ${cumulative ? landsatPopulationCumulativeChart(model, { expanded: true }) : landsatPopulationHistogram(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("landsatPopulation.academicNote"))}</p>
    </div>
  </dialog>`;
}

function renderLandsatPopulationComparison(model) {
  return `<div class="panel-hero comparison-hero green-population-hero">
    <p class="panel-eyebrow">${escapeHtml(t("landsatPopulation.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(t("landsatPopulation.title"))}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("landsatPopulation.sampleCount", { count: model.points.length }))}</p>
  </div>
  <div class="panel-body comparison-body green-population-body">
    <section aria-labelledby="landsat-population-chart-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("landsatPopulation.analysis"))}</p><h3 id="landsat-population-chart-title">${escapeHtml(t("landsatPopulation.cumulativeTitle"))}</h3></div>
      <p>${escapeHtml(t("landsatPopulation.inlineIntro", { residents: formatNumber(model.totalResidents, 0), cells: formatNumber(model.points.length, 0) }))}</p>
      ${landsatPopulationCumulativeChart(model)}
      ${landsatPopulationDialog(model, "cumulative")}
      <div class="section-heading comparison-secondary-heading"><h3>${escapeHtml(t("landsatPopulation.histogramTitle"))}</h3></div>
      ${landsatPopulationHistogram(model)}
      ${landsatPopulationDialog(model, "histogram")}
      <div class="summary-grid sealed-regression-grid">
        ${metricCard("landsatPopulation.mean", model.weightedMean == null ? t("value.notAvailable") : `${formatNumber(model.weightedMean, 1)} °C`, "#8f1d2c")}
      </div>
    </section>
    <details class="detail-accordion" data-section="landsat-population-details">
      <summary data-focus-key="landsat-population-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("landsatPopulation.detailsTitle"))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(t("landsatPopulation.exactAreaSummary", { area: formatNumber(model.analysedAreaHa, 2), observations: formatNumber(model.contributingLandsatCount, 0) }))}</p><p>${escapeHtml(t("landsatPopulation.definition"))}</p><p>${escapeHtml(t("landsatPopulation.residentWeighting"))}</p><p>${escapeHtml(t("landsatPopulation.populationDifference"))}</p><p>${escapeHtml(t("landsatPopulation.zeroPopulation", { count: model.zeroPopulationCount }))}</p></div>
    </details>
    <details class="detail-accordion methodology-accordion" data-section="landsat-population-methodology">
      <summary data-focus-key="landsat-population-methodology-summary"><span>${escapeHtml(t("landsatPopulation.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy"><p>${escapeHtml(t("landsatPopulation.methodology"))}</p><p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landsatPopulation.academicNote"))}</p></div>
    </details>
  </div>`;
}

function signedTemperature(value) {
  if (!Number.isFinite(value)) return t("value.notAvailable");
  const formatted = formatNumber(Math.abs(value), 2);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}°C`;
}

const SCENARIO_GROUND_COLOURS = Object.freeze({
  low: "#bfff00", sealed: "#e8292f", agriculture: "#ffe600", water: "#4691d0", bare: "#b09976",
});

function signedArea(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : number < 0 ? "−" : ""}${formatNumber(Math.abs(number), 2)} ha`;
}

function scenarioCompositionBar(ground, stage, label) {
  const entries = Object.entries(SCENARIO_GROUND_COLOURS).map(([name, colour]) => ({
    name, colour, value: Math.max(0, Number(ground?.[name]?.[`${stage}Ha`]) || 0),
  }));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const aria = entries.map((entry) => `${t(`scenario.class.${entry.name}`)} ${formatNumber(entry.value, 2)} ha`).join(", ");
  return `<div class="scenario-composition-row">
    <strong>${escapeHtml(label)}</strong>
    <div class="scenario-composition-bar" role="img" aria-label="${escapeHtml(`${label}: ${aria}`)}">
      ${entries.filter((entry) => entry.value > 0).map((entry) => `<span style="--segment:${entry.colour};--share:${total ? entry.value / total * 100 : 0}%" title="${escapeHtml(`${t(`scenario.class.${entry.name}`)}: ${formatNumber(entry.value, 2)} ha`)}"></span>`).join("")}
    </div>
  </div>`;
}

function scenarioCanopyBars(canopy) {
  const maximum = Math.max(Number(canopy?.beforeHa) || 0, Number(canopy?.afterHa) || 0, .0001);
  return ["before", "after"].map((stage) => {
    const value = Number(canopy?.[`${stage}Ha`]) || 0;
    return `<div class="scenario-composition-row scenario-canopy-row"><strong>${escapeHtml(t(`scenario.${stage}`))}</strong><div class="scenario-canopy-bar"><span style="--share:${value / maximum * 100}%"></span></div><em>${escapeHtml(formatNumber(value, 2))} ha</em></div>`;
  }).join("");
}

function scenarioDeltaDistributionDialog(model) {
  return `<dialog class="comparison-chart-dialog scenario-distribution-dialog" data-comparison-chart-dialog data-chart-dialog-id="scenario-delta-distribution" aria-label="${escapeHtml(t("scenario.distributionExpandedTitle", { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("scenario.distributionExpandedTitle", { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("scenario.distributionClose"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("scenario.distributionExpandedDescription", { count: model.stats?.affectedCellCount ?? 0, area: panelAreaName(model.record) }))}</p>
      ${scenarioDeltaHistogram(model.stats, { expanded: true })}
    </div>
  </dialog>`;
}

function renderLandCoverScenario(model) {
  const { record, stats, manifest, hasResult, selectedMethod = "xgboost", diagnostics, methodFallback } = model;
  const balance = stats?.landCoverBalance;
  const activeMethod = manifest?.methods?.[selectedMethod] ?? {};
  const methodSuffix = `${selectedMethod[0]?.toUpperCase() ?? ""}${selectedMethod.slice(1)}`;
  const productId = activeMethod.productId ?? selectedMethod;
  const productSuffix = `${productId[0]?.toUpperCase() ?? ""}${productId.slice(1)}`;
  const methodSourceUrl = activeMethod.source?.url ?? (selectedMethod === "radoux"
    ? manifest?.source?.url ?? "https://doi.org/10.3390/rs17162815"
    : SOURCE_PRODUCTS.xgboost.url);
  const changedRows = balance ? [
    ...Object.entries(balance.ground ?? {}).map(([name, values]) => ({ name, ...values })),
    { name: "high", ...(balance.highCanopy ?? {}) },
  ].filter((entry) => Math.abs(Number(entry.changeHa) || 0) >= .0001) : [];
  return `
    <article class="official-panel scenario-panel">
      <div class="panel-hero land-cover-hero scenario-hero">
        <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
        <h2 id="panel-title">${escapeHtml(panelAreaName(record))}</h2>
        <p class="panel-source-line">${escapeHtml(t("scenario.baselineLine"))} · ${escapeHtml(t(`scenario.method.${selectedMethod}`))}</p>
        ${methodFallback ? `<p class="panel-inline-warning">${escapeHtml(t("scenario.xgboostFallback"))}</p>` : ""}
        ${hasResult ? `
          <div class="scenario-primary-result">
            <strong>${escapeHtml(formatNumber(stats?.acceptedAreaHa ?? 0, 2))} ha</strong>
            <span>${escapeHtml(t("scenario.acceptedArea"))}</span>
          </div>` : `<p class="scenario-empty-result">${escapeHtml(t("scenario.emptyResult"))}</p>`}
      </div>
      <div class="panel-body">
        ${hasResult ? `
          <section>
            <div class="section-heading"><p class="section-kicker">${escapeHtml(t("scenario.resultsKicker"))}</p><h3>${escapeHtml(t("scenario.resultsTitle"))}</h3></div>
            ${stats?.affectedCellCount ? `<div class="summary-grid">${metricCard("scenario.medianAffected", signedTemperature(stats.medianDeltaC), "#176b87")}</div>` : ""}
            ${balance ? `<div class="scenario-balance">
              <h4>${escapeHtml(t("scenario.groundComposition"))}</h4>
              ${scenarioCompositionBar(balance.ground, "before", t("scenario.before"))}
              ${scenarioCompositionBar(balance.ground, "after", t("scenario.after"))}
              <h4>${escapeHtml(t("scenario.highCanopy"))}</h4>
              ${scenarioCanopyBars(balance.highCanopy)}
              ${changedRows.length ? `<table class="scenario-change-table"><thead><tr><th>${escapeHtml(t("scenario.changedClass"))}</th><th>${escapeHtml(t("scenario.before"))}</th><th>${escapeHtml(t("scenario.change"))}</th><th>${escapeHtml(t("scenario.after"))}</th></tr></thead><tbody>${changedRows.map((entry) => `<tr><th>${escapeHtml(t(`scenario.class.${entry.name}`))}</th><td>${escapeHtml(formatNumber(entry.beforeHa, 2))}</td><td class="${Number(entry.changeHa) > 0 ? "is-positive" : "is-negative"}">${escapeHtml(signedArea(entry.changeHa))}</td><td>${escapeHtml(formatNumber(entry.afterHa, 2))}</td></tr>`).join("")}</tbody></table>` : ""}
            </div>` : ""}
          </section>` : `<p class="panel-definition">${escapeHtml(t("scenario.panelInstruction"))}</p>`}
        ${hasResult ? `<details class="detail-accordion details-accordion" data-section="details">
          <summary><span>${escapeHtml(t("scenario.detailsTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <div class="summary-grid">
              ${metricCard("scenario.strongestCooling", Number.isFinite(stats?.strongestCoolingC) ? signedTemperature(stats.strongestCoolingC) : t("scenario.noneEstimated"), "#2166ac")}
              ${metricCard("scenario.strongestWarming", Number.isFinite(stats?.strongestWarmingC) ? signedTemperature(stats.strongestWarmingC) : t("scenario.noneEstimated"), "#b2182b")}
            </div>
            ${scenarioDeltaHistogram(stats)}
            <p>${escapeHtml(t("scenario.distributionThreshold", { count: stats?.affectedCellCount ?? 0 }))}</p>
            ${diagnostics?.outsideTrainingRangeCellCount ? `<p>${escapeHtml(t("scenario.outsideTrainingRangeCells", {
              count: diagnostics.outsideTrainingRangeCellCount,
            }))}</p>` : ""}
          </div>
        </details>` : ""}
        ${hasResult ? scenarioDeltaDistributionDialog(model) : ""}
        <details class="detail-accordion methodology-accordion" data-section="methodology">
          <summary><span>${escapeHtml(t("scenario.methodologyTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <h4>${escapeHtml(t("scenario.methodologySharedTitle"))}</h4>
            <p>${escapeHtml(t("scenario.methodologyShared"))}</p>
            <h4>${escapeHtml(t(`scenario.methodology${methodSuffix}Title`))}</h4>
            <p>${escapeHtml(t(`scenario.methodology${methodSuffix}`))}</p>
            ${methodSourceUrl ? `<p><a href="${safeHref(methodSourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(`sources.product${productSuffix}`))}</a></p>` : ""}
            ${selectedMethod !== "radoux" && activeMethod.available ? `<p>${escapeHtml(t("scenario.smoothingApplied", {
              value: activeMethod.smoothingSigmaMeters ?? 0,
            }))}</p>` : ""}
            <h4>${escapeHtml(t("scenario.methodologyLimitationsTitle"))}</h4>
            <p>${escapeHtml(t(`scenario.methodologyLimitations.${selectedMethod}`))}</p>
          </div>
        </details>
      </div>
    </article>`;
}

/** Render a plain panel model supplied by a layer module. */
export function renderSectorPanelModel(model) {
  if (model.template === "heat") {
    return renderHeatRecord(model.record, model.methodology, model.urbanAtlas, model.heatMetric);
  }
  if (model.template === "urban-atlas") {
    return renderUrbanAtlasRecord(model.record, model.urbanAtlas);
  }
  if (model.template === "notebook-test") return renderNotebookTestRecord(model);
  if (model.template === "local-official-raster") return renderLocalOfficialRaster(model);
  if (model.template === "landsat-temperature") return renderLandsatTemperature(model);
  if (model.template === "landsat-urban-atlas-comparison") return renderLandsatUrbanAtlasComparison(model);
  if (model.template === "landsat-jaarbak-comparison") return renderLandsatJaarbakComparison(model);
  if (model.template === "heat-income-comparison") return renderHeatIncomeComparison(model);
  if (model.template === "heat-population-comparison") return renderHeatPopulationComparison(model);
  if (model.template === "sealed-urban-scatter") return renderSealedUrbanScatter(model);
  if (["groenkaart-population-comparison", "jaarbak-population-comparison"].includes(model.template)) {
    return renderPercentagePopulationComparison(model);
  }
  if (model.template === "landsat-population-comparison") return renderLandsatPopulationComparison(model);
  if (model.template === "land-cover-scenario") return renderLandCoverScenario(model);
  if (model.template === "income") return renderIncome(model);
  if (model.template === "population") return renderPopulation(model);
  if (model.template === "metric-summary") return renderMetricSummaryPanel(model);
  throw new Error(`Unknown sector panel template '${model.template}'.`);
}

/** Render the About view from the same safe content helpers as result panels. */
export function renderAboutPanelModel(model) {
  return renderAboutPanel(model);
}
