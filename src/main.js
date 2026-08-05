import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { MAP_CONFIG } from "./config.js";
import { findSectorFromQuery, loadApplicationData, sectorSearchLabel, sectorsForMunicipality } from "./data.js";
import { DEFAULT_HEAT_METRIC } from "./heat-metric.js";
import { DEFAULT_LANGUAGE, applyDocumentTranslations, getLanguage, setLanguage, t } from "./i18n.js";
import { buildLayerRegistry } from "./layers/registry.js";
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
  heatMetricSwitch: document.querySelector(".heat-metric-switch"),
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

/** @type {{activeLayer: string, activeHeatMetric: string, datasetState: string, [key: string]: any}} */
const application = {
  data: null,
  layers: null,
  panel: null,
  mapController: null,
  datasetState: "loading",
  basemapUnavailable: false,
  fatalError: null,
  announcement: null,
  activeLayer: "heat",
  activeHeatMetric: DEFAULT_HEAT_METRIC,
};

const activeLayer = () => application.layers?.get(application.activeLayer);

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
    return;
  }
  if (application.datasetState === "ready" && application.basemapUnavailable) {
    elements.datasetStatus.textContent = t("dataset.basemapUnavailable");
    return;
  }
  if (application.datasetState === "ready") {
    elements.datasetStatus.textContent = activeLayer().getDatasetStatus({
      sectorCount: application.data.provenance?.output?.sectorCount ?? 154,
    });
    return;
  }
  elements.datasetStatus.textContent = t("loading.data");
}

function updateAnnouncement() {
  const announcement = application.announcement;
  if (!announcement) return;
  if (announcement.type === "opened") {
    elements.announcement.textContent = t("announcement.opened", announcement.record);
  } else if (announcement.type === "layer") {
    elements.announcement.textContent = t("announcement.layerChanged", {
      layer: application.layers.get(announcement.layerId)?.getLabel() ?? announcement.layerId,
    });
  } else if (announcement.type === "heatMetric") {
    elements.announcement.textContent = t("announcement.heatMetricChanged", {
      metric: t(`heatMetric.${announcement.metric}`),
    });
  } else if (announcement.type === "unavailable") {
    elements.announcement.textContent = t("announcement.layerUnavailable", {
      layer: application.layers.get(announcement.layerId)?.getLabel() ?? announcement.layerId,
      reason: t(announcement.reasonKey),
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

function updateLayerControls() {
  if (!application.layers) return;
  elements.layerButtons.forEach((button) => {
    const layer = application.layers.get(button.dataset.layer);
    const available = Boolean(layer?.isAvailable());
    button.textContent = layer?.getLabel() ?? button.dataset.layer;
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(application.activeLayer === layer?.id));
    button.classList.toggle("is-active", application.activeLayer === layer?.id);
  });
}

function updateSecondaryControls() {
  const control = activeLayer()?.getSecondaryControl?.() ?? null;
  elements.heatMetricControl.hidden = !control;
  if (!control) return;
  elements.heatMetricSwitch.setAttribute("aria-label", control.ariaLabel);
  elements.heatMetricButtons.forEach((button) => {
    const option = control.options.find((entry) => entry.id === button.dataset.heatMetric);
    if (!option) return;
    button.textContent = option.label;
    button.setAttribute("aria-pressed", String(option.active));
    button.classList.toggle("is-active", option.active);
  });
}

function updateLayerContext() {
  if (!application.layers) return;
  const layer = activeLayer();
  const context = layer.getContext({ sectorCount: application.data?.provenance?.output?.sectorCount ?? 154 });
  elements.activeLayerTitle.textContent = layer.getLabel();
  elements.layerContextMeta.textContent = context.meta;
  elements.layerContextCopy.textContent = context.text;
  elements.map.setAttribute("aria-label", t("map.regionForLayer", { layer: layer.getLabel() }));
}

function createLegendItem(item, { score = false } = {}) {
  const container = document.createElement(score ? "div" : "span");
  if (score) container.className = "legend-item legend-score";
  const swatch = document.createElement(score ? "span" : "i");
  swatch.style.setProperty("--swatch", item.color);
  const label = document.createElement(score ? "b" : "span");
  label.textContent = item.label;
  container.append(swatch, label);
  return container;
}

function renderLegend() {
  if (!application.layers) return;
  const model = activeLayer().getLegendModel();
  elements.legendTitle.textContent = model.title;
  elements.legendNote.textContent = model.note ?? "";

  if (model.layout === "scale") {
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    scale.append(...model.groups[0].items.map((item) => createLegendItem(item, { score: true })));
    const statuses = document.createElement("div");
    statuses.className = "legend-statuses";
    statuses.append(...(model.groups[1]?.items ?? []).map((item) => createLegendItem(item)));
    elements.legend.replaceChildren(scale, statuses);
    return;
  }

  const hasGroups = model.groups.some((group) => group.title);
  const wrapper = document.createElement("div");
  wrapper.className = hasGroups ? "urban-atlas-legend" : "land-cover-legend";
  model.groups.forEach((group) => {
    if (!group.items.length) return;
    if (hasGroups) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = group.title;
      const items = document.createElement("div");
      items.append(...group.items.map((item) => createLegendItem(item)));
      section.append(heading, items);
      wrapper.append(section);
    } else {
      wrapper.append(...group.items.map((item) => createLegendItem(item)));
    }
  });
  elements.legend.replaceChildren(wrapper);
}

function populateMunicipalities(provenance) {
  Object.keys(provenance.output.municipalityCounts)
    .sort((left, right) => left.localeCompare(right, "nl"))
    .forEach((municipality) => {
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
  if (application.layers) {
    updateLayerControls();
    updateSecondaryControls();
    updateLayerContext();
    renderLegend();
  }
  if (application.data?.scores) populateSectorOptions(application.data.scores, elements.municipality.value);
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
  const data = await loadApplicationData();
  application.data = data;
  application.layers = buildLayerRegistry(data, { initialHeatMetric: application.activeHeatMetric });
  updateLayerControls();
  updateSecondaryControls();
  updateLayerContext();
  renderLegend();
  populateMunicipalities(data.provenance);
  populateSectorOptions(data.scores);

  let selectedSectorId = "";
  const sharedPanelData = {
    methodology: data.methodology,
    landCover: data.landCover,
    urbanAtlas: data.urbanAtlas,
  };
  const panel = createDetailPanel({
    panel: elements.detailPanel,
    content: elements.panelContent,
    closeButton: elements.panelClose,
    getPanelModel: (layerId, record) => application.layers.get(layerId).getPanelModel(record, sharedPanelData),
    getAboutModel: () => ({ ...sharedPanelData, provenance: data.provenance }),
    onLayerOptionChange: (name, value) => {
      if (name === "metric") activateHeatMetric(value);
    },
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
    if (!application.mapController?.setLayerOption("heat", "metric", metric)) return false;
    application.activeHeatMetric = metric;
    updateSecondaryControls();
    updateLayerContext();
    updateDatasetStatus();
    renderLegend();
    panel.refresh();
    application.announcement = { type: "heatMetric", metric };
    updateAnnouncement();
    return true;
  }

  const selectSector = (sectorId, { source = "search", trigger = null, focus = source !== "map" } = {}) => {
    const record = data.scores[sectorId];
    if (!record) return;
    selectedSectorId = sectorId;
    application.mapController.setSelected(sectorId, { focus });
    elements.sectorSearch.value = sectorSearchLabel(record);
    panel.open(record, trigger ?? (source === "search" ? elements.sectorSearch : document.activeElement), application.activeLayer);
    application.announcement = {
      type: "opened",
      record: { sector: record.sectorName, municipality: record.municipality },
    };
    updateAnnouncement();
  };

  application.mapController = createMapController({
    container: elements.map,
    geojson: data.geojson,
    scores: data.scores,
    layers: application.layers,
    config: MAP_CONFIG,
    onSectorSelect: selectSector,
    onBasemapError: () => {
      application.basemapUnavailable = true;
      updateDatasetStatus();
    },
    onLayerError: (layerId, error) => {
      console.error(error);
      const layer = application.layers.get(layerId);
      elements.layerHelp.textContent = t(layer?.getUnavailableReasonKey?.() ?? "error.default");
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
    populateSectorOptions(data.scores, municipality);
    elements.sectorSearch.value = "";
    if (selectedSectorId && data.scores[selectedSectorId]?.municipality !== municipality && municipality) {
      panel.close({ restoreFocus: false });
    }
    application.mapController.setMunicipality(municipality);
  });

  const search = () => {
    const record = findSectorFromQuery(data.scores, elements.sectorSearch.value);
    if (!record) {
      elements.sectorSearch.setCustomValidity(t("search.invalid"));
      elements.sectorSearch.reportValidity();
      return;
    }
    elements.sectorSearch.setCustomValidity("");
    if (elements.municipality.value && record.municipality !== elements.municipality.value) {
      elements.municipality.value = "";
      populateSectorOptions(data.scores);
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
    button.addEventListener("click", () => activateHeatMetric(button.dataset.heatMetric));
    button.addEventListener("keydown", (event) => moveSegmentFocus(event, elements.heatMetricButtons, button));
  });
  elements.layerButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const layerId = button.dataset.layer;
      const layer = application.layers.get(layerId);
      if (!layer?.isAvailable()) {
        const reasonKey = layer?.getUnavailableReasonKey?.() ?? "error.default";
        elements.layerHelp.textContent = t(reasonKey);
        application.announcement = { type: "unavailable", layerId, reasonKey };
        updateAnnouncement();
        return;
      }
      button.setAttribute("aria-busy", "true");
      let activated;
      try {
        activated = await application.mapController.setLayer(layerId);
      } finally {
        button.removeAttribute("aria-busy");
      }
      if (!activated) {
        const reasonKey = layer.getUnavailableReasonKey?.() ?? "error.default";
        elements.layerHelp.textContent = t(reasonKey);
        application.announcement = { type: "unavailable", layerId, reasonKey };
        updateAnnouncement();
        return;
      }
      application.activeLayer = layerId;
      elements.layerHelp.textContent = "";
      updateLayerControls();
      updateSecondaryControls();
      updateLayerContext();
      updateDatasetStatus();
      renderLegend();
      panel.setActiveLayer(layerId);
      application.announcement = { type: "layer", layerId };
      updateAnnouncement();
    });
    button.addEventListener("keydown", (event) => moveSegmentFocus(event, elements.layerButtons, button));
  });

  elements.mapLoading.hidden = true;
  application.datasetState = "ready";
  updateDatasetStatus();
}

function moveSegmentFocus(event, buttons, currentButton) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = buttons.indexOf(currentButton);
  const direction = event.key === "ArrowRight" ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}

start().catch(showFatalError);
