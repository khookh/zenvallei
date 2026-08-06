import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { MAP_CONFIG } from "./config.js";
import { findSectorFromQuery, loadApplicationData, sectorSearchLabel, sectorsForMunicipality } from "./data.js";
import { DEFAULT_HEAT_METRIC } from "./heat-metric.js";
import { DEFAULT_LANGUAGE, applyDocumentTranslations, formatDate, getLanguage, setLanguage, t } from "./i18n.js";
import { buildLayerRegistry } from "./layers/registry.js";
import { categoryLabel, LAYER_CATEGORIES } from "./layers/categories.js";
import { createMapController } from "./map-controller.js";
import { createDetailPanel } from "./panel.js";
import { createProjectIntro } from "./project-intro.js";

const elements = {
  map: document.querySelector("#map"),
  mapControls: document.querySelector("#map-controls"),
  mapControlsBody: document.querySelector("#map-controls-body"),
  mapControlsToggle: document.querySelector("#map-controls-toggle"),
  mapControlsToggleIcon: document.querySelector("#map-controls-toggle-icon"),
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
  layerSwitch: document.querySelector("#layer-switch"),
  layerButtons: [],
  layerCategoryHeadings: [],
  heatMetricControl: document.querySelector("#heat-metric-control"),
  heatMetricSwitch: document.querySelector(".heat-metric-switch"),
  heatMetricButtons: [...document.querySelectorAll("[data-heat-metric]")],
  vegetationYearControl: document.querySelector("#vegetation-year-control"),
  vegetationYearSlider: document.querySelector("#vegetation-year-slider"),
  vegetationYearOutput: document.querySelector("#vegetation-year-output"),
  vegetationYearDate: document.querySelector("#vegetation-year-date"),
  vegetationYearPrevious: document.querySelector("#vegetation-year-previous"),
  vegetationYearNext: document.querySelector("#vegetation-year-next"),
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
  projectIntro: document.querySelector("#project-intro"),
  projectIntroClose: document.querySelector("#project-intro-close"),
  projectIntroPrimary: document.querySelector("#project-intro-primary"),
  projectIntroLanguage: document.querySelector("#project-intro-language"),
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
  mapControlsCollapsed: false,
  projectIntro: null,
};

const activeLayer = () => application.layers?.get(application.activeLayer);
const supportsMunicipalitySummary = () => ["land-cover", "urban-atlas", "vegetation"].includes(application.activeLayer);

function updateMapControlsDisclosure({ refreshMap = true } = {}) {
  const collapsed = application.mapControlsCollapsed;
  const label = t(collapsed ? "controls.expand" : "controls.collapse");

  elements.mapControlsToggle.hidden = false;
  elements.mapControlsToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.mapControlsToggle.setAttribute("aria-label", label);
  elements.mapControlsToggle.title = label;
  elements.mapControlsToggleIcon.textContent = collapsed ? "+" : "\u2212";
  elements.mapControlsBody.hidden = collapsed;
  elements.mapControls.classList.toggle("is-collapsed", collapsed);

  if (refreshMap) {
    requestAnimationFrame(() => application.mapController?.refreshLayout());
  }
}

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
  } else if (announcement.type === "vegetationYear") {
    elements.announcement.textContent = t("announcement.vegetationYearChanged", { year: announcement.year });
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
  elements.layerCategoryHeadings.forEach(({ category, heading }) => {
    heading.textContent = categoryLabel(category);
  });
  elements.layerButtons.forEach((button) => {
    const layer = application.layers.get(button.dataset.layer);
    const available = Boolean(layer?.isAvailable());
    button.textContent = layer?.getLabel() ?? button.dataset.layer;
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(application.activeLayer === layer?.id));
    button.classList.toggle("is-active", application.activeLayer === layer?.id);
  });
}

function createLayerControls() {
  const fragment = document.createDocumentFragment();
  elements.layerButtons = [];
  elements.layerCategoryHeadings = [];

  LAYER_CATEGORIES.forEach((category) => {
    const section = document.createElement("section");
    section.className = "layer-category";
    section.dataset.layerCategory = category.id;

    const heading = document.createElement("h3");
    heading.id = `layer-category-${category.id}`;
    heading.className = "layer-category-title";
    heading.textContent = categoryLabel(category);
    elements.layerCategoryHeadings.push({ category, heading });

    const group = document.createElement("div");
    group.className = "layer-category-options";
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", heading.id);

    [...application.layers.values()]
      .filter((layer) => layer.categoryId === category.id)
      .forEach((layer) => {
        const button = document.createElement("button");
        button.className = "layer-button";
        button.type = "button";
        button.dataset.layer = layer.id;
        button.setAttribute("aria-pressed", "false");
        group.append(button);
        elements.layerButtons.push(button);
      });

    section.append(heading, group);
    fragment.append(section);
  });

  elements.layerSwitch.replaceChildren(fragment);
}

function updateSecondaryControls() {
  const control = activeLayer()?.getSecondaryControl?.() ?? null;
  elements.heatMetricControl.hidden = !control;
  if (control) {
    elements.heatMetricSwitch.setAttribute("aria-label", control.ariaLabel);
    elements.heatMetricButtons.forEach((button) => {
      const option = control.options.find((entry) => entry.id === button.dataset.heatMetric);
      if (!option) return;
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(option.active));
      button.classList.toggle("is-active", option.active);
    });
  }

  const showYears = application.activeLayer === "vegetation"
    && application.data?.vegetation?.available
    && application.data.vegetation.availableYears?.length > 1;
  elements.vegetationYearControl.hidden = !showYears;
  if (!showYears) return;
  const years = [...application.data.vegetation.availableYears].sort((left, right) => left - right);
  const activeYear = Number(application.mapController?.getLayerOption("vegetation", "year")
    ?? application.data.vegetation.activeYear);
  const index = Math.max(0, years.indexOf(activeYear));
  const yearData = application.data.vegetation.years[activeYear];
  elements.vegetationYearSlider.min = "0";
  elements.vegetationYearSlider.max = String(Math.max(0, years.length - 1));
  elements.vegetationYearSlider.value = String(index);
  elements.vegetationYearSlider.setAttribute("aria-valuetext", String(activeYear));
  elements.vegetationYearOutput.value = String(activeYear);
  elements.vegetationYearOutput.textContent = String(activeYear);
  elements.vegetationYearDate.textContent = t("vegetation.yearObservation", {
    date: formatDate(yearData?.acquisitionDate),
  });
  elements.vegetationYearPrevious.disabled = index === 0;
  elements.vegetationYearNext.disabled = index === years.length - 1;
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
  const footnote = model.footnote ? document.createElement("p") : null;
  if (footnote) {
    footnote.className = "legend-footnote";
    footnote.textContent = model.footnote;
  }

  if (model.layout === "scale") {
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    scale.append(...model.groups[0].items.map((item) => createLegendItem(item, { score: true })));
    const statuses = document.createElement("div");
    statuses.className = "legend-statuses";
    statuses.append(...(model.groups[1]?.items ?? []).map((item) => createLegendItem(item)));
    elements.legend.replaceChildren(scale, statuses, ...(footnote ? [footnote] : []));
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
  elements.legend.replaceChildren(wrapper, ...(footnote ? [footnote] : []));
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
  updateMapControlsDisclosure({ refreshMap: false });
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
  application.projectIntro?.setLanguage();
  updateAnnouncement();
}

application.projectIntro = createProjectIntro({
  dialog: elements.projectIntro,
  closeButton: elements.projectIntroClose,
  primaryButton: elements.projectIntroPrimary,
  languageButton: elements.projectIntroLanguage,
  focusAfterClose: elements.aboutButton,
  getLanguage,
  translate: t,
  onLanguageChange: applyLanguage,
});
setLanguage(DEFAULT_LANGUAGE);
applyLanguage(DEFAULT_LANGUAGE);
application.projectIntro.open();
elements.languageToggle.addEventListener("click", () => {
  applyLanguage(getLanguage() === "nl" ? "en" : "nl");
});
elements.mapControlsToggle.addEventListener("click", () => {
  application.mapControlsCollapsed = !application.mapControlsCollapsed;
  updateMapControlsDisclosure();
});

async function start() {
  performance.mark("heat-map-start");
  const data = await loadApplicationData();
  application.data = data;
  application.layers = buildLayerRegistry(data, { initialHeatMetric: application.activeHeatMetric });
  createLayerControls();
  updateLayerControls();
  updateSecondaryControls();
  updateLayerContext();
  renderLegend();
  populateMunicipalities(data.provenance);
  populateSectorOptions(data.scores);

  let selectedSectorId = "";
  const municipalityRecord = (municipality) => ({
    scope: "municipality",
    municipality,
    sectorName: municipality,
    sectorId: "",
    sectorCount: data.provenance.output.municipalityCounts[municipality] ?? 0,
  });
  const sharedPanelData = {
    methodology: data.methodology,
    landCover: data.landCover,
    urbanAtlas: data.urbanAtlas,
    vegetation: data.vegetation,
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
    onClose: (closedView) => {
      selectedSectorId = "";
      application.mapController?.setSelected("");
      application.announcement = { type: "closed" };
      updateAnnouncement();
      if (closedView?.type === "record" && closedView.record.scope !== "municipality"
        && elements.municipality.value && supportsMunicipalitySummary()) {
        queueMicrotask(() => panel.open(
          municipalityRecord(elements.municipality.value),
          elements.municipality,
          application.activeLayer,
        ));
      }
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

  function activateVegetationYear(year) {
    const numericYear = Number(year);
    if (application.activeLayer !== "vegetation") return false;
    if (numericYear === application.mapController.getLayerOption("vegetation", "year")) return false;
    if (!application.mapController.setLayerOption("vegetation", "year", numericYear)) return false;
    updateLayerControls();
    updateSecondaryControls();
    updateLayerContext();
    updateDatasetStatus();
    renderLegend();
    panel.refresh();
    application.announcement = { type: "vegetationYear", year: numericYear };
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
    if (!selectedSectorId && municipality && supportsMunicipalitySummary()) {
      panel.open(municipalityRecord(municipality), elements.municipality, application.activeLayer);
    } else if (!municipality && panel.isMunicipalitySummary?.()) {
      panel.close({ restoreFocus: false });
    }
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
  const vegetationYears = () => [...(data.vegetation?.availableYears ?? [])].sort((left, right) => left - right);
  elements.vegetationYearSlider.addEventListener("input", () => {
    const years = vegetationYears();
    activateVegetationYear(years[Number(elements.vegetationYearSlider.value)]);
  });
  elements.vegetationYearPrevious.addEventListener("click", () => {
    const years = vegetationYears();
    const current = application.mapController.getLayerOption("vegetation", "year");
    activateVegetationYear(years[Math.max(0, years.indexOf(current) - 1)]);
  });
  elements.vegetationYearNext.addEventListener("click", () => {
    const years = vegetationYears();
    const current = application.mapController.getLayerOption("vegetation", "year");
    activateVegetationYear(years[Math.min(years.length - 1, years.indexOf(current) + 1)]);
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
      if (selectedSectorId) {
        panel.setActiveLayer(layerId);
      } else if (elements.municipality.value && supportsMunicipalitySummary()) {
        panel.open(municipalityRecord(elements.municipality.value), button, layerId);
      } else if (panel.isMunicipalitySummary?.()) {
        panel.close({ restoreFocus: false });
      }
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
