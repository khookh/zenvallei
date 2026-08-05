import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { MAP_CONFIG } from "./config.js";
import { findSectorFromQuery, loadApplicationData, sectorSearchLabel, sectorsForMunicipality } from "./data.js";
import { DEFAULT_HEAT_METRIC } from "./heat-metric.js";
import { DEFAULT_LANGUAGE, applyDocumentTranslations, getLanguage, setLanguage, t } from "./i18n.js";
import { createMapController } from "./map-controller.js";
import { createDetailPanel } from "./panel.js";

const elements = {
  map: document.querySelector("#map"),
  activeLayerTitle: document.querySelector("#active-layer-title"),
  datasetStatus: document.querySelector("#dataset-status span:last-child"),
  languageToggle: document.querySelector("#language-toggle"),
  municipality: document.querySelector("#municipality-select"),
  sectorSearch: document.querySelector("#sector-search"),
  sectorOptions: document.querySelector("#sector-options"),
  resetView: document.querySelector("#reset-view"),
  visibleCount: document.querySelector("#visible-count"),
  legendDisclosure: document.querySelector("#legend"),
  legend: document.querySelector("#legend-content"),
  legendTitle: document.querySelector("#legend-title"),
  legendNote: document.querySelector("#legend-note"),
  layerButtons: [...document.querySelectorAll("[data-layer]")],
  heatMetricControl: document.querySelector("#heat-metric-control"),
  heatMetricButtons: [...document.querySelectorAll("[data-heat-metric]")],
  layerContextMeta: document.querySelector("#layer-context-meta"),
  layerContextCopy: document.querySelector("#layer-context-copy"),
  layerHelp: document.querySelector("#layer-help"),
  detailPanel: document.querySelector("#detail-panel"),
  panelContent: document.querySelector("#panel-content"),
  panelClose: document.querySelector("#panel-close"),
  mapLoading: document.querySelector("#map-loading"),
  errorBanner: document.querySelector("#error-banner"),
  errorMessage: document.querySelector("#error-message"),
  announcement: document.querySelector("#selection-announcement"),
  aboutButton: document.querySelector("#about-button"),
};

const application = {
  scores: null,
  methodology: null,
  landCover: null,
  urbanAtlas: null,
  provenance: null,
  panel: null,
  mapController: null,
  datasetState: "loading",
  basemapUnavailable: false,
  fatalError: null,
  announcement: null,
  activeLayer: "heat",
  activeHeatMetric: DEFAULT_HEAT_METRIC,
};

function updateLanguageButton() {
  const targetLanguage = getLanguage() === "nl" ? "en" : "nl";
  const label = t(targetLanguage === "en" ? "language.switchEnglish" : "language.switchDutch");
  elements.languageToggle.textContent = targetLanguage.toUpperCase();
  elements.languageToggle.lang = targetLanguage;
  elements.languageToggle.setAttribute("aria-label", label);
  elements.languageToggle.title = label;
}

function updateDatasetStatus() {
  if (application.datasetState === "error") {
    elements.datasetStatus.textContent = t("dataset.unavailable");
  } else if (application.datasetState === "ready" && application.basemapUnavailable) {
    elements.datasetStatus.textContent = t("dataset.basemapUnavailable");
  } else if (application.datasetState === "ready") {
    if (application.activeLayer === "land-cover") {
      elements.datasetStatus.textContent = t("dataset.readyLandCover", {
        year: application.landCover?.activeYear ?? 2020,
      });
    } else if (application.activeLayer === "urban-atlas") {
      elements.datasetStatus.textContent = t("dataset.readyUrbanAtlas", {
        year: application.urbanAtlas?.activeYear ?? 2021,
      });
    } else {
      const count = application.provenance?.output.sectorCount ?? 154;
      elements.datasetStatus.textContent = application.activeHeatMetric === DEFAULT_HEAT_METRIC
        ? t("dataset.readyHeat", { count })
        : t("dataset.readyHeatMetric", {
          count,
          metric: t(`heatMetric.scoreName.${application.activeHeatMetric}`),
        });
    }
  } else {
    elements.datasetStatus.textContent = t("loading.data");
  }
}

function updateAnnouncement() {
  if (!application.announcement) return;
  if (application.announcement.type === "opened") {
    elements.announcement.textContent = t("announcement.opened", application.announcement.record);
  } else if (application.announcement.type === "layer") {
    elements.announcement.textContent = t("announcement.layerChanged", {
      layer: layerLabel(application.announcement.layerId),
    });
  } else if (application.announcement.type === "heatMetric") {
    elements.announcement.textContent = t("announcement.heatMetricChanged", {
      metric: heatMetricLabel(application.announcement.metric),
    });
  } else if (application.announcement.type === "unavailable") {
    elements.announcement.textContent = t("announcement.layerUnavailable", {
      layer: layerLabel(application.announcement.layerId),
      reason: t(application.announcement.reasonKey),
    });
  } else {
    elements.announcement.textContent = t("announcement.closed");
  }
}

function errorMessageFor(error) {
  if (error?.code === "overlay-timeout") return t("error.overlayTimeout");
  return error ? t("error.default") : t("error.unknown");
}

function showFatalError(error) {
  application.datasetState = "error";
  application.fatalError = error;
  elements.mapLoading.hidden = true;
  elements.errorBanner.hidden = false;
  elements.errorMessage.textContent = errorMessageFor(error);
  updateDatasetStatus();
  console.error(error);
}

function layerLabel(layerId) {
  if (layerId === "land-cover") return t("layers.landCover", { year: application.landCover?.activeYear ?? 2020 });
  if (layerId === "urban-atlas") return t("layers.urbanAtlas", { year: application.urbanAtlas?.activeYear ?? 2021 });
  return t("layers.heat");
}

function heatMetricLabel(metric = application.activeHeatMetric) {
  return t(`heatMetric.${metric}`);
}

function activeLayerPresentationLabel() {
  if (application.activeLayer !== "heat" || application.activeHeatMetric === DEFAULT_HEAT_METRIC) {
    return layerLabel(application.activeLayer);
  }
  return t("layers.heatWithMetric", { metric: heatMetricLabel() });
}

function updateLayerControls() {
  elements.layerButtons.forEach((button) => {
    const layerId = button.dataset.layer;
    const available = layerId === "heat"
      || (layerId === "land-cover" && application.landCover?.raster?.available)
      || (layerId === "urban-atlas" && application.urbanAtlas?.available && application.urbanAtlas?.geojsonUrl);
    button.textContent = layerLabel(layerId);
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(application.activeLayer === layerId));
    button.classList.toggle("is-active", application.activeLayer === layerId);
  });
}

function updateHeatMetricControls() {
  elements.heatMetricControl.hidden = application.activeLayer !== "heat";
  elements.heatMetricButtons.forEach((button) => {
    const active = button.dataset.heatMetric === application.activeHeatMetric;
    button.textContent = heatMetricLabel(button.dataset.heatMetric);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-active", active);
  });
}

function updateLayerContext() {
  const count = application.provenance?.output.sectorCount ?? 154;
  const context = application.activeLayer === "land-cover"
    ? {
      metaKey: "layers.context.landCoverMeta",
      textKey: "layers.context.landCoverText",
      parameters: { year: application.landCover?.activeYear ?? 2020 },
    }
    : application.activeLayer === "urban-atlas"
      ? {
        metaKey: "layers.context.urbanAtlasMeta",
        textKey: "layers.context.urbanAtlasText",
        parameters: { year: application.urbanAtlas?.activeYear ?? 2021 },
      }
      : {
        metaKey: application.activeHeatMetric === "heat"
          ? "layers.context.heatScoreMeta"
          : application.activeHeatMetric === "vulnerability"
            ? "layers.context.vulnerabilityMeta"
            : "layers.context.heatMeta",
        textKey: application.activeHeatMetric === "heat"
          ? "layers.context.heatScoreText"
          : application.activeHeatMetric === "vulnerability"
            ? "layers.context.vulnerabilityText"
            : "layers.context.heatText",
        parameters: { count },
      };
  const label = activeLayerPresentationLabel();
  elements.activeLayerTitle.textContent = label;
  elements.layerContextMeta.textContent = t(context.metaKey, context.parameters);
  elements.layerContextCopy.textContent = t(context.textKey, context.parameters);
  elements.map.setAttribute("aria-label", t("map.regionForLayer", { layer: label }));
}

function renderLegend(methodology, layerId = application.activeLayer) {
  if (layerId === "land-cover") {
    elements.legendTitle.textContent = t("legend.landCoverTitle", { year: application.landCover.activeYear });
    elements.legendNote.textContent = "LCM-10";
    const classes = application.landCover.classes.filter((entry) => entry.present);
    elements.legend.innerHTML = `<div class="land-cover-legend">${classes.map((entry) => `
      <span><i style="--swatch:${entry.color}"></i>${t(`class.${entry.key}`)}</span>`).join("")}</div>`;
    return;
  }
  if (layerId === "urban-atlas") {
    const groupOrder = ["artificialSurfaces", "greenUrbanAreas", "agricultureSemiNatural", "wetlands", "water", "noData"];
    const presentClasses = application.urbanAtlas.classes.filter((entry) => entry.present);
    elements.legendTitle.textContent = t("legend.urbanAtlasTitle", { year: application.urbanAtlas.activeYear });
    elements.legendNote.textContent = `UA ${application.urbanAtlas.activeYear}`;
    elements.legend.innerHTML = `<div class="urban-atlas-legend">${groupOrder.map((groupKey) => {
      const entries = presentClasses.filter((entry) => entry.groupKey === groupKey);
      if (!entries.length) return "";
      return `<section><h3>${t(`urbanAtlas.group.${groupKey}`)}</h3><div>${entries.map((entry) => `
        <span><i style="--swatch:${entry.color}"></i>${t(`urbanAtlas.class.${entry.code}`)}</span>`).join("")}</div></section>`;
    }).join("")}</div>`;
    return;
  }
  elements.legendTitle.textContent = application.activeHeatMetric === "heat"
    ? t("legend.heatTitle")
    : application.activeHeatMetric === "vulnerability"
      ? t("legend.vulnerabilityTitle")
      : t("legend.title");
  elements.legendNote.textContent = "0–10";
  const scores = Array.from({ length: 11 }, (_, score) => `
    <div class="legend-item legend-score"><span style="--swatch:${methodology.palette[`score-${score}`]}"></span><b>${score}</b></div>`).join("");
  elements.legend.innerHTML = `
    <div class="legend-scale">${scores}</div>
    <div class="legend-statuses">
      <span><i style="--swatch:${methodology.palette["no-data"]}"></i>${t("legend.noData")}</span>
      <span><i style="--swatch:${methodology.palette["institution-present-no-score"]}"></i>${t("legend.institution")}</span>
    </div>`;
}

function populateMunicipalities(provenance) {
  Object.keys(provenance.output.municipalityCounts).sort((a, b) => a.localeCompare(b, "nl")).forEach((municipality) => {
    const option = document.createElement("option");
    option.value = municipality;
    option.textContent = municipality;
    elements.municipality.append(option);
  });
}

function populateSectorOptions(scores, municipality = "") {
  const records = sectorsForMunicipality(scores, municipality);
  elements.sectorOptions.replaceChildren(...records.map((record) => {
    const option = document.createElement("option");
    option.value = sectorSearchLabel(record);
    return option;
  }));
  elements.visibleCount.textContent = t("count.sectors", { count: records.length });
  return records;
}

function applyLanguage(language) {
  setLanguage(language);
  applyDocumentTranslations();
  updateLanguageButton();
  updateDatasetStatus();
  updateLayerControls();
  updateHeatMetricControls();
  updateLayerContext();
  if (application.methodology) renderLegend(application.methodology, application.activeLayer);
  if (application.scores) populateSectorOptions(application.scores, elements.municipality.value);
  if (elements.sectorSearch.validity.customError) elements.sectorSearch.setCustomValidity(t("search.invalid"));
  if (application.fatalError) elements.errorMessage.textContent = errorMessageFor(application.fatalError);
  if (application.announcement?.type === "unavailable") {
    elements.layerHelp.textContent = t(application.announcement.reasonKey);
  }
  application.panel?.setLanguage();
  application.mapController?.setLanguage();
  updateAnnouncement();
}

setLanguage(DEFAULT_LANGUAGE);
applyLanguage(DEFAULT_LANGUAGE);
elements.languageToggle.addEventListener("click", () => {
  applyLanguage(getLanguage() === "nl" ? "en" : "nl");
});

async function start() {
  performance.mark("heat-map-start");
  const { geojson, scores, methodology, provenance, landCover, urbanAtlas } = await loadApplicationData();
  application.scores = scores;
  application.methodology = methodology;
  application.landCover = landCover;
  application.urbanAtlas = urbanAtlas;
  application.provenance = provenance;
  updateLayerControls();
  updateHeatMetricControls();
  updateLayerContext();
  renderLegend(methodology, application.activeLayer);
  populateMunicipalities(provenance);
  populateSectorOptions(scores);

  let selectedSectorId = "";
  const panel = createDetailPanel({
    panel: elements.detailPanel,
    content: elements.panelContent,
    closeButton: elements.panelClose,
    methodology,
    landCover,
    urbanAtlas,
    provenance,
    heatMetric: application.activeHeatMetric,
    onHeatMetricChange: (metric) => activateHeatMetric(metric),
    onClose: () => {
      selectedSectorId = "";
      application.mapController?.setSelected("");
      application.announcement = { type: "closed" };
      updateAnnouncement();
    },
  });
  application.panel = panel;

  function activateHeatMetric(metric) {
    if (application.activeLayer !== "heat" || metric === application.activeHeatMetric) return false;
    if (!application.mapController?.setHeatMetric(metric)) return false;
    application.activeHeatMetric = metric;
    updateHeatMetricControls();
    updateLayerContext();
    updateDatasetStatus();
    renderLegend(methodology, "heat");
    panel.setHeatMetric(metric);
    application.announcement = { type: "heatMetric", metric };
    updateAnnouncement();
    return true;
  }

  const selectSector = (sectorId, { source = "search", trigger = null, focus = source !== "map" } = {}) => {
    const record = scores[sectorId];
    if (!record) return;
    selectedSectorId = sectorId;
    application.mapController.setSelected(sectorId, { focus });
    elements.sectorSearch.value = sectorSearchLabel(record);
    panel.open(
      record,
      trigger ?? (source === "search" ? elements.sectorSearch : document.activeElement),
      application.activeLayer,
    );
    application.announcement = {
      type: "opened",
      record: { sector: record.sectorName, municipality: record.municipality },
    };
    updateAnnouncement();
  };

  application.mapController = createMapController({
    container: elements.map,
    geojson,
    scores,
    methodology,
    landCover,
    urbanAtlas,
    config: MAP_CONFIG,
    onSectorSelect: selectSector,
    onBasemapError: () => {
      application.basemapUnavailable = true;
      updateDatasetStatus();
    },
    onUrbanAtlasError: () => {
      if (application.urbanAtlas) application.urbanAtlas.available = false;
      elements.layerHelp.textContent = t("layers.urbanAtlasLoadError");
      updateLayerControls();
    },
  });
  await application.mapController.ready;
  if (window.matchMedia("(max-width: 760px)").matches) {
    elements.legendDisclosure.removeAttribute("open");
    application.mapController.resetView();
  }
  if (import.meta.env.DEV || import.meta.env.MODE === "test") window.__heatMap = application.mapController;
  document.documentElement.dataset.appReady = "true";
  performance.mark("heat-map-ready");
  performance.measure("heat-map-initialization", "heat-map-start", "heat-map-ready");

  elements.municipality.addEventListener("change", () => {
    const municipality = elements.municipality.value;
    populateSectorOptions(scores, municipality);
    elements.sectorSearch.value = "";
    if (selectedSectorId && scores[selectedSectorId]?.municipality !== municipality && municipality) {
      panel.close({ restoreFocus: false });
    }
    application.mapController.setMunicipality(municipality);
  });

  const search = () => {
    const record = findSectorFromQuery(scores, elements.sectorSearch.value);
    if (!record) {
      elements.sectorSearch.setCustomValidity(t("search.invalid"));
      elements.sectorSearch.reportValidity();
      return;
    }
    elements.sectorSearch.setCustomValidity("");
    if (elements.municipality.value && record.municipality !== elements.municipality.value) {
      elements.municipality.value = "";
      populateSectorOptions(scores);
      application.mapController.setMunicipality("");
    }
    selectSector(record.sectorId, { source: "search", trigger: elements.sectorSearch, focus: true });
  };
  elements.sectorSearch.addEventListener("change", search);
  elements.sectorSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      search();
    }
  });
  elements.sectorSearch.addEventListener("input", () => elements.sectorSearch.setCustomValidity(""));

  elements.resetView.addEventListener("click", () => application.mapController.resetView());
  elements.aboutButton.addEventListener("click", () => panel.openAbout(elements.aboutButton));
  elements.heatMetricButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activateHeatMetric(button.dataset.heatMetric);
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = elements.heatMetricButtons.indexOf(button);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      elements.heatMetricButtons[
        (currentIndex + direction + elements.heatMetricButtons.length) % elements.heatMetricButtons.length
      ].focus();
    });
  });
  elements.layerButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const layerId = button.dataset.layer;
      if (button.getAttribute("aria-disabled") === "true") {
        const reasonKey = layerId === "urban-atlas"
          ? (application.urbanAtlas?.loadError ? "layers.urbanAtlasLoadError" : "layers.urbanAtlasUnavailable")
          : "layers.landCoverUnavailable";
        elements.layerHelp.textContent = t(reasonKey);
        application.announcement = { type: "unavailable", layerId, reasonKey };
        updateAnnouncement();
        return;
      }
      button.setAttribute("aria-busy", "true");
      let activated = false;
      try {
        activated = await application.mapController.setLayer(layerId);
      } finally {
        button.removeAttribute("aria-busy");
      }
      if (!activated) {
        const reasonKey = layerId === "urban-atlas" ? "layers.urbanAtlasLoadError" : "layers.landCoverUnavailable";
        elements.layerHelp.textContent = t(reasonKey);
        application.announcement = { type: "unavailable", layerId, reasonKey };
        updateAnnouncement();
        return;
      }
      application.activeLayer = layerId;
      elements.layerHelp.textContent = "";
      updateLayerControls();
      updateHeatMetricControls();
      updateLayerContext();
      updateDatasetStatus();
      renderLegend(methodology, layerId);
      panel.setActiveLayer(layerId);
      application.announcement = { type: "layer", layerId };
      updateAnnouncement();
    });
    button.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = elements.layerButtons.indexOf(button);
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      elements.layerButtons[(currentIndex + direction + elements.layerButtons.length) % elements.layerButtons.length].focus();
    });
  });

  elements.mapLoading.hidden = true;
  application.datasetState = "ready";
  updateDatasetStatus();
}

start().catch(showFatalError);
