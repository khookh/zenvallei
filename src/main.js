import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { MAP_CONFIG } from "./config.js";
import { findSectorFromQuery, loadApplicationData, sectorSearchLabel, sectorsForMunicipality } from "./data.js";
import { DEFAULT_HEAT_METRIC } from "./heat-metric.js";
import { DEFAULT_LANGUAGE, applyDocumentTranslations, getLanguage, setLanguage, t } from "./i18n.js";
import { buildLayerRegistry } from "./layers/registry.js";
import { categoryLabel, LAYER_CATEGORIES } from "./layers/categories.js";
import { createMapController } from "./map-controller.js";
import { createMapSurfaceLayout } from "./map-surface-layout.js";
import { createDetailPanel } from "./panel.js";
import { createProjectIntro } from "./project-intro.js";
import { safeExternalUrl } from "./security.js";

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
  secondaryControl: document.querySelector("#secondary-control"),
  secondaryPrompt: document.querySelector("#secondary-control-prompt"),
  secondarySwitch: document.querySelector("#secondary-switch"),
  temporalControl: document.querySelector("#temporal-control"),
  temporalLabel: document.querySelector("#temporal-label"),
  temporalSlider: document.querySelector("#temporal-slider"),
  temporalOutput: document.querySelector("#temporal-output"),
  temporalMarkers: document.querySelector("#timeline-markers"),
  temporalPrevious: document.querySelector("#temporal-previous"),
  temporalNext: document.querySelector("#temporal-next"),
  layerContextMeta: document.querySelector("#layer-context-meta"),
  layerContextCopy: document.querySelector("#layer-context-copy"),
  layerContextNote: document.querySelector("#layer-context-note"),
  layerContextSources: document.querySelector("#layer-context-sources"),
  analysisPairing: document.querySelector("#analysis-pairing"),
  analysisCompare: document.querySelector("#analysis-compare"),
  analysisPairResult: document.querySelector("#analysis-pair-result"),
  analysisPairLabel: document.querySelector("#analysis-pair-label"),
  analysisPairChange: document.querySelector("#analysis-pair-change"),
  analysisPairRemove: document.querySelector("#analysis-pair-remove"),
  analysisPickInstruction: document.querySelector("#analysis-pick-instruction"),
  analysisPickCancel: document.querySelector("#analysis-pick-cancel"),
  analysisPairingHelp: document.querySelector("#analysis-pairing-help"),
  analysisPairNote: document.querySelector("#analysis-pair-note"),
  layerHelp: document.querySelector("#layer-help"),
  detailPanel: document.querySelector("#detail-panel"),
  panelContent: document.querySelector("#panel-content"),
  panelClose: document.querySelector("#panel-close"),
  panelToggle: document.querySelector("#panel-toggle"),
  panelPeek: document.querySelector("#panel-peek"),
  panelPeekLabel: document.querySelector("#panel-peek-label"),
  panelPeekValue: document.querySelector("#panel-peek-value"),
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
  analysisPairings: {},
  analysisPickMode: null,
  surfaceLayout: null,
  projectIntro: null,
};

const activeLayer = () => application.layers?.get(application.activeLayer);
const supportsMunicipalitySummary = () => Boolean(activeLayer()?.supportsMunicipalitySummary);

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
  } else if (announcement.type === "temporalValue") {
    elements.announcement.textContent = t("announcement.temporalValueChanged", {
      layer: application.layers.get(announcement.layerId)?.getLabel() ?? announcement.layerId,
      value: announcement.value,
    });
  } else if (announcement.type === "unavailable") {
    elements.announcement.textContent = t("announcement.layerUnavailable", {
      layer: application.layers.get(announcement.layerId)?.getLabel() ?? announcement.layerId,
      reason: t(announcement.reasonKey),
    });
  } else if (announcement.type === "analysisPairing") {
    elements.announcement.textContent = t(announcement.key, announcement.parameters);
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
  elements.layerSwitch.classList.toggle("is-comparison-mode", Boolean(application.analysisPickMode));
  elements.layerCategoryHeadings.forEach(({ category, heading }) => {
    heading.textContent = categoryLabel(category);
  });
  elements.layerButtons.forEach((button) => {
    const layer = application.layers.get(button.dataset.layer);
    const normallyAvailable = Boolean(layer?.isAvailable());
    const pick = application.analysisPickMode;
    const isPrimary = Boolean(pick && layer?.id === pick.primaryLayerId);
    const isCompatible = Boolean(pick?.targetIds.includes(layer?.id));
    const available = pick ? isCompatible : normallyAvailable;
    const label = layer?.getLabel() ?? button.dataset.layer;
    button.replaceChildren();
    if (pick && isCompatible) {
      const icon = document.createElement("span");
      icon.className = "layer-link-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "↔";
      const text = document.createElement("span");
      text.textContent = label;
      button.append(icon, text);
      button.setAttribute("aria-label", t("analysisPairing.target", { layer: label }));
    } else {
      button.textContent = label;
      button.removeAttribute("aria-label");
    }
    if (isPrimary) button.setAttribute("aria-label", t("analysisPairing.locked", { layer: label }));
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(application.activeLayer === layer?.id));
    button.classList.toggle("is-active", application.activeLayer === layer?.id);
    button.classList.toggle("is-comparison-target", isCompatible);
    button.classList.toggle("is-comparison-primary", isPrimary);
    button.classList.toggle("is-comparison-muted", Boolean(pick && !isCompatible && !isPrimary));
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

function updateAnalysisPairing() {
  if (!application.layers) return;
  const layer = activeLayer();
  const targets = (layer?.getAnalysisTargets?.() ?? [])
    .map((id) => application.layers.get(id))
    .filter((candidate) => candidate?.isAvailable());
  const picking = application.analysisPickMode?.primaryLayerId === layer?.id;
  const selectedId = targets.some(({ id }) => id === application.analysisPairings[layer.id])
    ? application.analysisPairings[layer.id]
    : "";
  elements.analysisPairing.hidden = targets.length === 0;
  if (!targets.length) return;
  elements.analysisCompare.hidden = Boolean(selectedId) || picking;
  elements.analysisPairResult.hidden = !selectedId || picking;
  elements.analysisPickInstruction.hidden = !picking;
  elements.analysisPairNote.hidden = !selectedId || picking;
  if (selectedId) {
    elements.analysisPairLabel.textContent = t("analysisPairing.selected", {
      primary: layer.getLabel(),
      secondary: application.layers.get(selectedId).getLabel(),
    });
    elements.analysisPairNote.textContent = t("analysisPairing.previewNote");
  }
  if (picking) {
    elements.analysisPairingHelp.textContent = t("analysisPairing.instruction", { layer: layer.getLabel() });
  }
}

function enterAnalysisPickMode(trigger = elements.analysisCompare) {
  const layer = activeLayer();
  const targetIds = (layer?.getAnalysisTargets?.() ?? [])
    .filter((id) => application.layers.get(id)?.isAvailable());
  if (!targetIds.length) return;
  application.analysisPickMode = { primaryLayerId: layer.id, targetIds, returnFocus: trigger };
  updateLayerControls();
  updateAnalysisPairing();
  application.announcement = {
    type: "analysisPairing",
    key: "analysisPairing.entered",
    parameters: { layer: layer.getLabel() },
  };
  updateAnnouncement();
  requestAnimationFrame(() => elements.layerButtons.find((button) => targetIds.includes(button.dataset.layer))?.focus());
}

function cancelAnalysisPickMode({ restoreFocus = true } = {}) {
  const returnFocus = application.analysisPickMode?.returnFocus;
  if (!application.analysisPickMode) return;
  application.analysisPickMode = null;
  updateLayerControls();
  updateAnalysisPairing();
  application.announcement = { type: "analysisPairing", key: "analysisPairing.cancelled", parameters: {} };
  updateAnnouncement();
  if (restoreFocus && returnFocus instanceof HTMLElement) returnFocus.focus();
}

function selectAnalysisPairing(targetId) {
  const pick = application.analysisPickMode;
  if (!pick?.targetIds.includes(targetId)) return false;
  application.analysisPairings[pick.primaryLayerId] = targetId;
  const primary = application.layers.get(pick.primaryLayerId);
  const secondary = application.layers.get(targetId);
  application.analysisPickMode = null;
  updateLayerControls();
  updateAnalysisPairing();
  application.announcement = {
    type: "analysisPairing",
    key: "analysisPairing.chosen",
    parameters: { primary: primary.getLabel(), secondary: secondary.getLabel() },
  };
  updateAnnouncement();
  elements.analysisPairChange.focus();
  return true;
}

function removeAnalysisPairing() {
  const layer = activeLayer();
  if (!layer || !application.analysisPairings[layer.id]) return;
  delete application.analysisPairings[layer.id];
  updateAnalysisPairing();
  application.announcement = { type: "analysisPairing", key: "analysisPairing.removed", parameters: {} };
  updateAnnouncement();
  elements.analysisCompare.focus();
}

function updateSecondaryControls() {
  const control = activeLayer()?.getSecondaryControl?.() ?? null;
  const isHeatMetric = control?.id === "heat-metric";
  elements.secondaryControl.hidden = !control;
  elements.secondaryControl.id = isHeatMetric ? "heat-metric-control" : "secondary-control";
  elements.secondarySwitch.classList.toggle("heat-metric-switch", isHeatMetric);
  if (control) {
    elements.secondaryPrompt.textContent = control.prompt ?? "";
    elements.secondarySwitch.setAttribute("aria-label", control.ariaLabel);
    elements.secondarySwitch.style.setProperty("--option-count", String(control.options.length));
    elements.secondarySwitch.replaceChildren(...control.options.map((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.secondaryOption = option.id;
      if (isHeatMetric) button.dataset.heatMetric = option.id;
      button.className = isHeatMetric ? "heat-metric-button" : "secondary-option-button";
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(option.active));
      button.classList.toggle("is-active", option.active);
      button.disabled = Boolean(option.disabled);
      if (option.disabled && option.disabledReason) {
        button.title = option.disabledReason;
        button.setAttribute("aria-label", `${option.label}. ${option.disabledReason}`);
      }
      return button;
    }));
  }

  const temporal = activeLayer()?.getTemporalControl?.() ?? null;
  const entries = temporal?.items ?? temporal?.values?.map((value) => ({ value, label: String(value) })) ?? [];
  const showTemporal = entries.length > 1;
  elements.temporalControl.hidden = !showTemporal;
  if (!showTemporal) {
    updateAnalysisPairing();
    return;
  }
  const index = Math.max(0, entries.findIndex(({ value }) => value === temporal.activeValue));
  const activeEntry = entries[index];
  elements.temporalLabel.textContent = temporal.label;
  elements.temporalSlider.min = "0";
  elements.temporalSlider.max = String(entries.length - 1);
  elements.temporalSlider.value = String(index);
  elements.temporalSlider.setAttribute("aria-valuetext", activeEntry.ariaLabel ?? activeEntry.label);
  elements.temporalOutput.value = String(temporal.activeValue);
  elements.temporalOutput.textContent = activeEntry.label;
  elements.temporalMarkers.replaceChildren(...entries.map((entry, markerIndex) => {
    const marker = document.createElement("span");
    marker.className = `timeline-marker ${entry.kind ? `is-${entry.kind}` : ""} ${markerIndex === index ? "is-active" : ""}`;
    marker.style.left = `${entries.length === 1 ? 50 : markerIndex / (entries.length - 1) * 100}%`;
    marker.title = entry.ariaLabel ?? entry.label;
    return marker;
  }));
  elements.temporalMarkers.hidden = !temporal.items;
  elements.temporalPrevious.disabled = index === 0;
  elements.temporalPrevious.setAttribute("aria-label", temporal.previousLabel);
  elements.temporalPrevious.title = temporal.previousLabel;
  elements.temporalNext.disabled = index === entries.length - 1;
  elements.temporalNext.setAttribute("aria-label", temporal.nextLabel);
  elements.temporalNext.title = temporal.nextLabel;
  updateAnalysisPairing();
}

function updateLayerContext() {
  if (!application.layers) return;
  const layer = activeLayer();
  const context = layer.getContext({ sectorCount: application.data?.provenance?.output?.sectorCount ?? 154 });
  elements.activeLayerTitle.textContent = layer.getLabel();
  elements.layerContextMeta.textContent = context.meta;
  elements.layerContextCopy.textContent = context.text;
  elements.layerContextNote.textContent = context.note ?? "";
  elements.layerContextNote.hidden = !context.note;
  const sources = (context.sources ?? []).flatMap((source) => {
    const url = safeExternalUrl(source.url);
    return url ? [{ ...source, url }] : [];
  });
  elements.layerContextSources.hidden = sources.length === 0;
  elements.layerContextSources.replaceChildren();
  if (sources.length) {
    elements.layerContextSources.append(`${t("controls.activeSource")} `);
    sources.forEach((source, index) => {
      if (index) elements.layerContextSources.append(" · ");
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.label;
      elements.layerContextSources.append(link);
    });
  }
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
  if (application.surfaceLayout) {
    application.surfaceLayout.requestControls(application.mapControlsCollapsed);
  } else {
    application.mapControlsCollapsed = !application.mapControlsCollapsed;
    updateMapControlsDisclosure();
  }
});

async function start() {
  performance.mark("heat-map-start");
  const data = await loadApplicationData();
  application.data = data;
  elements.mapControls.classList.toggle("has-local-layers", Object.keys(data.localLayers ?? {}).length > 0);
  const extraLayers = [];
  if (import.meta.env.MODE === "local-data") {
    extraLayers.push(...(await import("./layers/local-official-layers.js")).createLocalOfficialLayers(data.localLayers));
    if (data.localLayers.landgebruik) {
      extraLayers.push((await import("./layers/landgebruik-layer.js")).createLandgebruikLayer({
        descriptor: data.localLayers.landgebruik,
      }));
    }
    if (data.localLayers["landsat-temperature"]) {
      extraLayers.push((await import("./layers/landsat-temperature-layer.js")).createLandsatTemperatureLayer({
        descriptor: data.localLayers["landsat-temperature"],
      }));
    }
  }
  application.layers = buildLayerRegistry(data, {
    initialHeatMetric: application.activeHeatMetric,
    playground: import.meta.env.MODE === "playground",
    extraLayers,
  });
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
    urbanAtlas: data.urbanAtlas,
    income: data.income,
    localLayers: data.localLayers,
  };
  const panel = createDetailPanel({
    panel: elements.detailPanel,
    content: elements.panelContent,
    closeButton: elements.panelClose,
    toggleButton: elements.panelToggle,
    peekButton: elements.panelPeek,
    peekLabel: elements.panelPeekLabel,
    peekValue: elements.panelPeekValue,
    getPanelModel: (layerId, record) => application.layers.get(layerId).getPanelModel(record, sharedPanelData),
    getAboutModel: () => ({ ...sharedPanelData, provenance: data.provenance }),
    onLayerOptionChange: (name, value) => activateLayerOption(name, value),
    onOpen: () => application.surfaceLayout?.requestPanel("expanded"),
    onPresentationRequest: (presentation) => application.surfaceLayout?.requestPanel(presentation),
    onClose: (closedView, returnFocusElement) => {
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
      application.surfaceLayout?.requestPanel("closed");
      if (returnFocusElement instanceof HTMLElement && elements.mapControls.contains(returnFocusElement)) {
        application.surfaceLayout?.requestControls(true);
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

  function activateLayerOption(name, value) {
    if (application.activeLayer === "heat" && name === "metric") return activateHeatMetric(value);
    const layer = activeLayer();
    if (!layer || !application.mapController.setLayerOption(layer.id, name, value)) return false;
    updateSecondaryControls();
    updateLayerContext();
    updateDatasetStatus();
    renderLegend();
    panel.refresh();
    return true;
  }

  function activateTemporalValue(value) {
    const layer = activeLayer();
    const temporal = layer?.getTemporalControl?.();
    if (!temporal || value === application.mapController.getLayerOption(layer.id, temporal.optionName)) return false;
    if (!application.mapController.setLayerOption(layer.id, temporal.optionName, value)) return false;
    updateLayerControls();
    updateSecondaryControls();
    updateLayerContext();
    updateDatasetStatus();
    renderLegend();
    panel.refresh();
    application.announcement = { type: "temporalValue", layerId: layer.id, value };
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
  application.surfaceLayout = createMapSurfaceLayout({
    shell: document.querySelector(".map-shell"),
    controls: elements.mapControls,
    legend: elements.legendDisclosure,
    panel: elements.detailPanel,
    setControlsExpanded(expanded) {
      application.mapControlsCollapsed = !expanded;
      updateMapControlsDisclosure({ refreshMap: false });
    },
    setLegendExpanded(expanded) {
      elements.legendDisclosure.toggleAttribute("open", expanded);
    },
    setPanelPresentation(presentation) {
      panel.setPresentation(presentation);
    },
    getPanelPresentation: () => panel.getPresentation(),
    onPaddingChange(padding) {
      application.mapController?.setViewportPadding(padding);
      application.mapController?.refreshLayout();
    },
  });
  await application.mapController.ready;
  application.mapController.setViewportPadding(application.surfaceLayout.getPadding());
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
  elements.secondarySwitch.addEventListener("click", (event) => {
    const button = event.target.closest("[data-secondary-option]");
    if (!button || button.disabled) return;
    const control = activeLayer()?.getSecondaryControl?.();
    const optionId = button.dataset.secondaryOption;
    if (control && activateLayerOption(control.optionName, optionId)) {
      elements.secondarySwitch.querySelector(`[data-secondary-option="${optionId}"]`)?.focus();
    }
  });
  elements.secondarySwitch.addEventListener("keydown", (event) => {
    const buttons = [...elements.secondarySwitch.querySelectorAll("button:not(:disabled)")];
    const button = event.target.closest("button");
    if (button) moveSegmentFocus(event, buttons, button);
  });
  elements.analysisCompare.addEventListener("click", () => enterAnalysisPickMode(elements.analysisCompare));
  elements.analysisPairChange.addEventListener("click", () => enterAnalysisPickMode(elements.analysisPairChange));
  elements.analysisPairRemove.addEventListener("click", removeAnalysisPairing);
  elements.analysisPickCancel.addEventListener("click", () => cancelAnalysisPickMode());
  elements.legendDisclosure.addEventListener("toggle", () => {
    if (!application.surfaceLayout?.isApplying()) application.surfaceLayout?.requestLegend(elements.legendDisclosure.open);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && application.analysisPickMode) {
      event.preventDefault();
      cancelAnalysisPickMode();
    }
  });
  const temporalValues = () => {
    const temporal = activeLayer()?.getTemporalControl?.();
    return temporal?.items?.map(({ value }) => value) ?? temporal?.values ?? [];
  };
  elements.temporalSlider.addEventListener("input", () => {
    const values = temporalValues();
    activateTemporalValue(values[Number(elements.temporalSlider.value)]);
  });
  elements.temporalPrevious.addEventListener("click", () => {
    const temporal = activeLayer()?.getTemporalControl?.();
    if (!temporal) return;
    const values = temporal.items?.map(({ value }) => value) ?? temporal.values;
    const current = application.mapController.getLayerOption(activeLayer().id, temporal.optionName);
    activateTemporalValue(values[Math.max(0, values.indexOf(current) - 1)]);
  });
  elements.temporalNext.addEventListener("click", () => {
    const temporal = activeLayer()?.getTemporalControl?.();
    if (!temporal) return;
    const values = temporal.items?.map(({ value }) => value) ?? temporal.values;
    const current = application.mapController.getLayerOption(activeLayer().id, temporal.optionName);
    activateTemporalValue(values[Math.min(values.length - 1, values.indexOf(current) + 1)]);
  });
  elements.layerButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const layerId = button.dataset.layer;
      if (application.analysisPickMode) {
        selectAnalysisPairing(layerId);
        return;
      }
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
      if (application.analysisPickMode) cancelAnalysisPickMode({ restoreFocus: false });
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
      button.focus({ preventScroll: true });
    });
    button.addEventListener("keydown", (event) => moveSegmentFocus(
      event,
      elements.layerButtons.filter((candidate) => candidate.getAttribute("aria-disabled") !== "true"),
      button,
    ));
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
