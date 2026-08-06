import { formatDate, formatNumber, getLanguage, t } from "./i18n.js";
import {
  DEFAULT_HEAT_METRIC,
  HEAT_METRICS,
  heatMetricStatus,
  heatMetricValue,
  normalizeHeatMetric,
} from "./heat-metric.js";
import { escapeHtml, formatScore, interpretationFor, scoreColor, scorePercentage } from "./score-utils.js";
import { safeExternalUrl } from "./security.js";

const safeHref = (value) => escapeHtml(safeExternalUrl(value));

function isMunicipalitySummary(record) {
  return record.scope === "municipality";
}

function panelEyebrow(record) {
  if (isMunicipalitySummary(record)) {
    return t("panel.municipalitySummary", { count: record.sectorCount });
  }
  return `${record.municipality} · ${record.sectorId}`;
}

function scopedStatistics(dataset, record) {
  return isMunicipalitySummary(record)
    ? dataset?.municipalityStats?.[record.municipality]
    : dataset?.sectorStats?.[record.sectorId];
}

function scoreCard(labelKey, definitionKey, value, color) {
  return `
    <div class="summary-card score-summary-card">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong style="--score-color:${color}">${formatScore(value)}</strong>
      <small>${escapeHtml(t("score.outOf10"))}</small>
      <p>${escapeHtml(t(definitionKey))}</p>
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

function sourceLinks(methodology, landCover, urbanAtlas, vegetation) {
  const { scores, geometry, osm } = methodology.sources;
  const copernicus = landCover?.source?.productUrl ? `
      <li><a href="${safeHref(landCover.source.productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.copernicus"))}</a></li>` : "";
  const urbanAtlasLink = urbanAtlas?.source?.productUrl ? `
      <li><a href="${safeHref(urbanAtlas.source.productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.urbanAtlas"))}</a></li>` : "";
  const vegetationLink = vegetation?.source?.productUrl ? `
      <li><a href="${safeHref(vegetation.source.productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.vegetation"))}</a></li>` : "";
  return `
    <ul class="source-list">
      <li><a href="${safeHref(scores.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.scores"))}</a></li>
      <li><a href="${safeHref(geometry.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.geometry"))}</a></li>
      ${copernicus}
      ${urbanAtlasLink}
      ${vegetationLink}
      <li><a href="${safeHref(osm.copyrightUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.basemap"))}</a></li>
    </ul>`;
}

function renderHeatRecord(record, methodology, landCover, urbanAtlas, vegetation, heatMetric = DEFAULT_HEAT_METRIC) {
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
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      <div class="score-hero ${isScored ? "" : "score-hero--status"}" style="--hero-color:${selectedColor}">
        <div class="score-orb"><strong>${formatScore(isScored ? selectedValue : null)}</strong>${isScored ? "<span>/ 10</span>" : ""}</div>
        <div><span class="score-caption">${escapeHtml(statusLabel(record, selectedMetric))}</span><p>${escapeHtml(heatMetricInterpretation(record, selectedMetric))}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">↗</span> ${escapeHtml(t("score.relativeNote"))}</p>
    </div>
    <div class="panel-body">
      <section aria-labelledby="synthesis-title">
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.buildKicker"))}</p><h3 id="synthesis-title">${escapeHtml(t("panel.relatedScoresTitle"))}</h3></div>
        <p class="section-intro">${escapeHtml(t(`panel.metricIntro.${selectedMetric}`))}</p>
        <div class="summary-grid">
          ${relatedMetrics.map((metric) => {
            const presentation = metricPresentation[metric];
            const value = heatMetricValue(record, metric);
            const status = heatMetricStatus(record, metric);
            return scoreCard(
              presentation.labelKey,
              presentation.definitionKey,
              value,
              scoreColor(value, methodology.palette, status),
            );
          }).join("")}
        </div>
        <p class="calculation-note">${escapeHtml(t("panel.synthesisNote"))}</p>
        <p class="provenance-note"><strong>${escapeHtml(t("provenance.officialSource"))}</strong><span>${escapeHtml(t("panel.heatSourceNote"))}</span></p>
      </section>
      <details class="detail-accordion" data-section="indicators">
        <summary data-focus-key="indicators-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("panel.detailsTitle"))}</span></summary>
        <div class="accordion-content">${groupedComponents(record, methodology)}</div>
      </details>
      <details class="detail-accordion methodology-accordion" data-section="methodology">
        <summary data-focus-key="methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("panel.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("panel.methodologyText"))}</p>
          <p>${escapeHtml(t("panel.heatSourceNote"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("panel.warningText"))}</p>
          <h4>${escapeHtml(t("panel.sources"))}</h4>
          ${sourceLinks(methodology, landCover, urbanAtlas, vegetation)}
        </div>
      </details>
    </div>`;
}

function landCoverDefinition(landCover, code) {
  return landCover?.classes?.find((entry) => entry.code === code);
}

function landCoverClassStatistic(stats, code) {
  return stats?.classes?.find((entry) => entry.code === code) ?? { areaHa: 0, percentage: 0 };
}

function landCoverClassRows(stats, landCover) {
  return stats.classes.map((entry) => {
    const definition = landCoverDefinition(landCover, entry.code);
    if (!definition) return "";
    return `
      <div class="land-cover-row">
        <span class="land-cover-swatch" style="--swatch:${escapeHtml(definition.color)}" aria-hidden="true"></span>
        <span>${escapeHtml(t(`class.${definition.key}`))}</span>
        <strong>${escapeHtml(t("landCover.areaValue", {
          area: formatNumber(entry.areaHa),
          percentage: formatNumber(entry.percentage),
        }))}</strong>
      </div>`;
  }).join("");
}

function renderLandCoverRecord(record, methodology, landCover, urbanAtlas, vegetation) {
  const stats = scopedStatistics(landCover, record);
  const dominant = landCoverDefinition(landCover, stats?.dominantClassCode);
  const treeCover = landCoverClassStatistic(stats, 10);
  const cropland = landCoverClassStatistic(stats, 40);
  const dominantLabel = dominant ? t(`class.${dominant.key}`) : t("landCover.noData");
  const dominantColor = dominant?.color ?? "#b4b4b4";
  return `
    <div class="panel-hero land-cover-hero">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      <div class="score-hero" style="--hero-color:${dominantColor}">
        <div class="land-cover-orb" style="--class-color:${dominantColor}" aria-hidden="true"></div>
        <div><span class="score-caption">${escapeHtml(t("landCover.dominant"))}</span><p class="land-cover-dominant">${escapeHtml(dominantLabel)}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("landCover.eyebrow", { year: landCover.activeYear }))}</p>
    </div>
    <div class="panel-body">
      ${stats ? `
        <section aria-labelledby="land-cover-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("landCover.eyebrow", { year: landCover.activeYear }))}</p><h3 id="land-cover-summary-title">${escapeHtml(t("landCover.classBreakdown"))}</h3></div>
          <p class="section-intro">${escapeHtml(t("landCover.summaryExplanation"))}</p>
          <div class="summary-grid land-cover-summary-grid">
            ${metricCard("landCover.vegetation", t("unit.percentage", { value: formatNumber(stats.vegetationPercentage) }), "#0b6e69", "land-cover-combined")}
            ${metricCard("landCover.treeCover", t("unit.percentage", { value: formatNumber(treeCover.percentage) }), "#006400", "land-cover-trees")}
            ${metricCard("landCover.croplandCover", t("unit.percentage", { value: formatNumber(cropland.percentage) }), "#8b3f91", "land-cover-cropland")}
            ${metricCard("landCover.builtUp", t("unit.percentage", { value: formatNumber(stats.builtUpPercentage) }), "#c90000", "land-cover-built")}
          </div>
          <p class="provenance-note"><strong>${escapeHtml(t("provenance.localSummary"))}</strong><span>${escapeHtml(t("landCover.derivedNote"))}</span></p>
        </section>
        <details class="detail-accordion" data-section="land-cover-classes">
          <summary data-focus-key="land-cover-classes-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("landCover.classBreakdown"))}</span></summary>
          <div class="accordion-content land-cover-classes">${landCoverClassRows(stats, landCover)}</div>
        </details>` : `<p class="panel-empty-state">${escapeHtml(t("landCover.noData"))}</p>`}
      <details class="detail-accordion methodology-accordion" data-section="land-cover-methodology">
        <summary data-focus-key="land-cover-methodology-summary"><span><small>${escapeHtml(t("landCover.methodologyKicker"))}</small>${escapeHtml(t("landCover.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("landCover.productionText"))}</p>
          <p>${escapeHtml(t("landCover.methodologyText"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landCover.comparisonWarning"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landCover.warningText"))}</p>
          <p>${escapeHtml(t("landCover.attribution"))}</p>
          ${landCover.source?.doi ? `<p><a href="${safeHref(landCover.source.doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landCover.doi"))}</a></p>` : ""}
          ${landCover.source?.accessedAt ? `<p>${escapeHtml(t("landCover.accessed", { date: formatDate(landCover.source.accessedAt) }))}</p>` : ""}
          ${landCover.generatedAt ? `<p>${escapeHtml(t("landCover.generatedAt", { date: formatDate(landCover.generatedAt) }))}</p>` : ""}
          <h4>${escapeHtml(t("panel.sources"))}</h4>
          ${sourceLinks(methodology, landCover, urbanAtlas, vegetation)}
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

function urbanAtlasRow(entry, urbanAtlas, { showMetricPercentage = true } = {}) {
  const definition = urbanAtlasDefinition(urbanAtlas, entry.code);
  if (!definition) return "";
  return `
    <div class="land-cover-row urban-atlas-row">
      <span class="land-cover-swatch" style="--swatch:${escapeHtml(definition.color)}" aria-hidden="true"></span>
      <span>${escapeHtml(urbanAtlasClassLabel(urbanAtlas, entry.code))}</span>
      <strong>
        ${escapeHtml(t("unit.hectares", { value: formatNumber(entry.areaHa) }))}
        <small>${escapeHtml(t("urbanAtlas.sectorShare", { value: formatNumber(entry.sectorPercentage) }))}${showMetricPercentage ? ` · ${escapeHtml(t("urbanAtlas.metricShare", { value: formatNumber(entry.metricPercentage) }))}` : ""}</small>
      </strong>
    </div>`;
}

function urbanAtlasArtificialGroups(stats, urbanAtlas) {
  const groupOrder = ["urbanFabric", "industryServices", "transport", "constructionExtraction"];
  return groupOrder.map((groupKey) => {
    const rows = stats.artificial.classes.filter((entry) => (
      urbanAtlasDefinition(urbanAtlas, entry.code)?.artificialGroupKey === groupKey && entry.areaHa > 0
    ));
    if (!rows.length) return "";
    return `<section class="urban-atlas-breakdown-group">
      <h4>${escapeHtml(t(`urbanAtlas.artificialGroup.${groupKey}`))}</h4>
      ${rows.map((entry) => urbanAtlasRow(entry, urbanAtlas)).join("")}
    </section>`;
  }).join("");
}

function renderUrbanAtlasRecord(record, methodology, landCover, urbanAtlas, vegetation) {
  const stats = scopedStatistics(urbanAtlas, record);
  const dominant = urbanAtlasDefinition(urbanAtlas, stats?.dominantClassCode);
  const dominantLabel = dominant ? urbanAtlasClassLabel(urbanAtlas, dominant.code) : t("urbanAtlas.noData");
  const dominantColor = dominant?.color ?? "#b4b4b4";
  const validationKey = urbanAtlas?.source?.validationStatus === "not-yet-validated"
    ? "urbanAtlas.validationNotYet"
    : "urbanAtlas.validationUnknown";
  return `
    <div class="panel-hero land-cover-hero urban-atlas-hero">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      <div class="score-hero" style="--hero-color:${dominantColor}">
        <div class="land-cover-orb" style="--class-color:${dominantColor}" aria-hidden="true"></div>
        <div><span class="score-caption">${escapeHtml(t("urbanAtlas.dominant"))}</span><p class="land-cover-dominant">${escapeHtml(dominantLabel)}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("urbanAtlas.eyebrow", { year: urbanAtlas.activeYear }))}</p>
    </div>
    <div class="panel-body">
      ${stats ? `
        <section aria-labelledby="urban-atlas-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("urbanAtlas.eyebrow", { year: urbanAtlas.activeYear }))}</p><h3 id="urban-atlas-summary-title">${escapeHtml(t("urbanAtlas.summaryTitle"))}</h3></div>
          <div class="summary-grid">
            ${metricCard("urbanAtlas.greenCoverage", t("unit.percentage", { value: formatNumber(stats.green.percentage) }), "#008c00")}
            ${metricCard("urbanAtlas.artificialisation", t("unit.percentage", { value: formatNumber(stats.artificial.percentage) }), "#bf0000")}
          </div>
          <p class="urban-atlas-valid-area">${escapeHtml(t("urbanAtlas.validArea", { area: formatNumber(stats.validAreaHa) }))}</p>
          <p class="provenance-note"><strong>${escapeHtml(t("provenance.localSummary"))}</strong><span>${escapeHtml(t("urbanAtlas.derivedNote"))}</span></p>
        </section>
        <details class="detail-accordion" data-section="urban-atlas-green" open>
          <summary data-focus-key="urban-atlas-green-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("urbanAtlas.greenBreakdown"))}</span></summary>
          <div class="accordion-content land-cover-classes">${stats.green.classes.map((entry) => urbanAtlasRow(entry, urbanAtlas)).join("")}</div>
        </details>
        <details class="detail-accordion" data-section="urban-atlas-artificial" open>
          <summary data-focus-key="urban-atlas-artificial-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("urbanAtlas.artificialBreakdown"))}</span></summary>
          <div class="accordion-content">${urbanAtlasArtificialGroups(stats, urbanAtlas)}</div>
        </details>
        ${stats.otherClasses?.length ? `<details class="detail-accordion" data-section="urban-atlas-other">
          <summary data-focus-key="urban-atlas-other-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("urbanAtlas.otherLandCover"))}</span></summary>
          <div class="accordion-content land-cover-classes">${stats.otherClasses.map((entry) => urbanAtlasRow(entry, urbanAtlas, { showMetricPercentage: false })).join("")}</div>
        </details>` : ""}` : `<p class="panel-empty-state">${escapeHtml(t("urbanAtlas.noData"))}</p>`}
      <details class="detail-accordion methodology-accordion" data-section="urban-atlas-methodology">
        <summary data-focus-key="urban-atlas-methodology-summary"><span><small>${escapeHtml(t("landCover.methodologyKicker"))}</small>${escapeHtml(t("urbanAtlas.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("urbanAtlas.productionText"))}</p>
          <p>${escapeHtml(t("urbanAtlas.methodologyText"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.comparisonWarning"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.accessWarning"))}</p>
          <p>${escapeHtml(t("urbanAtlas.classificationWarning"))}</p>
          <p>${escapeHtml(t(validationKey, { date: formatDate(urbanAtlas?.source?.validationStatusCheckedAt) }))}</p>
          <p>${escapeHtml(t("landCover.attribution"))}</p>
          ${urbanAtlas?.source?.doi ? `<p><a href="${safeHref(urbanAtlas.source.doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landCover.doi"))}</a></p>` : ""}
          ${urbanAtlas?.source?.accessedAt ? `<p>${escapeHtml(t("landCover.accessed", { date: formatDate(urbanAtlas.source.accessedAt) }))}</p>` : ""}
          ${urbanAtlas?.generatedAt ? `<p>${escapeHtml(t("landCover.generatedAt", { date: formatDate(urbanAtlas.generatedAt) }))}</p>` : ""}
          <h4>${escapeHtml(t("panel.sources"))}</h4>
          ${sourceLinks(methodology, landCover, urbanAtlas, vegetation)}
        </div>
      </details>
    </div>`;
}

function vegetationAreaValue(areaHa, percentage) {
  return t("vegetation.areaAndPercentage", {
    area: formatNumber(areaHa),
    percentage: formatNumber(percentage),
  });
}

function vegetationComposition(stats, vegetation) {
  const otherArea = Math.max(0, Number(stats.sectorAreaHa) - Number(stats.likelyVegetatedAreaHa));
  const otherPercentage = Math.max(0, 100 - Number(stats.likelyVegetatedPercentage));
  const items = [
    { key: "likelyVegetated", area: stats.likelyVegetatedAreaHa, percentage: stats.likelyVegetatedPercentage, color: vegetation.palette.likelyVegetated },
    { key: "otherValidArea", area: otherArea, percentage: otherPercentage, color: "#D9DEDA" },
  ];
  const label = items.map((item) => `${t(`vegetation.${item.key}`)} ${formatNumber(item.percentage)}%`).join(", ");
  return `
    <div class="vegetation-composition" role="img" aria-label="${escapeHtml(label)}">
      ${items.filter((item) => item.percentage > 0).map((item) => `<span style="width:${item.percentage}%;--segment:${item.color}"></span>`).join("")}
    </div>
    <div class="vegetation-composition-key">
      ${items.map((item) => `<span><i style="--swatch:${item.color}" aria-hidden="true"></i><b>${escapeHtml(t(`vegetation.${item.key}`))}</b><strong>${escapeHtml(vegetationAreaValue(item.area, item.percentage))}</strong></span>`).join("")}
    </div>`;
}

function renderVegetationRecord(record, methodology, landCover, urbanAtlas, vegetation) {
  const year = vegetation?.activeYear ?? 2020;
  const yearData = vegetation?.years?.[year];
  const stats = scopedStatistics(yearData, record);
  const calibration = yearData?.calibration;
  return `
    <div class="panel-hero land-cover-hero vegetation-hero">
      <p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p>
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      ${stats ? `<div class="score-hero" style="--hero-color:${escapeHtml(vegetation.palette.likelyVegetated)}">
        <div class="score-orb"><strong>${escapeHtml(formatNumber(stats.likelyVegetatedPercentage))}</strong><span>%</span></div>
        <div><span class="score-caption">${escapeHtml(t("vegetation.likelyVegetated"))}</span><p>${escapeHtml(t("vegetation.headlineArea", { area: formatNumber(stats.likelyVegetatedAreaHa) }))}</p></div>
      </div>` : `<p class="panel-empty-state">${escapeHtml(t("vegetation.noData"))}</p>`}
      <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("vegetation.eyebrow", { year }))}</p>
    </div>
    <div class="panel-body">
      ${stats ? `<section aria-labelledby="vegetation-summary-title">
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("vegetation.eyebrow", { year }))}</p><h3 id="vegetation-summary-title">${escapeHtml(t("vegetation.summaryTitle"))}</h3></div>
        <p class="vegetation-definition">${escapeHtml(t("vegetation.ndviDefinition"))}</p>
        <p class="section-intro vegetation-intro">${escapeHtml(t("vegetation.summaryExplanation"))}</p>
        ${vegetationComposition(stats, vegetation)}
      </section>
      <details class="detail-accordion" data-section="vegetation-observation-details">
        <summary data-focus-key="vegetation-observation-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("vegetation.observationDetails"))}</span></summary>
        <div class="accordion-content">
          <div class="summary-grid vegetation-summary-grid">
            ${metricCard("vegetation.medianNdvi", formatNumber(stats.medianNdvi, 3), "#238B45")}
            ${metricCard("vegetation.belowThreshold", vegetationAreaValue(stats.belowThresholdAreaHa, stats.belowThresholdPercentage), "#52615C")}
            ${metricCard("vegetation.excludedCropland", vegetationAreaValue(stats.excludedCroplandAreaHa ?? stats.excludedArableAreaHa ?? 0, stats.excludedCroplandPercentage ?? stats.excludedArablePercentage ?? 0), "#6F5D1C")}
            ${metricCard("vegetation.excludedWater", vegetationAreaValue(stats.excludedWaterAreaHa, stats.excludedWaterPercentage), "#24658F")}
            ${metricCard("vegetation.missingObservation", t("unit.hectares", { value: formatNumber(stats.missingObservationAreaHa) }), "#52615C")}
          </div>
          ${stats.medianIsAreaWeightedApproximation ? `<p class="calculation-note">${escapeHtml(t("vegetation.municipalityMedianNote"))}</p>` : ""}
          <p class="urban-atlas-valid-area vegetation-valid-area">${escapeHtml(t("vegetation.validArea", {
            area: formatNumber(stats.validAreaHa),
            sectorArea: formatNumber(stats.sectorAreaHa),
          }))}</p>
          <p class="provenance-note"><strong>${escapeHtml(t("provenance.localSummary"))}</strong><span>${escapeHtml(t("vegetation.derivedNote"))}</span></p>
        </div>
      </details>` : ""}
      ${yearData?.quality?.status === "warning" ? `<p class="panel-warning">${escapeHtml(t("vegetation.qualityWarning", {
        cloud: formatNumber(yearData.quality.cloudAffectedPercentage, 1),
        coverage: formatNumber(yearData.quality.coveragePercentage, 1),
      }))}</p>` : ""}
      <details class="detail-accordion methodology-accordion" data-section="vegetation-methodology">
        <summary data-focus-key="vegetation-methodology-summary"><span><small>${escapeHtml(t("landCover.methodologyKicker"))}</small>${escapeHtml(t("vegetation.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("vegetation.observation", {
            date: formatDate(yearData?.acquisitionDate),
            threshold: formatNumber(yearData?.threshold, 3),
          }))}</p>
          <p>${escapeHtml(t("vegetation.methodologyText"))}</p>
          ${calibration ? `<h4>${escapeHtml(t("vegetation.calibrationTitle"))}</h4>
            <ul>
              <li>${escapeHtml(t("vegetation.calibrationSamples", {
                positive: formatNumber(calibration.positive.count, 0),
                negative: formatNumber(calibration.negative.count, 0),
              }))}</li>
              <li>${escapeHtml(t("vegetation.calibrationPerformance", {
                sensitivity: formatNumber(calibration.sensitivity * 100, 1),
                specificity: formatNumber(calibration.specificity * 100, 1),
                balanced: formatNumber(calibration.balancedAccuracy * 100, 1),
                auc: formatNumber(calibration.auc, 3),
              }))}</li>
            </ul>` : ""}
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("vegetation.calibrationCaveat"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("vegetation.classificationCaveat"))}</p>
          <p>${escapeHtml(vegetation?.source?.attribution ?? t("vegetation.attribution"))}</p>
          ${(yearData?.products ?? vegetation?.source?.products)?.length ? `<h4>${escapeHtml(t("vegetation.sourceProducts"))}</h4><ul>${(yearData?.products ?? vegetation.source.products).map((product) => `<li>${escapeHtml(product.id)}</li>`).join("")}</ul>` : ""}
          ${vegetation?.source?.accessedAt ? `<p>${escapeHtml(t("landCover.accessed", { date: formatDate(vegetation.source.accessedAt) }))}</p>` : ""}
          ${vegetation?.generatedAt ? `<p>${escapeHtml(t("landCover.generatedAt", { date: formatDate(vegetation.generatedAt) }))}</p>` : ""}
          <h4>${escapeHtml(t("panel.sources"))}</h4>
          ${sourceLinks(methodology, landCover, urbanAtlas, vegetation)}
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

function aboutLayerCard(key, label) {
  return `<article>
    <span class="about-layer-tag">${escapeHtml(label)}</span>
    <h4>${escapeHtml(t(`about.${key}Question`))}</h4>
    <dl class="about-layer-facts">
      <div><dt>${escapeHtml(t("about.dataLabel"))}</dt><dd>${escapeHtml(t(`about.${key}Text`))}</dd></div>
      <div><dt>${escapeHtml(t("about.producerLabel"))}</dt><dd>${escapeHtml(t(`about.${key}Producer`))}</dd></div>
      <div><dt>${escapeHtml(t("about.greenwaveLabel"))}</dt><dd>${escapeHtml(t(`about.${key}Greenwave`))}</dd></div>
    </dl>
  </article>`;
}

function renderAbout(methodology, landCover, urbanAtlas, vegetation, provenance) {
  const sectorCount = provenance?.output?.sectorCount ?? 154;
  return `
    <div class="panel-hero panel-hero--about">
      <p class="panel-eyebrow">${escapeHtml(t("about.eyebrow", { count: sectorCount }))}</p>
      <h2 id="panel-title">${escapeHtml(t("about.title"))}</h2>
      <p class="about-intro">${escapeHtml(t("about.intro"))}</p>
    </div>
    <div class="panel-body about-body">
      <section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.startKicker"))}</p><h3>${escapeHtml(t("about.howTo"))}</h3></div>
        <ol class="about-steps">
          <li><span>1</span><p>${escapeHtml(t("about.step1"))}</p></li>
          <li><span>2</span><p>${escapeHtml(t("about.step2"))}</p></li>
          <li><span>3</span><p>${escapeHtml(t("about.step3"))}</p></li>
        </ol>
      </section>
      <section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.layersKicker"))}</p><h3>${escapeHtml(t("about.layersTitle"))}</h3></div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryHeat"))}</h4>
          <div class="about-layer-list">
            ${aboutLayerCard("heat", t("layers.heat"))}
          </div>
        </div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryLandGreen"))}</h4>
          <div class="about-layer-list">
            ${aboutLayerCard("landCover", t("layers.landCover", { year: landCover?.activeYear ?? 2020 }))}
            ${aboutLayerCard("urbanAtlas", t("layers.urbanAtlas", { year: urbanAtlas?.activeYear ?? 2021 }))}
            ${aboutLayerCard("vegetation", t("layers.vegetation", { year: vegetation?.activeYear ?? 2020 }))}
          </div>
        </div>
        <p class="comparison-caveat">${escapeHtml(t("about.compareCaveat"))}</p>
      </section>
      <section class="about-note about-sectors">
        <p class="section-kicker">${escapeHtml(t("about.sectorsKicker"))}</p>
        <h3>${escapeHtml(t("about.sectorsTitle"))}</h3>
        <p>${escapeHtml(t("about.sectorsText", { count: sectorCount }))}</p>
        <p>${escapeHtml(t("about.sectorsCompatibility"))}</p>
      </section>
      <section class="about-note about-foundations">
        <p class="section-kicker">${escapeHtml(t("about.foundationKicker"))}</p>
        <h3>${escapeHtml(t("about.foundationTitle"))}</h3>
        <p>${escapeHtml(t("about.provenanceGeometry"))}</p>
        <p>${escapeHtml(t("about.provenanceBasemap"))}</p>
      </section>
      <section class="about-note about-project">
        <p class="section-kicker">${escapeHtml(t("about.projectKicker"))}</p>
        <h3>${escapeHtml(t("about.projectTitle"))}</h3>
        <p>${escapeHtml(t("intro.body1"))}</p>
        <p>${escapeHtml(t("intro.body2"))}</p>
        <p>${escapeHtml(t("intro.body3"))}</p>
        <p class="about-project-links">
          <a href="https://github.com/khookh/zenvallei" target="_blank" rel="noopener noreferrer">${escapeHtml(t("intro.github"))}</a>
          <span aria-hidden="true">·</span>
          <a href="mailto:stefanodonne@gmail.com">${escapeHtml(t("intro.contact"))}</a>
        </p>
      </section>
      <section class="about-note about-privacy">
        <p class="section-kicker">${escapeHtml(t("about.privacyKicker"))}</p>
        <h3>${escapeHtml(t("about.privacyTitle"))}</h3>
        <p>${escapeHtml(t("about.privacyApplication"))}</p>
        <p>${escapeHtml(t("about.privacyHosting"))}</p>
        <p>${escapeHtml(t("about.privacyTiles"))}</p>
        <p>${escapeHtml(t("about.contactText"))} <a href="mailto:stefanodonne@gmail.com">stefanodonne@gmail.com</a>.</p>
      </section>
      <section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.methodologyKicker"))}</p><h3>${escapeHtml(t("about.methodologyTitle"))}</h3></div>
        <details class="detail-accordion about-method" data-section="about-heat-methodology">
          <summary data-focus-key="about-heat-methodology-summary"><span>${escapeHtml(t("about.heatMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("about.heatMethodText"))}</p><p>${escapeHtml(t("about.noDataText"))}</p></div>
        </details>
        <details class="detail-accordion about-method" data-section="about-land-cover-methodology">
          <summary data-focus-key="about-land-cover-methodology-summary"><span>${escapeHtml(t("about.landCoverMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("landCover.productionText"))}</p><p>${escapeHtml(t("landCover.methodologyText"))}</p><p>${escapeHtml(t("landCover.comparisonWarning"))}</p></div>
        </details>
        <details class="detail-accordion about-method" data-section="about-urban-atlas-methodology">
          <summary data-focus-key="about-urban-atlas-methodology-summary"><span>${escapeHtml(t("about.urbanAtlasMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("urbanAtlas.productionText"))}</p><p>${escapeHtml(t("urbanAtlas.methodologyText"))}</p><p>${escapeHtml(t("urbanAtlas.accessWarning"))}</p><p>${escapeHtml(t("urbanAtlas.comparisonWarning"))}</p></div>
        </details>
        <details class="detail-accordion about-method" data-section="about-vegetation-methodology">
          <summary data-focus-key="about-vegetation-methodology-summary"><span>${escapeHtml(t("about.vegetationMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("vegetation.methodologyText"))}</p><p>${escapeHtml(t("vegetation.calibrationCaveat"))}</p><p>${escapeHtml(t("vegetation.classificationCaveat"))}</p></div>
        </details>
      </section>
      <section class="about-sources">
        <h3>${escapeHtml(t("about.sourcesTitle"))}</h3>
        ${sourceLinks(methodology, landCover, urbanAtlas, vegetation)}
        <p class="about-caveat">${escapeHtml(t("about.caveat"))}</p>
      </section>
    </div>`;
}

function renderMetricSummary(model) {
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

/** Render a plain panel model supplied by a layer module. */
export function renderSectorPanelModel(model) {
  if (model.template === "heat") {
    return renderHeatRecord(model.record, model.methodology, model.landCover, model.urbanAtlas, model.vegetation, model.heatMetric);
  }
  if (model.template === "land-cover") {
    return renderLandCoverRecord(model.record, model.methodology, model.landCover, model.urbanAtlas, model.vegetation);
  }
  if (model.template === "urban-atlas") {
    return renderUrbanAtlasRecord(model.record, model.methodology, model.landCover, model.urbanAtlas, model.vegetation);
  }
  if (model.template === "vegetation") {
    return renderVegetationRecord(model.record, model.methodology, model.landCover, model.urbanAtlas, model.vegetation);
  }
  if (model.template === "notebook-test") return renderNotebookTestRecord(model);
  if (model.template === "metric-summary") return renderMetricSummary(model);
  throw new Error(`Unknown sector panel template '${model.template}'.`);
}

export function createDetailPanel({
  panel,
  content,
  closeButton,
  getPanelModel,
  getAboutModel,
  heatMetric = DEFAULT_HEAT_METRIC,
  onLayerOptionChange,
  onClose,
}) {
  if (typeof getPanelModel !== "function" || typeof getAboutModel !== "function") {
    throw new TypeError("The detail panel requires layer-owned panel and about model providers.");
  }

  let returnFocusElement = null;
  let currentView = null;
  let activeHeatMetric = normalizeHeatMetric(heatMetric);

  const captureRenderState = () => ({
    openSections: [...content.querySelectorAll("details[open][data-section]")].map((element) => element.dataset.section),
    hadExpandedSection: Boolean(content.querySelector("details[open]")),
    focusKey: content.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null,
  });

  const renderCurrentView = ({ preserveState = true, focusPanel = false } = {}) => {
    if (!currentView) return;
    const renderState = preserveState ? captureRenderState() : { openSections: [], hadExpandedSection: false, focusKey: null };
    if (currentView.type === "about") {
      const model = getAboutModel();
      content.innerHTML = renderAbout(model.methodology, model.landCover, model.urbanAtlas, model.vegetation, model.provenance);
    } else {
      content.innerHTML = renderSectorPanelModel(getPanelModel(currentView.layerId, currentView.record, {
        heatMetric: activeHeatMetric,
      }));
    }
    let restoredSection = false;
    renderState.openSections.forEach((sectionId) => {
      const matchingSection = [...content.querySelectorAll("details[data-section]")]
        .find((element) => element.dataset.section === sectionId);
      if (matchingSection) {
        matchingSection.setAttribute("open", "");
        restoredSection = true;
      }
    });
    if (renderState.hadExpandedSection && !restoredSection) content.querySelector("details[data-section]")?.setAttribute("open", "");
    if (renderState.focusKey) {
      [...content.querySelectorAll("[data-focus-key]")]
        .find((element) => element.dataset.focusKey === renderState.focusKey)
        ?.focus({ preventScroll: true });
    } else if (focusPanel) {
      requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    }
  };

  const close = ({ restoreFocus = true } = {}) => {
    const closedView = currentView;
    currentView = null;
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    onClose?.(closedView);
    if (restoreFocus && returnFocusElement instanceof HTMLElement) returnFocusElement.focus();
  };

  const show = (view, triggerElement) => {
    returnFocusElement = triggerElement instanceof HTMLElement ? triggerElement : document.activeElement;
    currentView = view;
    renderCurrentView({ preserveState: false, focusPanel: true });
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
  };

  const open = (record, triggerElement = null, layerId = "heat") => show({ type: "record", record, layerId }, triggerElement);
  const openAbout = (triggerElement = null) => show({ type: "about" }, triggerElement);
  const setPanelLanguage = () => {
    if (currentView && panel.classList.contains("is-open")) renderCurrentView({ preserveState: true });
  };
  const setActiveLayer = (layerId) => {
    if (currentView?.type !== "record") return;
    currentView.layerId = layerId;
    if (panel.classList.contains("is-open")) renderCurrentView({ preserveState: true });
  };
  const setHeatMetric = (metric) => {
    activeHeatMetric = normalizeHeatMetric(metric);
    if (currentView?.type === "record" && currentView.layerId === "heat" && panel.classList.contains("is-open")) {
      renderCurrentView({ preserveState: true });
    }
  };

  closeButton.addEventListener("click", () => close());
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  content.addEventListener("click", (event) => {
    const button = event.target.closest("[data-panel-heat-metric]");
    if (!button) return;
    onLayerOptionChange?.("metric", button.dataset.panelHeatMetric, button);
  });
  content.addEventListener("keydown", (event) => {
    const button = event.target.closest("[data-panel-heat-metric]");
    if (!button || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...content.querySelectorAll("[data-panel-heat-metric]")];
    const currentIndex = buttons.indexOf(button);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
  });
  return {
    open,
    openAbout,
    close,
    setLanguage: setPanelLanguage,
    setActiveLayer,
    setHeatMetric,
    refresh: () => renderCurrentView({ preserveState: true }),
    isOpen: () => panel.classList.contains("is-open"),
    isMunicipalitySummary: () => currentView?.type === "record" && currentView.record.scope === "municipality",
  };
}
