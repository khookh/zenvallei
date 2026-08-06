import { formatDate, formatNumber, t } from "./i18n.js";
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
  return `${record.municipality} Â· ${record.sectorId}`;
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
      <p class="panel-eyebrow">${escapeHtml(record.municipality)} Â· ${escapeHtml(record.sectorId)}</p>
      <h2 id="panel-title">${escapeHtml(record.sectorName)}</h2>
      <div class="score-hero ${isScored ? "" : "score-hero--status"}" style="--hero-color:${selectedColor}">
        <div class="score-orb"><strong>${formatScore(isScored ? selectedValue : null)}</strong>${isScored ? "<span>/ 10</span>" : ""}</div>
        <div><span class="score-caption">${escapeHtml(statusLabel(record, selectedMetric))}</span><p>${escapeHtml(heatMetricInterpretation(record, selectedMetric))}</p></div>
      </div>
      <p class="relative-note"><span aria-hidden="true">â†—</span> ${escapeHtml(t("score.relativeNote"))}</p>
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
      <p class="relative-note"><span aria-hidden="true">â—‡</span> ${escapeHtml(t("landCover.eyebrow", { year: landCover.activeYear }))}</p>
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
          <p>${escapeHtml(t("landCoveã´¶‰žËkºwµçM¥Ñ¥½¹…Ñ”¤°(€€€€€€€€€€€Ñ¡É•Í¡½±è™½Éµ…Ñ9Õµ‰•È¡å•…É…Ñ„ü¹Ñ¡É•Í¡½±°€Ì¤°(€€€€€€€€€ô¤¥ôð½Àø(€€€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹µ•Ñ¡½‘½±½åQ•áÐˆ¤¥ôð½Àø(€€€€€€€€€€‘í…±¥‰É…Ñ¥½¸€ü€ñ Ðø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹…±¥‰É…Ñ¥½¹Q¥Ñ±”ˆ¤¥ôð½ Ðø(€€€€€€€€€€€€ñÕ°ø(€€€€€€€€€€€€€€ñ±¤ø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹…±¥‰É…Ñ¥½¹M…µÁ±•Ìˆ°ì(€€€€€€€€€€€€€€€Á½Í¥Ñ¥Ù”è™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹Á½Í¥Ñ¥Ù”¹½Õ¹Ð°€À¤°(€€€€€€€€€€€€€€€¹•…Ñ¥Ù”è™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹¹•…Ñ¥Ù”¹½Õ¹Ð°€À¤°(€€€€€€€€€€€€€ô¤¥ôð½±¤ø(€€€€€€€€€€€€€€ñ±¤ø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹…±¥‰É…Ñ¥½¹A•É™½Éµ…¹”ˆ°ì(€€€€€€€€€€€€€€€Í•¹Í¥Ñ¥Ù¥Ñäè™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹Í•¹Í¥Ñ¥Ù¥Ñä€¨€ÄÀÀ°€Ä¤°(€€€€€€€€€€€€€€€ÍÁ•¥™¥¥Ñäè™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹ÍÁ•¥™¥¥Ñä€¨€ÄÀÀ°€Ä¤°(€€€€€€€€€€€€€€€‰…±…¹•è™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹‰…±…¹•‘ÕÉ…ä€¨€ÄÀÀ°€Ä¤°(€€€€€€€€€€€€€€€…ÕŒè™½Éµ…Ñ9Õµ‰•È¡…±¥‰É…Ñ¥½¸¹…ÕŒ°€Ì¤°(€€€€€€€€€€€€€ô¤¥ôð½±¤ø(€€€€€€€€€€€€ð½Õ°ù€€è€ˆ‰ô(€€€€€€€€€€ñÀøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡Ð ‰Á…¹•°¹Ý…É¹¥¹1…‰•°ˆ¤¥ôð½ÍÑÉ½¹œø€‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹…±¥‰É…Ñ¥½¹…Ù•…Ðˆ¤¥ôð½Àø(€€€€€€€€€€ñÀøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡Ð ‰Á…¹•°¹Ý…É¹¥¹1…‰•°ˆ¤¥ôð½ÍÑÉ½¹œø€‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹±…ÍÍ¥™¥…Ñ¥½¹…Ù•…Ðˆ¤¥ôð½Àø(€€€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ù••Ñ…Ñ¥½¸ü¹Í½ÕÉ”ü¹…ÑÑÉ¥‰ÕÑ¥½¸€üüÐ ‰Ù••Ñ…Ñ¥½¸¹…ÑÑÉ¥‰ÕÑ¥½¸ˆ¤¥ôð½Àø(€€€€€€€€€€‘ì¡å•…É…Ñ„ü¹ÁÉ½‘ÕÑÌ€üüÙ••Ñ…Ñ¥½¸ü¹Í½ÕÉ”ü¹ÁÉ½‘ÕÑÌ¤ü¹±•¹Ñ €ü€ñ Ðø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹Í½ÕÉ•AÉ½‘ÕÑÌˆ¤¥ôð½ ÐøñÕ°ø‘ì¡å•…É…Ñ„ü¹ÁÉ½‘ÕÑÌ€üüÙ••Ñ…Ñ¥½¸¹Í½ÕÉ”¹ÁÉ½‘ÕÑÌ¤¹µ…À ¡ÁÉ½‘ÕÐ¤€ôø€ñ±¤ø‘í•Í…Á•!Ñµ°¡ÁÉ½‘ÕÐ¹¥¥ôð½±¤ù€¤¹©½¥¸ ˆˆ¥ôð½Õ°ù€€è€ˆ‰ô(€€€€€€€€€€‘íÙ••Ñ…Ñ¥½¸ü¹Í½ÕÉ”ü¹…•ÍÍ•‘Ð€ü€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰±…¹‘½Ù•È¹…•ÍÍ•ˆ°ì‘…Ñ”è™½Éµ…Ñ…Ñ”¡Ù••Ñ…Ñ¥½¸¹Í½ÕÉ”¹…•ÍÍ•‘Ð¤ô¤¥ôð½Àù€€è€ˆ‰ô(€€€€€€€€€€‘íÙ••Ñ…Ñ¥½¸ü¹•¹•É…Ñ•‘Ð€ü€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰±…¹‘½Ù•È¹•¹•É…Ñ•‘Ðˆ°ì‘…Ñ”è™½Éµ…Ñ…Ñ”¡Ù••Ñ…Ñ¥½¸¹•¹•É…Ñ•‘Ð¤ô¤¥ôð½Àù€€è€ˆ‰ô(€€€€€€€€€€ñ Ðø‘í•Í…Á•!Ñµ°¡Ð ‰Á…¹•°¹Í½ÕÉ•Ìˆ¤¥ôð½ Ðø(€€€€€€€€€€‘íÍ½ÕÉ•1¥¹­Ì¡µ•Ñ¡½‘½±½ä°±…¹‘½Ù•È°ÕÉ‰…¹Ñ±…Ì°Ù••Ñ…Ñ¥½¸¥ô(€€€€€€€€ð½‘¥Øø(€€€€€€ð½‘•Ñ…¥±Ìø(€€€€ð½‘¥Øù€ì)ô()™Õ¹Ñ¥½¸…‰½ÕÑ1…å•É…É¡­•ä°±…‰•°¤ì(€É•ÑÕÉ¸€ñ…ÉÑ¥±”ø(€€€€ñÍÁ…¸±…ÍÌô‰…‰½ÕÐµ±…å•ÈµÑ…œˆø‘í•Í…Á•!Ñµ°¡±…‰•°¥ôð½ÍÁ…¸ø(€€€€ñ Ðø‘í•Í…Á•!Ñµ°¡Ð¡…‰½ÕÐ¸‘í­•åõEÕ•ÍÑ¥½¹€¤¥ôð½ Ðø(€€€€ñ‘°±…ÍÌô‰…‰½ÕÐµ±…å•Èµ™…ÑÌˆø(€€€€€€ñ‘¥Øøñ‘Ðø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹‘…Ñ…1…‰•°ˆ¤¥ôð½‘Ðøñ‘ø‘í•Í…Á•!Ñµ°¡Ð¡…‰½ÕÐ¸‘í­•åõQ•áÑ€¤¥ôð½‘øð½‘¥Øø(€€€€€€ñ‘¥Øøñ‘Ðø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ½‘Õ•É1…‰•°ˆ¤¥ôð½‘Ðøñ‘ø‘í•Í…Á•!Ñµ°¡Ð¡…‰½ÕÐ¸‘í­•åõAÉ½‘Õ•É€¤¥ôð½‘øð½‘¥Øø(€€€€€€ñ‘¥Øøñ‘Ðø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹É••¹Ý…Ù•1…‰•°ˆ¤¥ôð½‘Ðøñ‘ø‘í•Í…Á•!Ñµ°¡Ð¡…‰½ÕÐ¸‘í­•åõÉ••¹Ý…Ù•€¤¥ôð½‘øð½‘¥Øø(€€€€ð½‘°ø(€€ð½…ÉÑ¥±”ù€ì)ô()™Õ¹Ñ¥½¸É•¹‘•É‰½ÕÐ¡µ•Ñ¡½‘½±½ä°±…¹‘½Ù•È°ÕÉ‰…¹Ñ±…Ì°Ù••Ñ…Ñ¥½¸°ÁÉ½Ù•¹…¹”¤ì(€½¹ÍÐÍ•Ñ½É½Õ¹Ð€ôÁÉ½Ù•¹…¹”ü¹½ÕÑÁÕÐü¹Í•Ñ½É½Õ¹Ð€üü€ÄÔÐì(€É•ÑÕÉ¸€(€€€€ñ‘¥Ø±…ÍÌô‰Á…¹•°µ¡•É¼Á…¹•°µ¡•É¼´µ…‰½ÕÐˆø(€€€€€€ñÀ±…ÍÌô‰Á…¹•°µ•å•‰É½Üˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹•å•‰É½Üˆ°ì½Õ¹ÐèÍ•Ñ½É½Õ¹Ðô¤¥ôð½Àø(€€€€€€ñ È¥ô‰Á…¹•°µÑ¥Ñ±”ˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Ñ¥Ñ±”ˆ¤¥ôð½ Èø(€€€€€€ñÀ±…ÍÌô‰…‰½ÕÐµ¥¹ÑÉ¼ˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹¥¹ÑÉ¼ˆ¤¥ôð½Àø(€€€€ð½‘¥Øø(€€€€ñ‘¥Ø±…ÍÌô‰Á…¹•°µ‰½‘ä…‰½ÕÐµ‰½‘äˆø(€€€€€€ñÍ•Ñ¥½¸ø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ¡•…‘¥¹œˆøñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÍÑ…ÉÑ-¥­•Èˆ¤¥ôð½Àøñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹¡½ÝQ¼ˆ¤¥ôð½ Ìøð½‘¥Øø(€€€€€€€€ñ½°±…ÍÌô‰…‰½ÕÐµÍÑ•ÁÌˆø(€€€€€€€€€€ñ±¤øñÍÁ…¸øÄð½ÍÁ…¸øñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÍÑ•ÀÄˆ¤¥ôð½Àøð½±¤ø(€€€€€€€€€€ñ±¤øñÍÁ…¸øÈð½ÍÁ…¸øñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÍÑ•ÀÈˆ¤¥ôð½Àøð½±¤ø(€€€€€€€€€€ñ±¤øñÍÁ…¸øÌð½ÍÁ…¸øñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÍÑ•ÀÌˆ¤¥ôð½Àøð½±¤ø(€€€€€€€€ð½½°ø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸ø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ¡•…‘¥¹œˆøñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹±…å•ÉÍ-¥­•Èˆ¤¥ôð½Àøñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹±…å•ÉÍQ¥Ñ±”ˆ¤¥ôð½ Ìøð½‘¥Øø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰…‰½ÕÐµ±…å•Èµ…Ñ•½Éäˆø(€€€€€€€€€€ñ Ð±…ÍÌô‰…‰½ÕÐµ…Ñ•½ÉäµÑ¥Ñ±”ˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹…Ñ•½Éå!•…Ðˆ¤¥ôð½ Ðø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…‰½ÕÐµ±…å•Èµ±¥ÍÐˆø(€€€€€€€€€€€€‘í…‰½ÕÑ1…å•É…É ‰¡•…Ðˆ°Ð ‰±…å•ÉÌ¹¡•…Ðˆ¤¥ô(€€€€€€€€€€ð½‘¥Øø(€€€€€€€€ð½‘¥Øø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰…‰½ÕÐµ±…å•Èµ…Ñ•½Éäˆø(€€€€€€€€€€ñ Ð±…ÍÌô‰…‰½ÕÐµ…Ñ•½ÉäµÑ¥Ñ±”ˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹…Ñ•½Éå1…¹‘É••¸ˆ¤¥ôð½ Ðø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…‰½ÕÐµ±…å•Èµ±¥ÍÐˆø(€€€€€€€€€€€€‘í…‰½ÕÑ1…å•É…É ‰±…¹‘½Ù•Èˆ°Ð ‰±…å•ÉÌ¹±…¹‘½Ù•Èˆ°ìå•…Èè±…¹‘½Ù•Èü¹…Ñ¥Ù•e•…È€üü€ÈÀÈÀô¤¥ô(€€€€€€€€€€€€‘í…‰½ÕÑ1…å•É…É ‰ÕÉ‰…¹Ñ±…Ìˆ°Ð ‰±…å•ÉÌ¹ÕÉ‰…¹Ñ±…Ìˆ°ìå•…ÈèÕÉ‰…¹Ñ±…Ìü¹…Ñ¥Ù•e•…È€üü€ÈÀÈÄô¤¥ô(€€€€€€€€€€€€‘í…‰½ÕÑ1…å•É…É ‰Ù••Ñ…Ñ¥½¸ˆ°Ð ‰±…å•ÉÌ¹Ù••Ñ…Ñ¥½¸ˆ°ìå•…ÈèÙ••Ñ…Ñ¥½¸ü¹…Ñ¥Ù•e•…È€üü€ÈÀÈÀô¤¥ô(€€€€€€€€€€ð½‘¥Øø(€€€€€€€€ð½‘¥Øø(€€€€€€€€ñÀ±…ÍÌô‰½µÁ…É¥Í½¸µ…Ù•…Ðˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹½µÁ…É•…Ù•…Ðˆ¤¥ôð½Àø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸±…ÍÌô‰…‰½ÕÐµ¹½Ñ”…‰½ÕÐµÍ•Ñ½ÉÌˆø(€€€€€€€€ñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Í•Ñ½ÉÍ-¥­•Èˆ¤¥ôð½Àø(€€€€€€€€ñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Í•Ñ½ÉÍQ¥Ñ±”ˆ¤¥ôð½ Ìø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Í•Ñ½ÉÍQ•áÐˆ°ì½Õ¹ÐèÍ•Ñ½É½Õ¹Ðô¤¥ôð½Àø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Í•Ñ½ÉÍ½µÁ…Ñ¥‰¥±¥Ñäˆ¤¥ôð½Àø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸±…ÍÌô‰…‰½ÕÐµ¹½Ñ”…‰½ÕÐµ™½Õ¹‘…Ñ¥½¹Ìˆø(€€€€€€€€ñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹™½Õ¹‘…Ñ¥½¹-¥­•Èˆ¤¥ôð½Àø(€€€€€€€€ñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹™½Õ¹‘…Ñ¥½¹Q¥Ñ±”ˆ¤¥ôð½ Ìø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ½Ù•¹…¹••½µ•ÑÉäˆ¤¥ôð½Àø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ½Ù•¹…¹•	…Í•µ…Àˆ¤¥ôð½Àø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸±…ÍÌô‰…‰½ÕÐµ¹½Ñ”…‰½ÕÐµÁÉ¥Ù…äˆø(€€€€€€€€ñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ¥Ù…å-¥­•Èˆ¤¥ôð½Àø(€€€€€€€€ñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ¥Ù…åQ¥Ñ±”ˆ¤¥ôð½ Ìø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ¥Ù…åÁÁ±¥…Ñ¥½¸ˆ¤¥ôð½Àø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ¥Ù…å!½ÍÑ¥¹œˆ¤¥ôð½Àø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÁÉ¥Ù…åQ¥±•Ìˆ¤¥ôð½Àø(€€€€€€€€ñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹½¹Ñ…ÑQ•áÐˆ¤¥ô€ñ„¡É•˜ô‰µ…¥±Ñ¼éÍÑ•™…¹½‘½¹¹•µ…¥°¹½´ˆùÍÑ•™…¹½‘½¹¹•µ…¥°¹½´ð½„ø¸ð½Àø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸ø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰Í•Ñ¥½¸µ¡•…‘¥¹œˆøñÀ±…ÍÌô‰Í•Ñ¥½¸µ­¥­•Èˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹µ•Ñ¡½‘½±½å-¥­•Èˆ¤¥ôð½Àøñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹µ•Ñ¡½‘½±½åQ¥Ñ±”ˆ¤¥ôð½ Ìøð½‘¥Øø(€€€€€€€€ñ‘•Ñ…¥±Ì±…ÍÌô‰‘•Ñ…¥°µ…½É‘¥½¸…‰½ÕÐµµ•Ñ¡½ˆ‘…Ñ„µÍ•Ñ¥½¸ô‰…‰½ÕÐµ¡•…Ðµµ•Ñ¡½‘½±½äˆø(€€€€€€€€€€ñÍÕµµ…Éä‘…Ñ„µ™½ÕÌµ­•äô‰…‰½ÕÐµ¡•…Ðµµ•Ñ¡½‘½±½äµÍÕµµ…ÉäˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹¡•…Ñ5•Ñ¡½‘Q¥Ñ±”ˆ¤¥ôð½ÍÁ…¸øð½ÍÕµµ…Éäø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…½É‘¥½¸µ½¹Ñ•¹Ðµ•Ñ¡½‘½±½äµ½ÁäˆøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹¡•…Ñ5•Ñ¡½‘Q•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹¹½…Ñ…Q•áÐˆ¤¥ôð½Àøð½‘¥Øø(€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€€€ñ‘•Ñ…¥±Ì±…ÍÌô‰‘•Ñ…¥°µ…½É‘¥½¸…‰½ÕÐµµ•Ñ¡½ˆ‘…Ñ„µÍ•Ñ¥½¸ô‰…‰½ÕÐµ±…¹µ½Ù•Èµµ•Ñ¡½‘½±½äˆø(€€€€€€€€€€ñÍÕµµ…Éä‘…Ñ„µ™½ÕÌµ­•äô‰…‰½ÕÐµ±…¹µ½Ù•Èµµ•Ñ¡½‘½±½äµÍÕµµ…ÉäˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹±…¹‘½Ù•É5•Ñ¡½‘Q¥Ñ±”ˆ¤¥ôð½ÍÁ…¸øð½ÍÕµµ…Éäø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…½É‘¥½¸µ½¹Ñ•¹Ðµ•Ñ¡½‘½±½äµ½ÁäˆøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰±…¹‘½Ù•È¹ÁÉ½‘ÕÑ¥½¹Q•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰±…¹‘½Ù•È¹µ•Ñ¡½‘½±½åQ•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰±…¹‘½Ù•È¹½µÁ…É¥Í½¹]…É¹¥¹œˆ¤¥ôð½Àøð½‘¥Øø(€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€€€ñ‘•Ñ…¥±Ì±…ÍÌô‰‘•Ñ…¥°µ…½É‘¥½¸…‰½ÕÐµµ•Ñ¡½ˆ‘…Ñ„µÍ•Ñ¥½¸ô‰…‰½ÕÐµÕÉ‰…¸µ…Ñ±…Ìµµ•Ñ¡½‘½±½äˆø(€€€€€€€€€€ñÍÕµµ…Éä‘…Ñ„µ™½ÕÌµ­•äô‰…‰½ÕÐµÕÉ‰…¸µ…Ñ±…Ìµµ•Ñ¡½‘½±½äµÍÕµµ…ÉäˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹ÕÉ‰…¹Ñ±…Í5•Ñ¡½‘Q¥Ñ±”ˆ¤¥ôð½ÍÁ…¸øð½ÍÕµµ…Éäø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…½É‘¥½¸µ½¹Ñ•¹Ðµ•Ñ¡½‘½±½äµ½ÁäˆøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰ÕÉ‰…¹Ñ±…Ì¹ÁÉ½‘ÕÑ¥½¹Q•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰ÕÉ‰…¹Ñ±…Ì¹µ•Ñ¡½‘½±½åQ•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰ÕÉ‰…¹Ñ±…Ì¹…•ÍÍ]…É¹¥¹œˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰ÕÉ‰…¹Ñ±…Ì¹½µÁ…É¥Í½¹]…É¹¥¹œˆ¤¥ôð½Àøð½‘¥Øø(€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€€€ñ‘•Ñ…¥±Ì±…ÍÌô‰‘•Ñ…¥°µ…½É‘¥½¸…‰½ÕÐµµ•Ñ¡½ˆ‘…Ñ„µÍ•Ñ¥½¸ô‰…‰½ÕÐµÙ••Ñ…Ñ¥½¸µµ•Ñ¡½‘½±½äˆø(€€€€€€€€€€ñÍÕµµ…Éä‘…Ñ„µ™½ÕÌµ­•äô‰…‰½ÕÐµÙ••Ñ…Ñ¥½¸µµ•Ñ¡½‘½±½äµÍÕµµ…ÉäˆøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Ù••Ñ…Ñ¥½¹5•Ñ¡½‘Q¥Ñ±”ˆ¤¥ôð½ÍÁ…¸øð½ÍÕµµ…Éäø(€€€€€€€€€€ñ‘¥Ø±…ÍÌô‰…½É‘¥½¸µ½¹Ñ•¹Ðµ•Ñ¡½‘½±½äµ½ÁäˆøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹µ•Ñ¡½‘½±½åQ•áÐˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹…±¥‰É…Ñ¥½¹…Ù•…Ðˆ¤¥ôð½ÀøñÀø‘í•Í…Á•!Ñµ°¡Ð ‰Ù••Ñ…Ñ¥½¸¹±…ÍÍ¥™¥…Ñ¥½¹…Ù•…Ðˆ¤¥ôð½Àøð½‘¥Øø(€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€€€ñÍ•Ñ¥½¸±…ÍÌô‰…‰½ÕÐµÍ½ÕÉ•Ìˆø(€€€€€€€€ñ Ìø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹Í½ÕÉ•ÍQ¥Ñ±”ˆ¤¥ôð½ Ìø(€€€€€€€€‘íÍ½ÕÉ•1¥¹­Ì¡µ•Ñ¡½‘½±½ä°±…¹‘½Ù•È°ÕÉ‰…¹Ñ±…Ì°Ù••Ñ…Ñ¥½¸¥ô(€€€€€€€€ñÀ±…ÍÌô‰…‰½ÕÐµ…Ù•…Ðˆø‘í•Í…Á•!Ñµ°¡Ð ‰…‰½ÕÐ¹…Ù•…Ðˆ¤¥ôð½Àø(€€€€€€ð½Í•Ñ¥½¸ø(€€€€ð½‘¥Øù€ì)ô()™Õ¹Ñ¥½¸É•¹‘•É5•ÑÉ¥MÕµµ…Éä¡µ½‘•°¤ì(€½¹ÍÐÙ…±Õ”€ô9Õµ‰•È¹¥Í¥¹¥Ñ”¡µ½‘•°¹Ù…±Õ”¤€ü™½Éµ…Ñ9Õµ‰•È¡µ½‘•°¹Ù…±Õ”¤€èÐ ‰Ù…±Õ”¹¹½ÑÙ…¥±…‰±”ˆ¤ì(€½¹ÍÐÕ¹¥Ð€ôµ½‘•°¹Õ¹¥Ð€üü€ˆ”ˆì(€½¹ÍÐ½±½È€ôµ½‘•°¹½±½È€üü€ˆŒÁˆÙ”Øäˆì(€É•ÑÕÉ¸€(€€€€ñ‘¥Ø±…ÍÌô‰Á…¹•°µ¡•É¼±…¹µ½Ù•Èµ¡•É¼ˆø(€€€€€€ñÀ±…ÍÌô‰Á…¹•°µ•å•‰É½Üˆø‘í•Í…Á•!Ñµ°¡µ½‘•°¹É•½É¹µÕ¹¥¥Á…±¥Ñä¥ôƒ
Ü€‘í•Í…Á•!Ñµ°¡µ½‘•°¹É•½É¹Í•Ñ½É%¥ôð½Àø(€€€€€€ñ È¥ô‰Á…¹•°µÑ¥Ñ±”ˆø‘í•Í…Á•!Ñµ°¡µ½‘•°¹É•½É¹Í•Ñ½É9…µ”¥ôð½ Èø(€€€€€€ñ‘¥Ø±…ÍÌô‰Í½É”µ¡•É¼ˆÍÑå±”ôˆ´µ¡•É¼µ½±½Èè‘í•Í…Á•!Ñµ°¡½±½È¥ôˆø(€€€€€€€€ñ‘¥Ø±…ÍÌô‰Í½É”µ½ÉˆˆøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡Ù…±Õ”¥ôð½ÍÑÉ½¹œøñÍÁ…¸ø‘í•Í…Á•!Ñµ°¡Õ¹¥Ð¥ôð½ÍÁ…¸øð½‘¥Øø(€€€€€€€€ñ‘¥ØøñÍÁ…¸±…ÍÌô‰Í½É”µ…ÁÑ¥½¸ˆø‘í•Í…Á•!Ñµ°¡µ½‘•°¹Ñ¥Ñ±”¥ôð½ÍÁ…¸ø‘íµ½‘•°¹‘•ÍÉ¥ÁÑ¥½¸€ü€ñÀø‘í•Í…Á•!Ñµ°¡µ½‘•°¹‘•ÍÉ¥ÁÑ¥½¸¥ôð½Àù€€è€ˆ‰ôð½‘¥Øø(€€€€€€ð½‘¥Øø(€€€€ð½‘¥Øø(€€€€‘íµ½‘•°¹¹½Ñ•Ìü¹±•¹Ñ €ü€ñ‘¥Ø±…ÍÌô‰Á…¹•°µ‰½‘äµ•Ñ¡½‘½±½äµ½Áäˆø‘íµ½‘•°¹¹½Ñ•Ì¹µ…À ¡¹½Ñ”¤€ôø€ñÀø‘í•Í…Á•!Ñµ°¡¹½Ñ”¥ôð½Àù€¤¹©½¥¸ ˆˆ¥ôð½‘¥Øù€€è€ˆ‰õ€ì)ô((¼¨¨I•¹‘•È„Á±…¥¸Á…¹•°µ½‘•°ÍÕÁÁ±¥•‰ä„±…å•Èµ½‘Õ±”¸€¨¼)•áÁ½ÉÐ™Õ¹Ñ¥½¸É•¹‘•ÉM•Ñ½ÉA…¹•±5½‘•°¡µ½‘•°¤ì(€¥˜€¡µ½‘•°¹Ñ•µÁ±…Ñ”€ôôô€‰¡•…Ðˆ¤ì(€€€É•ÑÕÉ¸É•¹‘•É!•…ÑI•½É¡µ½‘•°¹É•½É°µ½‘•°¹µ•Ñ¡½‘½±½ä°µ½‘•°¹±…¹‘½Ù•È°µ½‘•°¹ÕÉ‰…¹Ñ±…Ì°µ½‘•°¹Ù••Ñ…Ñ¥½¸°µ½‘•°¹¡•…Ñ5•ÑÉ¥Œ¤ì(€ô(€¥˜€¡µ½‘•°¹Ñ•µÁ±…Ñ”€ôôô€‰±…¹µ½Ù•Èˆ¤ì(€€€É•ÑÕÉ¸É•¹‘•É1…¹‘½Ù•ÉI•½É¡µ½‘•°¹É•½É°µ½‘•°¹µ•Ñ¡½‘½±½ä°µ½‘•°¹±…¹‘½Ù•È°µ½‘•°¹ÕÉ‰…¹Ñ±…Ì°µ½‘•°¹Ù••Ñ…Ñ¥½¸¤ì(€ô(€¥˜€¡µ½‘•°¹Ñ•µÁ±…Ñ”€ôôô€‰ÕÉ‰…¸µ…Ñ±…Ìˆ¤ì(€€€É•ÑÕÉ¸É•¹‘•ÉUÉ‰…¹Ñ±…ÍI•½É¡µ½‘•°¹É•½É°µ½‘•°¹µ•Ñ¡½‘½±½ä°µ½‘•°¹±…¹‘½Ù•È°µ½‘•°¹ÕÉ‰…¹Ñ±…Ì°µ½‘•°¹Ù••Ñ…Ñ¥½¸¤ì(€ô(€¥˜€¡µ½‘•°¹Ñ•µÁ±…Ñ”€ôôô€‰Ù••Ñ…Ñ¥½¸ˆ¤ì(€€€É•ÑÕÉ¸É•¹‘•ÉY••Ñ…Ñ¥½¹I•½É¡µ½‘•°¹É•½É°µ½‘•°¹µ•Ñ¡½‘½±½ä°µ½‘•°¹±…¹‘½Ù•È°µ½‘•°¹ÕÉ‰…¹Ñ±…Ì°µ½‘•°¹Ù••Ñ…Ñ¥½¸¤ì(€ô(€¥˜€¡µ½‘•°¹Ñ•µÁ±…Ñ”€ôôô€‰µ•ÑÉ¥ŒµÍÕµµ…Éäˆ¤É•ÑÕÉ¸É•¹‘•É5•ÑÉ¥MÕµµ…Éä¡µ½‘•°¤ì(€Ñ¡É½Ü¹•ÜÉÉ½È¡U¹­¹½Ý¸Í•Ñ½ÈÁ…¹•°Ñ•µÁ±…Ñ”€œ‘íµ½‘•°¹Ñ•µÁ±…Ñ•ôœ¹€¤ì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸É•…Ñ••Ñ…¥±A…¹•°¡ì(€Á…¹•°°(€½¹Ñ•¹Ð°(€±½Í•	ÕÑÑ½¸°(€•ÑA…¹•±5½‘•°°(€•Ñ‰½ÕÑ5½‘•°°(€¡•…Ñ5•ÑÉ¥Œ€ôU1Q}!Q}5QI%°(€½¹1…å•É=ÁÑ¥½¹¡…¹”°(€½¹±½Í”°)ô¤ì(€¥˜€¡ÑåÁ•½˜•ÑA…¹•±5½‘•°€„ôô€‰™Õ¹Ñ¥½¸ˆñðÑåÁ•½˜•Ñ‰½ÕÑ5½‘•°€„ôô€‰™Õ¹Ñ¥½¸ˆ¤ì(€€€Ñ¡É½Ü¹•ÜQåÁ•ÉÉ½È ‰Q¡”‘•Ñ…¥°Á…¹•°É•ÅÕ¥É•Ì±…å•Èµ½Ý¹•Á…¹•°…¹…‰½ÕÐµ½‘•°ÁÉ½Ù¥‘•ÉÌ¸ˆ¤ì(€ô((€±•ÐÉ•ÑÕÉ¹½ÕÍ±•µ•¹Ð€ô¹Õ±°ì(€±•ÐÕÉÉ•¹ÑY¥•Ü€ô¹Õ±°ì(€±•Ð…Ñ¥Ù•!•…Ñ5•ÑÉ¥Œ€ô¹½Éµ…±¥é•!•…Ñ5•ÑÉ¥Œ¡¡•…Ñ5•ÑÉ¥Œ¤ì((€½¹ÍÐ…ÁÑÕÉ•I•¹‘•ÉMÑ…Ñ”€ô€ ¤€ôø€¡ì(€€€½Á•¹M•Ñ¥½¹Ìèl¸¸¹½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰‘•Ñ…¥±Ím½Á•¹um‘…Ñ„µÍ•Ñ¥½¹tˆ¥t¹µ…À ¡•±•µ•¹Ð¤€ôø•±•µ•¹Ð¹‘…Ñ…Í•Ð¹Í•Ñ¥½¸¤°(€€€¡…‘áÁ…¹‘•‘M•Ñ¥½¸è	½½±•…¸¡½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ‰‘•Ñ…¥±Ím½Á•¹tˆ¤¤°(€€€™½ÕÍ-•äè½¹Ñ•¹Ð¹½¹Ñ…¥¹Ì¡‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ð¤€ü‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ð¹‘…Ñ…Í•Ð¹™½ÕÍ-•ä€è¹Õ±°°(€ô¤ì((€½¹ÍÐÉ•¹‘•ÉÕÉÉ•¹ÑY¥•Ü€ô€¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”€ôÑÉÕ”°™½ÕÍA…¹•°€ô™…±Í”ô€ôíô¤€ôøì(€€€¥˜€ …ÕÉÉ•¹ÑY¥•Ü¤É•ÑÕÉ¸ì(€€€½¹ÍÐÉ•¹‘•ÉMÑ…Ñ”€ôÁÉ•Í•ÉÙ•MÑ…Ñ”€ü…ÁÑÕÉ•I•¹‘•ÉMÑ…Ñ” ¤€èì½Á•¹M•Ñ¥½¹Ìèmt°¡…‘áÁ…¹‘•‘M•Ñ¥½¸è™…±Í”°™½ÕÍ-•äè¹Õ±°ôì(€€€¥˜€¡ÕÉÉ•¹ÑY¥•Ü¹ÑåÁ”€ôôô€‰…‰½ÕÐˆ¤ì(€€€€€½¹ÍÐµ½‘•°€ô•Ñ‰½ÕÑ5½‘•° ¤ì(€€€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ôÉ•¹‘•É‰½ÕÐ¡µ½‘•°¹µ•Ñ¡½‘½±½ä°µ½‘•°¹±…¹‘½Ù•È°µ½‘•°¹ÕÉ‰…¹Ñ±…Ì°µ½‘•°¹Ù••Ñ…Ñ¥½¸°µ½‘•°¹ÁÉ½Ù•¹…¹”¤ì(€€€ô•±Í”ì(€€€€€½¹Ñ•¹Ð¹¥¹¹•É!Q50€ôÉ•¹‘•ÉM•Ñ½ÉA…¹•±5½‘•°¡•ÑA…¹•±5½‘•°¡ÕÉÉ•¹ÑY¥•Ü¹±…å•É%°ÕÉÉ•¹ÑY¥•Ü¹É•½É°ì(€€€€€€€¡•…Ñ5•ÑÉ¥Œè…Ñ¥Ù•!•…Ñ5•ÑÉ¥Œ°(€€€€€ô¤¤ì(€€€ô(€€€±•ÐÉ•ÍÑ½É•‘M•Ñ¥½¸€ô™…±Í”ì(€€€É•¹‘•ÉMÑ…Ñ”¹½Á•¹M•Ñ¥½¹Ì¹™½É…  ¡Í•Ñ¥½¹%¤€ôøì(€€€€€½¹ÍÐµ…Ñ¡¥¹M•Ñ¥½¸€ôl¸¸¹½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰‘•Ñ…¥±Ím‘…Ñ„µÍ•Ñ¥½¹tˆ¥t(€€€€€€€€¹™¥¹ ¡•±•µ•¹Ð¤€ôø•±•µ•¹Ð¹‘…Ñ…Í•Ð¹Í•Ñ¥½¸€ôôôÍ•Ñ¥½¹%¤ì(€€€€€¥˜€¡µ…Ñ¡¥¹M•Ñ¥½¸¤ì(€€€€€€€µ…Ñ¡¥¹M•Ñ¥½¸¹Í•ÑÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì(€€€€€€€É•ÍÑ½É•‘M•Ñ¥½¸€ôÑÉÕ”ì(€€€€€ô(€€€ô¤ì(€€€¥˜€¡É•¹‘•ÉMÑ…Ñ”¹¡…‘áÁ…¹‘•‘M•Ñ¥½¸€˜˜€…É•ÍÑ½É•‘M•Ñ¥½¸¤½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È ‰‘•Ñ…¥±Ím‘…Ñ„µÍ•Ñ¥½¹tˆ¤ü¹Í•ÑÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì(€€€¥˜€¡É•¹‘•ÉMÑ…Ñ”¹™½ÕÍ-•ä¤ì(€€€€€l¸¸¹½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µ™½ÕÌµ­•åtˆ¥t(€€€€€€€€¹™¥¹ ¡•±•µ•¹Ð¤€ôø•±•µ•¹Ð¹‘…Ñ…Í•Ð¹™½ÕÍ-•ä€ôôôÉ•¹‘•ÉMÑ…Ñ”¹™½ÕÍ-•ä¤(€€€€€€€€ü¹™½ÕÌ¡ìÁÉ•Ù•¹ÑMÉ½±°èÑÉÕ”ô¤ì(€€€ô•±Í”¥˜€¡™½ÕÍA…¹•°¤ì(€€€€€É•ÅÕ•ÍÑ¹¥µ…Ñ¥½¹É…µ”  ¤€ôøÁ…¹•°¹™½ÕÌ¡ìÁÉ•Ù•¹ÑMÉ½±°èÑÉÕ”ô¤¤ì(€€€ô(€ôì((€½¹ÍÐ±½Í”€ô€¡ìÉ•ÍÑ½É•½ÕÌ€ôÑÉÕ”ô€ôíô¤€ôøì(€€€½¹ÍÐ±½Í•‘Y¥•Ü€ôÕÉÉ•¹ÑY¥•Üì(€€€ÕÉÉ•¹ÑY¥•Ü€ô¹Õ±°ì(€€€Á…¹•°¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ‰¥Ìµ½Á•¸ˆ¤ì(€€€Á…¹•°¹Í•ÑÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰ÑÉÕ”ˆ¤ì(€€€½¹±½Í”ü¸¡±½Í•‘Y¥•Ü¤ì(€€€¥˜€¡É•ÍÑ½É•½ÕÌ€˜˜É•ÑÕÉ¹½ÕÍ±•µ•¹Ð¥¹ÍÑ…¹•½˜!Q51±•µ•¹Ð¤É•ÑÕÉ¹½ÕÍ±•µ•¹Ð¹™½ÕÌ ¤ì(€ôì((€½¹ÍÐÍ¡½Ü€ô€¡Ù¥•Ü°ÑÉ¥•É±•µ•¹Ð¤€ôøì(€€€É•ÑÕÉ¹½ÕÍ±•µ•¹Ð€ôÑÉ¥•É±•µ•¹Ð¥¹ÍÑ…¹•½˜!Q51±•µ•¹Ð€üÑÉ¥•É±•µ•¹Ð€è‘½Õµ•¹Ð¹…Ñ¥Ù•±•µ•¹Ðì(€€€ÕÉÉ•¹ÑY¥•Ü€ôÙ¥•Üì(€€€É•¹‘•ÉÕÉÉ•¹ÑY¥•Ü¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”è™…±Í”°™½ÕÍA…¹•°èÑÉÕ”ô¤ì(€€€Á…¹•°¹±…ÍÍ1¥ÍÐ¹…‘ ‰¥Ìµ½Á•¸ˆ¤ì(€€€Á…¹•°¹Í•ÑÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰™…±Í”ˆ¤ì(€ôì((€½¹ÍÐ½Á•¸€ô€¡É•½É°ÑÉ¥•É±•µ•¹Ð€ô¹Õ±°°±…å•É%€ô€‰¡•…Ðˆ¤€ôøÍ¡½Ü¡ìÑåÁ”è€‰É•½Éˆ°É•½É°±…å•É%ô°ÑÉ¥•É±•µ•¹Ð¤ì(€½¹ÍÐ½Á•¹‰½ÕÐ€ô€¡ÑÉ¥•É±•µ•¹Ð€ô¹Õ±°¤€ôøÍ¡½Ü¡ìÑåÁ”è€‰…‰½ÕÐˆô°ÑÉ¥•É±•µ•¹Ð¤ì(€½¹ÍÐÍ•ÑA…¹•±1…¹Õ…”€ô€ ¤€ôøì(€€€¥˜€¡ÕÉÉ•¹ÑY¥•Ü€˜˜Á…¹•°¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¥Ìµ½Á•¸ˆ¤¤É•¹‘•ÉÕÉÉ•¹ÑY¥•Ü¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”èÑÉÕ”ô¤ì(€ôì(€½¹ÍÐÍ•ÑÑ¥Ù•1…å•È€ô€¡±…å•É%¤€ôøì(€€€¥˜€¡ÕÉÉ•¹ÑY¥•Üü¹ÑåÁ”€„ôô€‰É•½Éˆ¤É•ÑÕÉ¸ì(€€€ÕÉÉ•¹ÑY¥•Ü¹±…å•É%€ô±…å•É%ì(€€€¥˜€¡Á…¹•°¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¥Ìµ½Á•¸ˆ¤¤É•¹‘•ÉÕÉÉ•¹ÑY¥•Ü¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”èÑÉÕ”ô¤ì(€ôì(€½¹ÍÐÍ•Ñ!•…Ñ5•ÑÉ¥Œ€ô€¡µ•ÑÉ¥Œ¤€ôøì(€€€…Ñ¥Ù•!•…Ñ5•ÑÉ¥Œ€ô¹½Éµ…±¥é•!•…Ñ5•ÑÉ¥Œ¡µ•ÑÉ¥Œ¤ì(€€€¥˜€¡ÕÉÉ•¹ÑY¥•Üü¹ÑåÁ”€ôôô€‰É•½Éˆ€˜˜ÕÉÉ•¹ÑY¥•Ü¹±…å•É%€ôôô€‰¡•…Ðˆ€˜˜Á…¹•°¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¥Ìµ½Á•¸ˆ¤¤ì(€€€€€É•¹‘•ÉÕÉÉ•¹ÑY¥•Ü¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”èÑÉÕ”ô¤ì(€€€ô(€ôì((€±½Í•	ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø±½Í” ¤¤ì(€Á…¹•°¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰­•å‘½Ý¸ˆ°€¡•Ù•¹Ð¤€ôøì(€€€¥˜€¡•Ù•¹Ð¹­•ä€ôôô€‰Í…Á”ˆ¤±½Í” ¤ì(€ô¤ì(€½¹Ñ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€¡•Ù•¹Ð¤€ôøì(€€€½¹ÍÐ‰ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µÁ…¹•°µ¡•…Ðµµ•ÑÉ¥tˆ¤ì(€€€¥˜€ …‰ÕÑÑ½¸¤É•ÑÕÉ¸ì(€€€½¹1…å•É=ÁÑ¥½¹¡…¹”ü¸ ‰µ•ÑÉ¥Œˆ°‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Á…¹•±!•…Ñ5•ÑÉ¥Œ°‰ÕÑÑ½¸¤ì(€ô¤ì(€½¹Ñ•¹Ð¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰­•å‘½Ý¸ˆ°€¡•Ù•¹Ð¤€ôøì(€€€½¹ÍÐ‰ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µÁ…¹•°µ¡•…Ðµµ•ÑÉ¥tˆ¤ì(€€€¥˜€ …‰ÕÑÑ½¸ñð€…l‰ÉÉ½Ý1•™Ðˆ°€‰ÉÉ½ÝI¥¡Ð‰t¹¥¹±Õ‘•Ì¡•Ù•¹Ð¹­•ä¤¤É•ÑÕÉ¸ì(€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€½¹ÍÐ‰ÕÑÑ½¹Ì€ôl¸¸¹½¹Ñ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° ‰m‘…Ñ„µÁ…¹•°µ¡•…Ðµµ•ÑÉ¥tˆ¥tì(€€€½¹ÍÐÕÉÉ•¹Ñ%¹‘•à€ô‰ÕÑÑ½¹Ì¹¥¹‘•á=˜¡‰ÕÑÑ½¸¤ì(€€€½¹ÍÐ‘¥É•Ñ¥½¸€ô•Ù•¹Ð¹­•ä€ôôô€‰ÉÉ½ÝI¥¡Ðˆ€ü€Ä€è€´Äì(€€€‰ÕÑÑ½¹Íl¡ÕÉÉ•¹Ñ%¹‘•à€¬‘¥É•Ñ¥½¸€¬‰ÕÑÑ½¹Ì¹±•¹Ñ ¤€”‰ÕÑÑ½¹Ì¹±•¹Ñ¡t¹™½ÕÌ ¤ì(€ô¤ì(€É•ÑÕÉ¸ì(€€€½Á•¸°(€€€½Á•¹‰½ÕÐ°(€€€±½Í”°(€€€Í•Ñ1…¹Õ…”èÍ•ÑA…¹•±1…¹Õ…”°(€€€Í•ÑÑ¥Ù•1…å•È°(€€€Í•Ñ!•…Ñ5•ÑÉ¥Œ°(€€€É•™É•Í è€ ¤€ôøÉ•¹‘•ÉÕÉÉ•¹ÑY¥•Ü¡ìÁÉ•Í•ÉÙ•MÑ…Ñ”èÑÉÕ”ô¤°(€€€¥Í=Á•¸è€ ¤€ôøÁ…¹•°¹±…ÍÍ1¥ÍÐ¹½¹Ñ…¥¹Ì ‰¥Ìµ½Á•¸ˆ¤°(€€€¥Í5Õ¹¥¥Á…±¥ÑåMÕµµ…Éäè€ ¤€ôøÕÉÉ•¹ÑY¥•Üü¹ÑåÁ”€ôôô€‰É•½Éˆ€˜˜ÕÉÉ•¹ÑY¥•Ü¹É•½É¹Í½Á”€ôôô€‰µÕ¹¥¥Á…±¥Ñäˆ°(€ôì)ô(