
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

function sourceLinks(methodology, urbanAtlas) {
  const { scores, geometry, osm } = methodology.sources;
  const urbanAtlasLink = urbanAtlas?.source?.productUrl ? `
      <li><a href="${safeHref(urbanAtlas.source.productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.urbanAtlas"))}</a></li>` : "";
  return `
    <ul class="source-list">
      <li><a href="${safeHref(scores.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.scores"))}</a></li>
      <li><a href="${safeHref(geometry.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.geometry"))}</a></li>
      ${urbanAtlasLink}
      <li><a href="${safeHref(osm.copyrightUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.basemap"))}</a></li>
    </ul>`;
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
          ${sourceLinks(methodology, urbanAtlas)}
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

function renderUrbanAtlasRecord(record, methodology, urbanAtlas) {
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
        <summary data-focus-key="urban-atlas-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("urbanAtlas.methodologyTitle"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t("urbanAtlas.productionText"))}</p>
          <p>${escapeHtml(t("urbanAtlas.methodologyText"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.comparisonWarning"))}</p>
          <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("urbanAtlas.accessWarning"))}</p>
          <p>${escapeHtml(t("urbanAtlas.classificationWarning"))}</p>
          <p>${escapeHtml(t(validationKey, { date: formatDate(urbanAtlas?.source?.validationStatusCheckedAt) }))}</p>
          <p>${escapeHtml(t("source.copernicusAttribution"))}</p>
          ${urbanAtlas?.source?.doi ? `<p><a href="${safeHref(urbanAtlas.source.doi)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("source.datasetDoi"))}</a></p>` : ""}
          ${urbanAtlas?.source?.accessedAt ? `<p>${escapeHtml(t("source.accessed", { date: formatDate(urbanAtlas.source.accessedAt) }))}</p>` : ""}
          ${urbanAtlas?.generatedAt ? `<p>${escapeHtml(t("source.processed", { date: formatDate(urbanAtlas.generatedAt) }))}</p>` : ""}
          <h4>${escapeHtml(t("panel.sources"))}</h4>
          ${sourceLinks(methodology, urbanAtlas)}
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
      <h2 id="panel-title">${escapeHtml(record.sectorName ?? record.municipality)}</h2>
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
        <p class="local-layer-definition">${escapeHtml(t("jaarbak.definition"))}</p>
        ${localComposition(composition, t("jaarbak.summaryTitle"))}
        <div class="local-breakdown-list">
          ${composition.map(localClassRow).join("")}
        </div>
        <p class="provenance-note"><strong>${escapeHtml(t("officialData.derivedTitle"))}</strong><span>${escapeHtml(t("jaarbak.derivedNote"))}</span></p>
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
        <p class="provenance-note"><strong>${escapeHtml(t("officialData.derivedTitle"))}</strong><span>${escapeHtml(t("groenkaart.derivedNote"))}</span></p>
      </section>`;
}

function renderLocalOfficialRaster(model) {
  const { datasetId, manifest, record, stats, year } = model;
  const methodKey = { jaarbak: "jaarbak.methodology", groenkaart: "groenkaart.methodology" }[datasetId];
  const body = !stats
    ? `<div class="panel-hero local-layer-hero"><p class="panel-eyebrow">${escapeHtml(panelEyebrow(record))}</p><h2 id="panel-title">${escapeHtml(record.sectorName ?? record.municipality)}</h2></div><div class="panel-body"><p class="panel-empty-state">${escapeHtml(t("officialData.noData"))}</p>`
    : datasetId === "jaarbak"
      ? renderJaarbakSummary(stats, record, year)
      : renderGroenkaartSummary(stats, manifest, record, year);
  return `
    <article class="panel-article local-official-panel">
      ${body}
      ${manifest.years?.[year]?.status === "provisional" ? `<p class="panel-warning local-provisional-warning">${escapeHtml(t("officialData.provisionalYear"))}</p>` : ""}
      <details class="detail-accordion methodology-accordion" data-section="local-raster-methodology">
        <summary data-focus-key="local-raster-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("officialData.methodology"))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t(methodKey))}</p>
          ${manifest.density ? `
            <p>${escapeHtml(t("density.methodology"))}</p>
            <p>${escapeHtml(t("density.radiusEvidence"))}</p>
            <ul class="source-list">

              <li><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC6462107/" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referencePnas"))}</a></li>
              <li><a href="https://doi.org/10.1016/j.buildenv.2023.111029" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referenceBuildingEnvironment"))}</a></li>
              <li><a href="https://www.sciensano.be/sites/default/files/beele_et_al_2024_lurp_spatial_config_green_space_1.pdf" target="_blank" rel="noopener noreferrer">${escapeHtml(t("density.referenceLeuven"))}</a></li>
            </ul>` : ""}
          ${year >= 2023 && datasetId === "jaarbak" ? `<p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("jaarbak.methodChangeNote"))}</p>` : ""}
          ${stats ? `<h4>${escapeHtml(t("officialData.coverageTitle"))}</h4><p>${escapeHtml(t("officialData.completeArea"))} ${escapeHtml(t("officialData.visualDerivative"))}</p><p>${escapeHtml(t("officialData.coverageTitle"))}: ${escapeHtml(localAreaValue(stats.validAreaHa, stats.validPercentage))}. ${escapeHtml(t("jaarbak.noData"))}: ${escapeHtml(localAreaValue(stats.noDataAreaHa, stats.noDataPercentage))}.</p>` : ""}
          ${localSource(manifest)}
        </div>
      </details>
    </div></article>`;
}

function renderLandgebruik(model) {
  const { record, manifest, year, mode, stats, parcelStats } = model;
  const definitions = new Map((manifest?.classesOrScale?.items ?? []).map((item) => [String(item.value), item]));
  const classes = (stats?.classes ?? []).map((item) => {
    const definition = definitions.get(String(item.code));
    return {
      ...item,
      label: t(`landgebruik.class.${item.code}`),
      color: definition?.color ?? "#657575",
      group: definition?.group ?? "other",
    };
  });
  const dominant = classes.reduce((best, item) => item.areaHa > (best?.areaHa ?? -1) ? item : best, null);
  const cropColor = new Map((manifest?.agriculturalDetail?.cropGroups ?? []).map((item) => [item.sourceLabel, item.color]));
  const cropGroups = (parcelStats?.cropGroups ?? []).map((item) => ({
    ...item,
    label: t(`landgebruik.cropGroup.${item.sourceLabel}`),
    color: cropColor.get(item.sourceLabel) ?? "#8f8f8f",
  }));
  const groupOrder = ["settlement", "economic", "infrastructure", "recreation", "agriculture", "nature", "water", "other"];
  const breakdown = groupOrder.map((group) => {
    const rows = classes.filter((item) => item.group === group);
    if (!rows.length) return "";
    return `<section class="landgebruik-breakdown-group"><h4>${escapeHtml(t(`landgebruik.group.${group}`))}</h4><div class="local-breakdown-list">${rows.map(localClassRow).join("")}</div></section>`;
  }).join("");
  const agricultural = mode === "agriculture";
  const hero = agricultural
    ? localHero(record, t("landgebruik.agriculture2025"), parcelStats ? `
        <div class="score-hero" style="--hero-color:#9ad7cf">
          <div class="score-orb local-percentage-orb"><strong>${escapeHtml(formatNumber(parcelStats.parcelPercentage, 1))}</strong><span>%</span></div>
          <div><span class="score-caption">${escapeHtml(t("landgebruik.parcelShareHeadline"))}</span><p>${escapeHtml(t("landgebruik.parcelAreaSupport", {
            area: formatNumber(parcelStats.parcelAreaHa), count: parcelStats.parcelCount,
          }))}</p></div>
        </div>` : `<p class="panel-empty-state">${escapeHtml(t("landgebruik.noParcels"))}</p>`, t("landgebruik.parcelScale"))
    : localHero(record, t("landgebruik.referenceYear", { year }), dominant ? `
        <div class="score-hero">
          <div class="land-cover-orb" style="--class-color:${escapeHtml(dominant.color)}" aria-hidden="true"></div>
          <div><span class="score-caption">${escapeHtml(t("landgebruik.dominantClass"))}</span><p class="land-cover-dominant">${escapeHtml(dominant.label)} · ${escapeHtml(formatNumber(dominant.percentage, 1))}%</p></div>
        </div>` : `<p class="panel-empty-state">${escapeHtml(t("officialData.noData"))}</p>`, t("landgebruik.contextMeta", { year }));
  return `
    <article class="panel-article landgebruik-panel">
      ${hero}
      <div class="panel-body local-layer-body">
        <section aria-labelledby="landgebruik-summary-title">
          <div class="section-heading"><p class="section-kicker">${escapeHtml(t("layers.landgebruik"))}</p><h3 id="landgebruik-summary-title">${escapeHtml(t(agricultural ? "landgebruik.agriculturePanelTitle" : "landgebruik.panelTitle"))}</h3></div>
          <p class="local-layer-definition">${escapeHtml(t(agricultural ? "landgebruik.agriculturePanelExplanation" : "landgebruik.panelExplanation"))}</p>
          ${agricultural && parcelStats ? `
            ${localComposition(cropGroups, t("landgebruik.cropBreakdown"))}
            <h4 class="local-breakdown-title">${escapeHtml(t("landgebruik.cropBreakdown"))}</h4>
            <div class="local-breakdown-list">${cropGroups.map(localClassRow).join("")}</div>` : ""}
          ${!agricultural && stats ? `
            ${localComposition(classes, t("landgebruik.composition"))}
            <h4 class="local-breakdown-title">${escapeHtml(t("landgebruik.composition"))}</h4>
            <div class="landgebruik-breakdown">${breakdown}</div>` : ""}
        </section>
        <details class="detail-accordion methodology-accordion" data-section="landgebruik-methodology">
          <summary data-focus-key="landgebruik-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("landgebruik.methodologyTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t("landgebruik.methodology"))}</p>
            <p>${escapeHtml(t("landgebruik.parcelMethodology"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landgebruik.comparisonWarning"))}</p>
            ${localSource(manifest)}
            ${manifest?.agriculturalDetail?.source?.url ? `<p><a href="${safeHref(manifest.agriculturalDetail.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landgebruik.parcelSourceName"))}</a></p>` : ""}
          </div>
        </details>
      </div>
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

function officialAboutCards(officialLayers) {
  const definitions = [
    ["jaarbak", "layers.jaarbak"],
    ["groenkaart", "layers.groenkaart"],
    ["landgebruik", "layers.landgebruik"],
  ];
  return definitions
    .filter(([datasetId]) => officialLayers?.[datasetId])
    .map(([datasetId, labelKey]) => aboutLayerCard(
      datasetId,
      t(labelKey, { year: officialLayers[datasetId].defaultYear }),
    ))
    .join("");
}

function officialAboutMethodologies(officialLayers) {
  return ["jaarbak", "groenkaart", "landgebruik"]
    .filter((datasetId) => officialLayers?.[datasetId])
    .map((datasetId) => `
      <details class="detail-accordion about-method" data-section="about-${datasetId}-methodology">
        <summary data-focus-key="about-${datasetId}-methodology-summary"><span>${escapeHtml(t(`about.${datasetId}MethodTitle`))}</span></summary>
        <div class="accordion-content methodology-copy">
          <p>${escapeHtml(t(`${datasetId}.methodology`))}</p>
          <p>${escapeHtml(t("officialData.visualDerivative"))}</p>
          ${localSource(officialLayers[datasetId])}
        </div>
      </details>`)

    .join("");
}

function officialAboutSources(officialLayers) {
  const links = ["jaarbak", "groenkaart", "landgebruik", "landsat-temperature"]
    .filter((datasetId) => officialLayers?.[datasetId]?.source?.url || officialLayers?.[datasetId]?.source?.productUrl)
    .map((datasetId) => {
      const key = datasetId === "landsat-temperature" ? "landsat" : datasetId;
      const url = officialLayers[datasetId].source.url ?? officialLayers[datasetId].source.productUrl;
      return `<li><a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(`about.${key}MethodTitle`))}</a></li>`;
    })
    .join("");
  const parcelUrl = officialLayers?.landgebruik?.agriculturalDetail?.source?.url;
  const parcelLink = parcelUrl
    ? `<li><a href="${safeHref(parcelUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("landgebruik.parcelSourceName"))}</a></li>`
    : "";
  return links || parcelLink ? `<ul class="source-list">${links}${parcelLink}</ul>` : "";
}

function renderAbout(methodology, urbanAtlas, income, population, provenance, officialLayers) {
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
            ${officialLayers?.["landsat-temperature"] ? aboutLayerCard("landsat", t("layers.landsatTemperature")) : ""}
          </div>
        </div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryLandGreen"))}</h4>
          <div class="about-layer-list">
            ${aboutLayerCard("urbanAtlas", t("layers.urbanAtlas", { year: urbanAtlas?.activeYear ?? 2021 }))}
            ${officialAboutCards(officialLayers)}
          </div>
        </div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryDemography"))}</h4>
          <div class="about-layer-list">
            ${aboutLayerCard("population", t("layers.population"))}
            ${aboutLayerCard("income", t("layers.income"))}
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
        ${officialLayers?.["landsat-temperature"] ? `<details class="detail-accordion about-method" data-section="about-landsat-methodology">
          <summary data-focus-key="about-landsat-methodology-summary"><span>${escapeHtml(t("about.landsatMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("landsat.methodology"))}</p><p>${escapeHtml(t("landsat.comparisonCaveat"))}</p></div>
        </details>` : ""}
        <details class="detail-accordion about-method" data-section="about-urban-atlas-methodology">
          <summary data-focus-key="about-urban-atlas-methodology-summary"><span>${escapeHtml(t("about.urbanAtlasMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("urbanAtlas.productionText"))}</p><p>${escapeHtml(t("urbanAtlas.methodologyText"))}</p><p>${escapeHtml(t("urbanAtlas.accessWarning"))}</p><p>${escapeHtml(t("urbanAtlas.comparisonWarning"))}</p></div>
        </details>
        <details class="detail-accordion about-method" data-section="about-income-methodology">
          <summary data-focus-key="about-income-methodology-summary"><span>${escapeHtml(t("about.incomeMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("income.methodology"))}</p><p>${escapeHtml(t("income.nominalWarning"))}</p></div>
        </details>
        <details class="detail-accordion about-method" data-section="about-population-methodology">
          <summary data-focus-key="about-population-methodology-summary"><span>${escapeHtml(t("about.populationMethodTitle"))}</span></summary>
          <div class="accordion-content methodology-copy"><p>${escapeHtml(t("population.methodologyCurrent"))}</p><p>${escapeHtml(t("population.methodologyModel"))}</p><p>${escapeHtml(t("population.comparisonWarning"))}</p></div>
        </details>
        ${officialAboutMethodologies(officialLayers)}
      </section>
      <section class="about-sources">
        <h3>${escapeHtml(t("about.sourcesTitle"))}</h3>
        ${sourceLinks(methodology, urbanAtlas)}
        ${income?.source?.pageUrl ? `<ul class="source-list"><li><a href="${safeHref(income.source.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("income.sourceName"))}</a></li></ul>` : ""}
        ${population ? `<ul class="source-list">${Object.values(population.datasets ?? {}).map((dataset) => `<li><a href="${safeHref(dataset.source.pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(dataset.source.name)}</a></li>`).join("")}</ul>` : ""}
        ${officialAboutSources(officialLayers)}
        <p class="about-caveat">${escapeHtml(t("about.caveat"))}</p>
      </section>
    </div>`;

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

function comparisonHistogram(model, { expanded = false } = {}) {
  const available = model.selectedSeries.filter((series) => series.stats?.clearPixelCount >= 10);
  if (!model.selectedSeries.length) return `<p class="panel-empty-state">${escapeHtml(t("comparison.noSelectedSeries"))}</p>`;
  const percentages = available.map((series) => series.stats.binCounts.map((count) => (
    series.stats.clearPixelCount ? count / series.stats.clearPixelCount * 100 : 0
  )));
  const maximum = Math.max(1, Math.ceil(Math.max(0, ...percentages.flat()) / 5) * 5);
  const dashes = ["none", "10 5", "3 4", "12 4 3 4"];
  const edges = model.manifest.binEdges;
  const labels = edges.slice(0, -1).map((minimum, index) => t("comparison.binLabel", {
    minimum: formatNumber(minimum, 1),
    maximum: formatNumber(edges[index + 1], 1),
    values: model.selectedSeries.map((series) => t("comparison.binValue", {
      series: series.label,
      percentage: formatNumber(series.stats?.clearPixelCount
        ? Number(series.stats.binCounts[index] ?? 0) / series.stats.clearPixelCount * 100 : 0, 1),
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
    <i aria-hidden="true"></i><b>${escapeHtml(series.label)}</b><span>${escapeHtml(t("comparison.clearPixels"))}: ${escapeHtml(formatNumber(series.stats?.clearPixelCount ?? 0, 0))}${expanded ? ` &middot; ${escapeHtml(t("comparison.representedArea", { value: formatNumber(representedLandsatAreaHa(series.stats?.clearPixelCount ?? 0), 1) }))}` : ""}</span>
  </span>`).join("");
  const tails = expanded ? `<div class="comparison-chart-tails">
    ${model.selectedSeries.map((series) => `<p><strong>${escapeHtml(series.label)}</strong> ${escapeHtml(t("comparison.outsideScale", {
      underflow: formatNumber(series.stats?.underflowCount ?? 0, 0),
      overflow: formatNumber(series.stats?.overflowCount ?? 0, 0),
    }))}</p>`).join("")}
  </div>` : "";
  return `<div class="comparison-chart ${expanded ? "is-expanded" : ""}" data-comparison-chart>
    <div class="comparison-chart-heading">
      <div class="comparison-series-chips">${chips}</div>
      ${expanded ? "" : `<button class="comparison-chart-expand" type="button" data-expand-comparison-chart>${escapeHtml(t("comparison.expandHistogram"))}</button>`}
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
      ${labels.map((label, index) => `<button type="button" data-histogram-bin="${index}" data-histogram-x="${plot.left + (index + .5) / labels.length * plot.width}" data-histogram-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></button>`).join("")}
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
  const total = stats.clearPixelCount + stats.cloudPixelCount + stats.otherMissingPixelCount;

  const cloudShare = total ? stats.cloudPixelCount / total * 100 : 0;
  const warning = stats.clearPixelCount < 10
    ? t("comparison.tooFewPixels")
    : stats.clearPixelCount < 30 ? t("comparison.limitedSample", { count: stats.clearPixelCount }) : "";
  return `<article class="comparison-series-card" style="--series:${escapeHtml(series.color)}">
    <header><i aria-hidden="true"></i><h4>${escapeHtml(series.label)}</h4></header>
    ${warning ? `<p class="comparison-sample-warning">${escapeHtml(warning)}</p>` : ""}
    <dl>
      <div><dt>${escapeHtml(t("landsat.median"))}</dt><dd>${stats.medianC == null ? "-" : `${escapeHtml(formatNumber(stats.medianC, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t("landsat.mean"))}</dt><dd>${stats.meanC == null ? "-" : `${escapeHtml(formatNumber(stats.meanC, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t("comparison.temperatureRange"))}</dt><dd>${stats.p10C == null ? "-" : `${escapeHtml(formatNumber(stats.p10C, 1))}–${escapeHtml(formatNumber(stats.p90C, 1))} °C`}</dd></div>
      <div><dt>${escapeHtml(t("comparison.clearPixels"))}</dt><dd>${escapeHtml(formatNumber(stats.clearPixelCount, 0))}</dd></div>
      <div><dt>${escapeHtml(t("comparison.cloudShare"))}</dt><dd>${escapeHtml(formatNumber(cloudShare, 1))}%</dd></div>
    </dl>
  </article>`;
}

function renderLandsatUrbanAtlasComparison(model) {
  const { record, urbanAtlas, observation, landsatManifest } = model;
  const heatwave = landsatManifest?.heatwaves?.find(({ id }) => observation?.heatwaveIds?.includes(id));
  const uaStats = scopedStatistics(urbanAtlas, record);
  return `<div class="panel-hero comparison-hero">
    <p class="panel-eyebrow">${escapeHtml(t("comparison.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
    <p class="panel-subtitle">${escapeHtml(landsatDateTime(observation?.acquiredAt))}</p>
    ${heatwave ? `<p>${escapeHtml(t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) }))}</p>` : ""}
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("comparison.seriesCount", { count: model.selectedSeries.length }))}</p>
  </div>
  <div class="panel-body comparison-body">
    <section>
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("comparison.title"))}</p><h3>${escapeHtml(t("comparison.histogramTitle"))}</h3></div>
      <p class="comparison-definition">${escapeHtml(t("comparison.surfaceTemperatureDefinition"))}</p>
      <p class="section-intro">${escapeHtml(t("comparison.histogramExplanation"))}</p>
      ${comparisonHistogram(model)}
      ${comparisonChartDialog(model)}
    </section>
    <section aria-labelledby="comparison-series-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.detailsKicker"))}</p><h3 id="comparison-series-title">${escapeHtml(t("comparison.seriesMetrics"))}</h3></div>
      <div class="comparison-series-list">${model.selectedSeries.map(comparisonSeriesCard).join("")}</div>
    </section>
    ${uaStats ? `<section aria-labelledby="comparison-ua-title">
      <div class="section-heading"><p class="section-kicker">URBAN ATLAS 2021</p><h3 id="comparison-ua-title">${escapeHtml(t("comparison.urbanAtlasResults"))}</h3></div>
      <div class="summary-grid">
        ${metricCard("urbanAtlas.greenCoverage", t("unit.percentage", { value: formatNumber(uaStats.green.percentage) }), "#008c00")}
        ${metricCard("urbanAtlas.artificialisation", t("unit.percentage", { value: formatNumber(uaStats.artificial.percentage) }), "#bf0000")}
      </div>
    </section>
    <details class="detail-accordion" data-section="comparison-urban-atlas-green">
      <summary data-focus-key="comparison-urban-atlas-green-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("urbanAtlas.greenBreakdown"))}</span></summary>
      <div class="accordion-content land-cover-classes">${uaStats.green.classes.map((entry) => urbanAtlasRow(entry, urbanAtlas)).join("")}</div>
    </details>
    <details class="detail-accordion" data-section="comparison-urban-atlas-artificial">
      <summary data-focus-key="comparison-urban-atlas-artificial-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("urbanAtlas.artificialBreakdown"))}</span></summary>
      <div class="accordion-content">${urbanAtlasArtificialGroups(uaStats, urbanAtlas)}</div>
    </details>` : `<p class="panel-empty-state">${escapeHtml(t("comparison.noScopeData"))}</p>`}
    <details class="detail-accordion methodology-accordion" data-section="comparison-methodology">
      <summary data-focus-key="comparison-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("comparison.methodologyTitle"))}</span></summary>
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
  return `<div class="panel-hero comparison-hero">
    <p class="panel-eyebrow">${escapeHtml(t("soilComparison.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
    <p class="panel-subtitle">${escapeHtml(landsatDateTime(observation?.acquiredAt))}</p>
    ${heatwave ? `<p>${escapeHtml(t("landsat.heatwavePeriod", { start: formatDate(heatwave.start), end: formatDate(heatwave.end) }))}</p>` : ""}
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("soilComparison.matchedYear", { year: model.secondaryYear }))}</p>
  </div>
  <div class="panel-body comparison-body">
    <section>
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("soilComparison.title"))}</p><h3>${escapeHtml(t("comparison.histogramTitle"))}</h3></div>
      <p class="comparison-definition">${escapeHtml(t("comparison.surfaceTemperatureDefinition"))}</p>
      <p class="section-intro">${escapeHtml(t("comparison.histogramExplanation"))}</p>
      ${comparisonHistogram(model)}
      ${comparisonChartDialog(model)}
    </section>
    <section aria-labelledby="soil-comparison-series-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("panel.detailsKicker"))}</p><h3 id="soil-comparison-series-title">${escapeHtml(t("comparison.seriesMetrics"))}</h3></div>
      <div class="comparison-series-list">${model.selectedSeries.map(comparisonSeriesCard).join("")}</div>
    </section>
    ${surfaceStats ? `<section aria-labelledby="soil-composition-title">
      <div class="section-heading"><p class="section-kicker">JAARBAK ${escapeHtml(String(model.secondaryYear))}</p><h3 id="soil-composition-title">${escapeHtml(t("soilComparison.results"))}</h3></div>
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
      <summary data-focus-key="soil-comparison-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("comparison.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("soilComparison.assignment"))}</p>
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
    ${expanded ? "" : `<div class="heat-income-chart-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart>${escapeHtml(t("comparison.expandHistogram"))}</button></div>`}
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
      <p class="comparison-definition">${escapeHtml(t("heatIncome.definition"))}</p>
      ${panelHeatMetricSelector(model.metric)}
      <p class="section-intro">${escapeHtml(t("heatIncome.scopeNote", { area: panelAreaName(model.record) }))}</p>
      ${heatIncomeScatter(model)}
      ${heatIncomeChartDialog(model)}
    </section>
    <details class="detail-accordion methodology-accordion" data-section="heat-income-methodology">
      <summary data-focus-key="heat-income-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("heatIncome.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
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
    metric: t(`heatMetric.${model.metric}`),
    score: formatNumber(point.score, 0),
  });
}

function heatPopulationBoxPlot(model, { expanded = false } = {}) {
  const layout = heatPopulationBoxLayout();
  const { plot } = layout;
  const yTicks = [0, 2, 4, 6, 8, 10];
  const selectedPoint = model.points.find(({ sectorId }) => sectorId === model.highlightedSectorId);
  const initialPoint = selectedPoint ?? model.points[0];
  const prefix = expanded ? "heat-population-box-expanded" : "heat-population-box-inline";
  return `<div class="heat-population-chart ${expanded ? "is-expanded" : ""}" data-sector-comparison-chart data-heat-population-box-chart>
    <h4>${escapeHtml(t("heatPopulation.boxTitle"))}</h4>
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
        ${Array.from({ length: 5 }, (_, index) => index + 1).map((level) => `<g>
          <text x="${layout.x(level)}" y="${plot.top + plot.height + 30}" text-anchor="middle">${level}</text>
          <text class="heat-population-range-tick" x="${layout.x(level)}" y="${plot.top + plot.height + 55}" text-anchor="middle">${escapeHtml(t(`heatPopulation.levelShort${level}`))}</text>
        </g>`).join("")}
      </g>
      <text class="heat-population-axis-label" x="${plot.left + plot.width / 2}" y="${layout.height - 24}" text-anchor="middle">${escapeHtml(t("heatPopulation.axisPopulationBand"))}</text>
      <text class="heat-population-axis-label" transform="translate(28 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("heatPopulation.axisScore", { metric: t(`heatMetric.${model.metric}`) }))}</text>
      <g class="heat-population-points" role="group" aria-label="${escapeHtml(t("heatPopulation.pointsLabel"))}">
        ${model.points.map((point, index) => {
          const highlighted = point.sectorId === model.highlightedSectorId;
          const label = heatPopulationPointLabel(model, point);
          return `<circle cx="${layout.x(point.level + stableSectorOffset(point.sectorId)).toFixed(2)}" cy="${layout.y(point.score).toFixed(2)}" r="5" role="button" tabindex="${highlighted || (!model.highlightedSectorId && index === 0) ? 0 : -1}" class="heat-population-point ${highlighted ? "is-selected" : ""}" data-scatter-sector="${escapeHtml(point.sectorId)}" data-scatter-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></circle>`;
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

function heatPopulationBarChart(model, { expanded = false } = {}) {
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
  });
  return `<div class="heat-population-chart ${expanded ? "is-expanded" : ""}" data-heat-population-bar-chart>
    <h4>${escapeHtml(t("heatPopulation.barTitle"))}</h4>
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
    ${expanded ? "" : `<div class="heat-population-chart-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart>${escapeHtml(t("heatPopulation.expandCharts"))}</button></div>`}
    ${heatPopulationBoxPlot(model, { expanded })}
    ${heatPopulationBarChart(model, { expanded })}
  </div>`;
}

function heatPopulationChartDialog(model) {
  return `<dialog class="comparison-chart-dialog heat-population-chart-dialog" data-comparison-chart-dialog aria-label="${escapeHtml(t("heatPopulation.expandedTitle", { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("heatPopulation.expandedTitle", { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("heatPopulation.closeCharts"))}">×</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("heatPopulation.expandedDescription", { metric: t(`heatMetric.${model.metric}`), area: panelAreaName(model.record) }))}</p>
      ${heatPopulationCharts(model, { expanded: true })}
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
      <p class="comparison-definition">${escapeHtml(t("heatPopulation.definition"))}</p>
      ${panelHeatMetricSelector(model.metric)}
      <p class="section-intro">${escapeHtml(t("heatPopulation.scopeNote", { area: panelAreaName(model.record) }))}</p>
      <p class="heat-population-coverage"><strong>${escapeHtml(t("heatPopulation.comparablePopulation", {
        population: formatNumber(model.comparablePopulation, 0),
        total: formatNumber(model.totalPopulation, 0),
        excluded: formatNumber(model.excludedPopulation, 0),
      }))}</strong></p>
      ${heatPopulationCharts(model)}
      ${heatPopulationChartDialog(model)}
    </section>
    <details class="detail-accordion" data-section="heat-population-details">
      <summary data-focus-key="heat-population-details-summary"><span><small>${escapeHtml(t("panel.detailsKicker"))}</small>${escapeHtml(t("heatPopulation.detailsTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("heatPopulation.boxPlotExplanation"))}</p>
        <p>${escapeHtml(t("heatPopulation.weightExplanation"))}</p>
        <p>${escapeHtml(t("heatPopulation.excludedExplanation", { count: model.excludedCount, population: formatNumber(model.excludedPopulation, 0) }))}</p>
      </div>
    </details>
    <details class="detail-accordion methodology-accordion" data-section="heat-population-methodology">
      <summary data-focus-key="heat-population-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("heatPopulation.methodologyTitle"))}</span></summary>
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
          <p class="landsat-coverage"><strong>${escapeHtml(t("landsat.clearCoverage"))}: ${escapeHtml(formatNumber(stats?.clearPercentage ?? 0, 1))}%</strong><span>${escapeHtml(t("landsat.coverageExplanation"))}</span></p>
          <p class="provenance-note"><strong>${escapeHtml(t("provenance.localSummary"))}</strong><span>${escapeHtml(t("landsat.derivedNote"))}</span></p>
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
          <summary data-focus-key="landsat-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("officialData.methodology"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t("landsat.methodology"))}</p>
            <p>${escapeHtml(t("landsat.referenceMethod"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landsat.comparisonCaveat"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("landsat.asterCaveat"))}</p>
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

function incomeMetricCard(labelKey, value, explanationKey) {
  return `
    <div class="summary-card income-summary-card">
      <span>${escapeHtml(t(labelKey))}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(t(explanationKey))}</p>
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
          <p class="local-layer-definition">${escapeHtml(t("income.definition"))}</p>
          ${available ? `
            <div class="summary-grid income-summary-grid">
              ${incomeMetricCard("income.average", formatCurrency(stats.averageNetTaxableIncome), "income.averageExplanation")}
              ${incomeMetricCard("income.declarations", formatNumber(stats.numberOfDeclarations, 0), "income.declarationsExplanation")}
            </div>
            <section class="income-spread" aria-labelledby="income-spread-title">
              <h4 id="income-spread-title">${escapeHtml(t("income.spreadTitle"))}</h4>
              <div class="local-breakdown-list">
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileDifference"))}</span><strong>${escapeHtml(formatCurrency(stats.interquartileDifference))}</strong><small>${escapeHtml(t("income.interquartileDifferenceExplanation"))}</small></div>
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileCoefficient"))}</span><strong>${escapeHtml(`${formatNumber(stats.interquartileCoefficient, 0)}%`)}</strong><small>${escapeHtml(t("income.interquartileCoefficientExplanation"))}</small></div>
                <div class="income-spread-row"><span>${escapeHtml(t("income.interquartileAsymmetry"))}</span><strong>${escapeHtml(`${formatNumber(stats.interquartileAsymmetry, 0)}%`)}</strong><small><b>${escapeHtml(incomeAsymmetryLabel(stats.interquartileAsymmetry))}</b> ${escapeHtml(t("income.interquartileAsymmetryExplanation"))}</small></div>
              </div>
              <p class="calculation-note">${escapeHtml(t("income.distributionUnavailable"))}</p>
            </section>
            <p class="provenance-note"><strong>${escapeHtml(t("officialData.derivedTitle"))}</strong><span>${escapeHtml(t("income.derivedNote"))}</span></p>`
            : `<p class="panel-empty-state income-missing-copy">${escapeHtml(t("income.notPublishedExplanation"))}</p>`}
        </section>
        <details class="detail-accordion methodology-accordion" data-section="income-methodology">
          <summary data-focus-key="income-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("income.methodologyTitle"))}</span></summary>
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
          <p class="local-layer-definition">${escapeHtml(t(current ? "population.panelCurrentExplanation" : "population.panelModelExplanation"))}</p>
          ${available ? `<div class="summary-grid population-summary-grid">
            ${incomeMetricCard("population.densityMetric", t("population.densityValue", { value: formatNumber(stats.densityPerHa, 1) }), "population.densityExplanation")}
            ${incomeMetricCard("population.areaMetric", t("unit.hectares", { value: formatNumber(stats.areaHa, 1) }), "population.areaExplanation")}
          </div>` : `<p class="panel-empty-state">${escapeHtml(t("population.notPublishedExplanation"))}</p>`}
          <p class="provenance-note"><strong>${escapeHtml(t("officialData.derivedTitle"))}</strong><span>${escapeHtml(t(current ? "population.derivedCurrent" : "population.derivedModel"))}</span></p>
        </section>
        <details class="detail-accordion methodology-accordion" data-section="population-methodology">
          <summary data-focus-key="population-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("population.methodologyTitle"))}</span></summary>
          <div class="accordion-content methodology-copy">
            <p>${escapeHtml(t(current ? "population.methodologyCurrent" : "population.methodologyModel"))}</p>
            <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("population.comparisonWarning"))}</p>
            ${sourceUrl ? `<p><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(dataset.source.name)}</a></p>` : ""}
          </div>
        </details>
      </div>
    </article>`;
}

function greenUrbanDensityBoxPlot(model, { expanded = false } = {}) {
  const series = model.selectedFabricClasses.filter(({ densityDistribution }) => densityDistribution?.count);
  if (!series.length) return `<p class="panel-empty-state">${escapeHtml(t("greenUrbanComparison.noData"))}</p>`;
  const width = 900;
  const height = expanded ? 590 : 500;
  const plot = { left: 104, top: 42, width: 760, height: expanded ? 390 : 300 };
  const y = (value) => plot.top + plot.height - Math.max(0, Math.min(100, value)) / 100 * plot.height;
  const step = plot.width / series.length;
  const boxWidth = Math.min(92, step * .55);
  const ticks = [0, 20, 40, 60, 80, 100];
  const valueLabel = (item) => {
    const stats = item.densityDistribution;
    return t("greenUrbanComparison.boxValue", {
      surface: item.label,
      median: formatNumber(stats.median, 1),
      q1: formatNumber(stats.q1, 1),
      q3: formatNumber(stats.q3, 1),
      count: stats.count,
    });
  };
  const prefix = expanded ? "green-density-chart-expanded" : "green-density-chart-inline";
  return `<div class="green-density-boxplot ${expanded ? "is-expanded" : ""}" data-green-density-chart>
    <div class="green-density-chart-heading">
      <div><h4 id="${prefix}-heading">${escapeHtml(t("greenUrbanComparison.boxTitle"))}</h4>
      <p>${escapeHtml(t("greenUrbanComparison.boxExplanation"))}</p></div>
      ${expanded ? "" : `<button class="comparison-chart-expand" type="button" data-expand-comparison-chart>${escapeHtml(t("greenUrbanComparison.expandChart"))}</button>`}
    </div>
    <div class="green-density-series-key">${series.map((item) => `<span><i style="--series:${escapeHtml(item.color)}" aria-hidden="true"></i><b>${escapeHtml(item.code)}</b> ${escapeHtml(item.label)} <small>n=${escapeHtml(formatNumber(item.densityDistribution.count, 0))}</small></span>`).join("")}</div>
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("greenUrbanComparison.boxTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("greenUrbanComparison.boxDescription", { area: panelAreaName(model.record), classes: model.greenClassLabels.join(", ") }))}</desc>
      <g class="green-density-grid" aria-hidden="true">${ticks.map((tick) => `<line x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(tick)}" y2="${y(tick)}"></line>`).join("")}</g>
      <g class="green-density-axis-values" aria-hidden="true">
        ${ticks.map((tick) => `<text x="${plot.left - 16}" y="${y(tick) + 5}" text-anchor="end">${tick}%</text>`).join("")}
        ${series.map((item, index) => `<text x="${plot.left + step * (index + .5)}" y="${plot.top + plot.height + 38}" text-anchor="middle">${escapeHtml(item.code)}</text>`).join("")}
      </g>
      <text class="green-density-axis-label" transform="translate(30 ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("greenUrbanComparison.axisDensity"))}</text>
      <text class="green-density-axis-label" x="${plot.left + plot.width / 2}" y="${height - 28}" text-anchor="middle">${escapeHtml(t("greenUrbanComparison.axisFabric"))}</text>
      <g class="green-density-boxes" role="list">${series.map((item, index) => {
        const stats = item.densityDistribution;
        const centre = plot.left + step * (index + .5);
        const left = centre - boxWidth / 2;
        const right = centre + boxWidth / 2;
        const label = valueLabel(item);
        return `<g role="listitem" tabindex="${index === 0 ? "0" : "-1"}" data-green-density-box data-green-density-label="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" style="--series:${escapeHtml(item.color)}">
          <line class="green-density-whisker" x1="${centre}" x2="${centre}" y1="${y(stats.whiskerHigh)}" y2="${y(stats.whiskerLow)}"></line>
          <line class="green-density-whisker" x1="${left}" x2="${right}" y1="${y(stats.whiskerHigh)}" y2="${y(stats.whiskerHigh)}"></line>
          <line class="green-density-whisker" x1="${left}" x2="${right}" y1="${y(stats.whiskerLow)}" y2="${y(stats.whiskerLow)}"></line>
          <rect x="${left}" y="${y(stats.q3)}" width="${boxWidth}" height="${Math.max(1, y(stats.q1) - y(stats.q3))}" rx="5"></rect>
          <line class="green-density-median" x1="${left}" x2="${right}" y1="${y(stats.median)}" y2="${y(stats.median)}"></line>
        </g>`;
      }).join("")}</g>
    </svg>
    <p class="green-density-output" data-green-density-output aria-live="polite">${escapeHtml(valueLabel(series[0]))}</p>
  </div>`;
}

function greenUrbanDensityChartDialog(model) {
  return `<dialog class="comparison-chart-dialog green-density-chart-dialog" data-comparison-chart-dialog aria-label="${escapeHtml(t("greenUrbanComparison.expandedTitle", { area: panelAreaName(model.record) }))}">
    <div class="comparison-chart-dialog-content">
      <header><h3>${escapeHtml(t("greenUrbanComparison.expandedTitle", { area: panelAreaName(model.record) }))}</h3><button type="button" data-close-comparison-chart aria-label="${escapeHtml(t("greenUrbanComparison.closeChart"))}">&times;</button></header>
      <p class="comparison-dialog-description">${escapeHtml(t("greenUrbanComparison.expandedDescription", {
        area: panelAreaName(model.record), classes: model.greenClassLabels.join(", "), radius: model.densityRadiusMeters,
      }))}</p>
      ${greenUrbanDensityBoxPlot(model, { expanded: true })}
      <p class="comparison-academic-note">${escapeHtml(t("greenUrbanComparison.academicDetails", { resolution: model.analysisResolutionMeters }))}</p>
    </div>
  </dialog>`;
}

function renderGroenkaartUrbanAtlasComparison(model) {
  const selectedGreen = model.greenClassLabels.join(", ");
  return `<div class="panel-hero comparison-hero green-urban-comparison-hero">
    <p class="panel-eyebrow">${escapeHtml(t("greenUrbanComparison.heroKicker"))}</p>
    <h2 id="panel-title">${escapeHtml(panelAreaName(model.record))}</h2>
    <p class="panel-subtitle">${escapeHtml(t("greenUrbanComparison.panelSubtitle"))}</p>
    <p class="relative-note"><span aria-hidden="true">◇</span> ${escapeHtml(t("greenUrbanComparison.selectedGreen", { classes: selectedGreen }))}</p>
  </div>
  <div class="panel-body comparison-body green-urban-comparison-body">
    <section aria-labelledby="green-urban-results-title">
      <div class="section-heading"><p class="section-kicker">${escapeHtml(t("greenUrbanComparison.title"))}</p><h3 id="green-urban-results-title">${escapeHtml(t("greenUrbanComparison.resultsTitle"))}</h3></div>
      <p class="comparison-definition">${escapeHtml(t("greenUrbanComparison.definition", { radius: model.densityRadiusMeters }))}</p>
      ${greenUrbanDensityBoxPlot(model)}
      ${greenUrbanDensityChartDialog(model)}
      <div class="green-urban-results-list">
        ${model.selectedFabricClasses.map((item) => `<article class="green-urban-result-card" style="--series:${escapeHtml(item.color)}">
          <header><i aria-hidden="true"></i><h4>${escapeHtml(item.label)}</h4></header>
          ${item.stats?.validCellCount ? `<strong>${escapeHtml(formatNumber(item.meanDensity, 1))}%</strong>
            <span>${escapeHtml(t("greenUrbanComparison.meanDensity"))}</span>
            <small>${escapeHtml(t("greenUrbanComparison.validArea", { area: formatNumber(item.stats.validAreaHa, 1) }))}</small>`
            : `<p>${escapeHtml(t("greenUrbanComparison.noData"))}</p>`}
        </article>`).join("")}
      </div>
    </section>
    <details class="detail-accordion methodology-accordion" data-section="green-urban-methodology">
      <summary data-focus-key="green-urban-methodology-summary"><span><small>${escapeHtml(t("panel.methodologyKicker"))}</small>${escapeHtml(t("greenUrbanComparison.methodologyTitle"))}</span></summary>
      <div class="accordion-content methodology-copy">
        <p>${escapeHtml(t("greenUrbanComparison.methodologyDensity", { radius: model.densityRadiusMeters }))}</p>
        <p>${escapeHtml(t("greenUrbanComparison.methodologyAssignment", { resolution: model.analysisResolutionMeters }))}</p>
        <p>${escapeHtml(t("greenUrbanComparison.methodologyYears"))}</p>
        <p><strong>${escapeHtml(t("panel.warningLabel"))}</strong> ${escapeHtml(t("greenUrbanComparison.methodologyCaveat"))}</p>
      </div>
    </details>
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
    return renderHeatRecord(model.record, model.methodology, model.urbanAtlas, model.heatMetric);
  }
  if (model.template === "urban-atlas") {
    return renderUrbanAtlasRecord(model.record, model.methodology, model.urbanAtlas);
  }
  if (model.template === "notebook-test") return renderNotebookTestRecord(model);
  if (model.template === "local-official-raster") return renderLocalOfficialRaster(model);
  if (model.template === "landgebruik") return renderLandgebruik(model);
  if (model.template === "landsat-temperature") return renderLandsatTemperature(model);
  if (model.template === "landsat-urban-atlas-comparison") return renderLandsatUrbanAtlasComparison(model);
  if (model.template === "landsat-jaarbak-comparison") return renderLandsatJaarbakComparison(model);
  if (model.template === "heat-income-comparison") return renderHeatIncomeComparison(model);
  if (model.template === "heat-population-comparison") return renderHeatPopulationComparison(model);
  if (model.template === "groenkaart-urban-atlas-comparison") return renderGroenkaartUrbanAtlasComparison(model);
  if (model.template === "income") return renderIncome(model);
  if (model.template === "population") return renderPopulation(model);
  if (model.template === "metric-summary") return renderMetricSummary(model);
  throw new Error(`Unknown sector panel template '${model.template}'.`);
}

/** Render the About view from the same safe content helpers as result panels. */
export function renderAboutPanelModel(model) {
  return renderAbout(model.methodology, model.urbanAtlas, model.income, model.population, model.provenance, model.officialLayers);
}
