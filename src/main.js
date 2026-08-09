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
import { renderLegendModel } from "./legend.js";
import { validateProductContract } from "./product-contract.js";
import { createDetailPanel } from "./panel-shell.js";
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
  mapModeAction: document.querySelector("#map-mode-action"),
  analysisCompare: document.querySelector("#analysis-compare"),
  analysisPairResult: document.querySelector("#analysis-pair-result"),
  analysisPairLabel: document.querySelector("#analysis-pair-label"),
  analysisPairRetry: document.querySelector("#analysis-pair-retry"),
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
  comparisons: new Map(),
  activeComparisonId: null,
  activateAnalysisPairing: null,
  deactivateAnalysisPairing: null,
  surfaceLayout: null,
  projectIntro: null,
};

const activeLayer = () => application.layers?.get(application.activeLayer);
const activeComparison = () => application.comparisons.get(application.activeComparisonId) ?? null;
const activeAnalysisTargets = (layer) => {
  const declared = layer?.getAnalysisTargets?.() ?? [];
  if (layer?.id !== "landsat-temperature") return declared;
  return declared.filter((targetId) => [...application.comparisons.values()]
    .some((comparison) => comparison.primaryLayerId === layer.id && comparison.secondaryLayerId === targetId));
};
const supportsMunicipalitySummary = () => Boolean(activeLayer()?.supportsMunicipalitySummary);
const supportsRegionSummary = () => Boolean(activeLayer()?.supportsRegionSummary);

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
    const linkedSecondary = application.analysisPairings[application.activeLayer] === layer?.id;
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
    if (linkedSecondary && !pick) button.setAttribute("aria-label", t("analysisPairing.comparisonLayer", { layer: label }));
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-pressed", String(application.activeLayer === layer?.id));
    button.classList.toggle("is-active", application.activeLayer === layer?.id);
    button.classList.toggle("is-comparison-target", isCompatible);
    button.classList.toggle("is-comparison-primary", isPrimary);
    button.classList.toggle("is-linked-comparison", linkedSecondary && !pick);
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
  const targets = activeAnalysisTargets(layer)
    .map((id) => application.layers.get(id))
    .filter((candidate) => candidate?.isAvailable());
  const picking = application.analysisPickMode?.primaryLayerId === layer?.id;
  const mapModeAction = layer?.getMapModeAction?.() ?? null;
  const selectedId = targets.some(({ id }) => id === application.analysisPairings[layer.id])
    ? application.analysisPairings[layer.id]
    : "";
  const selectedComparison = selectedId && activeComparison()?.secondaryLayerId === selectedId
    ? activeComparison()
    : null;
  const comparisonFailed = Boolean(selectedComparison?.hasLoadError?.());
  elements.analysisPairing.hidden = targets.length === 0 && !mapModeAction;
  elements.mapModeAction.hidden = !mapModeAction;
  if (mapModeAction) {
    elements.mapModeAction.textContent = mapModeAction.label;
    elements.mapModeAction.setAttribute("aria-pressed", String(mapModeAction.active));
    elements.mapModeAction.classList.toggle("is-active", mapModeAction.active);
  }
  if (!targets.length) {
    elements.analysisCompare.hidden = true;
    elements.analysisPairResult.hidden = true;
    elements.analysisPickInstruction.hidden = true;
    elements.analysisPairNote.hidden = true;
    return;
  }
  elements.analysisCompare.hidden = Boolean(selectedId) || picking;
  elements.analysisPairResult.hidden = !selectedId || picking;
  elements.analysisPairRetry.hidden = !comparisonFailed || picking;
  elements.analysisPickInstruction.hidden = !picking;
  elements.analysisPairNote.hidden = !selectedId || picking;
  if (selectedId) {
    elements.analysisPairLabel.textContent = t("analysisPairing.selected", {
      primary: layer.getLabel(),
      secondary: application.layers.get(selectedId).getLabel(),
    });
    elements.analysisPairNote.textContent = comparisonFailed
      ? t("analysisPairing.loadFailed")
      : selectedComparison?.isActive()
        ? t("analysisPairing.activeNote")
        : t("analysisPairing.previewNote");
  }
  if (picking) {
    elements.analysisPairingHelp.textContent = t("analysisPairing.instruction", { layer: layer.getLabel() });
  }
}

function enterAnalysisPickMode(trigger = elements.analysisCompare) {
  const layer = activeLayer();
  const targetIds = activeAnalysisTargets(layer)
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

async function selectAnalysisPairing(targetId) {
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
  try {
    const activated = await application.activateAnalysisPairing?.(pick.primaryLayerId, targetId);
    if (activated === false) {
      updateAnalysisPairing();
      elements.analysisPairRetry.focus();
      return false;
    }
  } catch (error) {
    console.error(error);
    elements.layerHelp.textContent = t("analysisPairing.loadFailed");
    updateAnalysisPairing();
    return false;
  }
  if (activeComparison()?.isActive()) {
    application.announcement = { type: "analysisPairing", key: "comparison.activated", parameters: {} };
    updateAnnouncement();
  }
  elements.analysisPairChange.focus();
  return true;
}

function removeAnalysisPairing() {
  const layer = activeLayer();
  if (!layer || !application.analysisPairings[layer.id]) return;
  delete application.analysisPairings[layer.id];
  application.deactivateAnalysisPairing?.(layer.id);
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
  const comparison = activeComparison()?.isActive() ? activeComparison() : null;
  const context = comparison?.getContext()
    ?? layer.getContext({ sectorCount: application.data?.provenance?.output?.sectorCount ?? 154 });
  elements.activeLayerTitle.textContent = comparison?.getLabel() ?? layer.getLabel();
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

function renderLegend() {
  if (!application.layers) return;
  const model = activeComparison()?.isActive()
    ? activeComparison().getLegendModel()
    : activeLayer().getLegendModel();
  renderLegendModel({ title: elements.legendTitle, note: elements.legendNote, content: elements.legend }, model);
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
  elements.mapControls.classList.toggle("has-official-layers", Object.keys(data.officialLayers ?? {}).length > 0);
  const extraLayers = [];
  if (Object.keys(data.officialLayers ?? {}).length) {
    extraLayers.push(...(await import("./layers/local-official-layers.js")).createOfficialRasterLayers(data.officialLayers));
    if (data.officialLayers.landgebruik) {
      extraLayers.push((await import("./layers/landgebruik-layer.js")).createLandgebruikLayer({
        descriptor: data.officialLayers.landgebruik,
      }));
    }
    if (data.officialLayers["landsat-temperature"]) {
      extraLayers.push((await import("./layers/landsat-temperature-layer.js")).createLandsatTemperatureLayer({
        descriptor: data.officialLayers["landsat-temperature"],
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
  let suppressPanelFallback = false;
  const municipalityRecord = (municipality) => ({
    scope: "municipality",
    municipality,
    sectorName: municipality,
    sectorId: "",
    sectorCount: data.provenance.output.municipalityCounts[municipality] ?? 0,
  });
  const regionRecord = () => ({
    scope: "region",
    municipality: "",
    sectorName: t("controls.allMunicipalities"),
    sectorId: "",
    sectorCount: data.provenance.output.sectorCount ?? 154,
  });
  const sharedPanelData = {
    methodology: data.methodology,
    urbanAtlas: data.urbanAtlas,
    income: data.income,
    officialLayers: data.officialLayers,
    comparisons: data.comparisons,
  };
  const panel = createDetailPanel({
    panel: elements.detailPanel,
    content: elements.panelContent,
    closeButton: elements.panelClose,
    toggleButton: elements.panelToggle,
    peekButton: elements.panelPeek,
    peekLabel: elements.panelPeekLabel,
    peekValue: elements.panelPeekValue,
    getPanelModel: (layerId, record) => (
      layerId === "landsat-temperature" && activeComparison()?.isActive()
        ? activeComparison().getPanelModel(record, sharedPanelData)
        : application.layers.get(layerId).getPanelModel(record, sharedPanelData)
    ),
    getAboutModel: () => ({ ...sharedPanelData, provenance: data.provenance }),
    onLayerOptionChange: (name, value) => activateLayerOption(name, value),
    onOpen: () => application.surfaceLayout?.requestPanel("expanded"),
    onPresentationRequest: (presentation) => application.surfaceLayout?.requestPanel(presentation),
    onClose: (closedView, returnFocusElement) => {
      selectedSectorId = "";
      application.mapController?.setSelected("");
      application.announcement = { type: "closed" };
      updateAnnouncement();
      if (!suppressPanelFallback && closedView?.type === "record" && !closedView.record.scope && activeComparison()?.isActive()) {
        queueMicrotask(() => panel.open(
          elements.municipality.value ? municipalityRecord(elements.municipality.value) : regionRecord(),
          elements.municipality,
          application.activeLayer,
        ));
      } else if (!suppressPanelFallback && closedView?.type === "record" && closedView.record.scope !== "municipality"
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
    activeComparison()?.refreshObservation();
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
  const landsatLayer = application.layers.get("landsat-temperature");
  if (landsatLayer && data.comparisons?.["landsat-urban-atlas"]) {
    const { createLandsatUrbanAtlasComparison } = await import("./comparisons/landsat-urban-atlas.js");
    const comparison = createLandsatUrbanAtlasComparison({
      descriptor: data.comparisons["landsat-urban-atlas"], landsatLayer,
      urbanAtlasLayer: application.layers.get("urban-atlas"), urbanAtlas: data.urbanAtlas,
    });
    application.comparisons.set(comparison.id, comparison);
  }
  if (landsatLayer && data.comparisons?.["landsat-jaarbak"] && application.layers.has("jaarbak")) {
    const { createLandsatJaarbakComparison } = await import("./comparisons/landsat-jaarbak.js");
    const comparison = createLandsatJaarbakComparison({
      descriptor: data.comparisons["landsat-jaarbak"], landsatLayer,
      jaarbakLayer: application.layers.get("jaarbak"),
    });
    application.comparisons.set(comparison.id, comparison);
  }
  validateProductContract(application.layers, application.comparisons, {
    playground: import.meta.env.MODE === "playground",
  });
  application.comparisons.forEach((comparison) => comparison.subscribe(() => {
    if (!comparison.isActive()) return;
    renderLegend();
    panel.refresh();
    updateAnalysisPairing();
    updateLayerControls();
  }));
  application.activateAnalysisPairing = async (primaryId, targetId) => {
    const next = [...application.comparisons.values()].find((comparison) => (
      comparison.primaryLayerId === primaryId && comparison.secondaryLayerId === targetId
    ));
    if (!next) return false;
    const current = activeComparison();
    if (current && current !== next) current.deactivate();
    application.activeComparisonId = next.id;
    const activated = await next.activate(application.mapController.map);
    if (activated === false) {
      renderLegend();
      updateLayerContext();
      updateLayerControls();
      updateAnalysisPairing();
      return false;
    }
    await next.setMunicipality(elements.municipality.value);
    renderLegend();
    updateLayerContext();
    updateLayerControls();
    updateAnalysisPairing();
    if (selectedSectorId) panel.refresh();
    else panel.open(
      elements.municipality.value ? municipalityRecord(elements.municipality.value) : regionRecord(),
      elements.analysisPairChange, "landsat-temperature",
    );
    return true;
  };
  application.deactivateAnalysisPairing = (primaryId) => {
    const comparison = activeComparison();
    if (comparison?.primaryLayerId !== primaryId || !comparison.isActive()) return;
    comparison.deactivate();
    application.activeComparisonId = null;
    renderLegend();
    updateLayerContext();
    updateLayerControls();
    if (selectedSectorId) panel.refresh();
    else if (elements.municipality.value) {
      panel.open(municipalityRecord(elements.municipality.value), elements.municipality, "landsat-temperature");
    } else panel.close({ restoreFocus: false });
  };
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
    if (selectedSectorId && (!municipality || data.scores[selectedSectorId]?.municipality !== municipality)) {
      panel.close({ restoreFocus: false });
    }
    application.mapController.setMunicipality(municipality);
    activeComparison()?.setMunicipality(municipality);
    if (!selectedSectorId && activeComparison()?.isActive()) {
      panel.open(municipality ? municipalityRecord(municipality) : regionRecord(), elements.municipality, application.activeLayer);
    } else if (!selectedSectorId && municipality && supportsMunicipalitySummary()) {
      panel.open(municipalityRecord(municipality), elements.municipality, application.activeLayer);
    } else if (!selectedSectorId && !municipality && supportsRegionSummary()) {
      panel.open(regionRecord(), elements.municipality, application.activeLayer);
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

  elements.resetView.addEventListener("click", () => {
    application.mapController.resetView();
    if (!selectedSectorId && !elements.municipality.value && supportsRegionSummary()) {
      panel.open(regionRecord(), elements.resetView, application.activeLayer);
    }
  });
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
  elements.mapModeAction.addEventListener("click", async () => {
    const layer = activeLayer();
    if (!layer?.toggleMapMode) return;
    elements.mapModeAction.setAttribute("aria-busy", "true");
    try {
      await layer.toggleMapMode(application.mapController.map);
      updateAnalysisPairing();
      updateLayerContext();
      renderLegend();
      application.mapController.setLanguage();
      elements.mapModeAction.focus({ preventScroll: true });
    } catch (error) {
      console.error(error);
      elements.layerHelp.textContent = t("density.loadError");
    } finally {
      elements.mapModeAction.removeAttribute("aria-busy");
    }
  });
  elements.analysisPairChange.addEventListener("click", () => enterAnalysisPickMode(elements.analysisPairChange));
  elements.analysisPairRetry.addEventListener("click", async () => {
    const comparison = activeComparison();
    if (!comparison?.retry) return;
    elements.analysisPairRetry.setAttribute("aria-busy", "true");
    try {
      const ready = await comparison.retry({ municipality: elements.municipality.value });
      updateAnalysisPairing();
      if (!ready) return;
      renderLegend();
      updateLayerContext();
      updateLayerControls();
      if (selectedSectorId) panel.refresh();
      else panel.open(
        elements.municipality.value ? municipalityRecord(elements.municipality.value) : regionRecord(),
        elements.analysisPairRetry,
        "landsat-temperature",
      );
    } finally {
      elements.analysisPairRetry.removeAttribute("aria-busy");
    }
  });
  elements.analysisPairRemove.addEventListener("click", removeAnalysisPairing);
  elements.analysisPickCancel.addEventListener("click", () => cancelAnalysisPickMode());
  elements.legendDisclosure.addEventListener("toggle", () => {
    if (!application.surfaceLayout?.isApplying()) application.surfaceLayout?.requestLegend(elements.legendDisclosure.open);
  });
  elements.legend.addEventListener("click", (event) => {
    const densityButton = event.target.closest("[data-density-class]");
    if (densityButton && activeLayer()?.toggleDensityClass) {
      const result = activeLayer().toggleDensityClass(densityButton.dataset.densityClass);
      if (result.minimum) {
        const feedback = elements.legend.querySelector("[data-density-feedback]");
        if (feedback) feedback.textContent = t("density.minimumClass");
        elements.announcement.textContent = t("density.minimumClass");
      } else if (result.changed) renderLegend();
      return;
    }
    const disclosure = event.target.closest("[data-comparison-family-toggle]");
    if (disclosure && activeComparison()?.isActive()) {
      activeComparison().toggleFamilyDisclosure?.(disclosure.dataset.comparisonFamilyToggle);
      return;
    }
    const button = event.target.closest("[data-comparison-series]");
    if (!button || !activeComparison()?.isActive() || !activeComparison().toggleSeries) return;
    const result = activeComparison().toggleSeries(button.dataset.comparisonSeries);
    if (result.limit) {
      const feedback = elements.legend.querySelector("[data-comparison-feedback]");
      if (feedback) feedback.textContent = t("comparison.seriesLimit");
      application.announcement = { type: "analysisPairing", key: "comparison.seriesLimit", parameters: {} };
      updateAnnouncement();
    }
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
      const changedLayer = application.activeLayer !== layerId;
      if (activeComparison()?.isActive() && layerId !== "landsat-temperature") {
        activeComparison().deactivate();
        application.activeComparisonId = null;
      }
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
      if (changedLayer && panel.isOpen()) {
        suppressPanelFallback = true;
        panel.close({ restoreFocus: false });
        suppressPanelFallback = false;
        elements.sectorSearch.value = "";
      }
      if (layerId === "landsat-temperature" && application.analysisPairings["landsat-temperature"]) {
        const targetId = application.analysisPairings["landsat-temperature"];
        const comparison = [...application.comparisons.values()].find((item) => item.secondaryLayerId === targetId);
        if (comparison && !comparison.isActive()) {
          application.activeComparisonId = comparison.id;
          await comparison.activate(application.mapController.map);
          await comparison.setMunicipality(elements.municipality.value);
        }
      }
      if (application.analysisPickMode) cancelAnalysisPickMode({ restoreFocus: false });
      elements.layerHelp.textContent = "";
      updateLayerControls();
      updateSecondaryControls();
      updateLayerContext();
      updateDatasetStatus();
      renderLegend();
      if (changedLayer) {
        // A new top-level layer starts without results from the previous
        // dataset. Overview or an area selection opens its own summary.
      } else if (selectedSectorId) {
        panel.setActiveLayer(layerId);
      } else if (activeComparison()?.isActive()) {
        panel.open(elements.municipality.value ? municipalityRecord(elements.municipality.value) : regionRecord(), button, layerId);
      } else if (elements.municipality.value && supportsMunicipalitySummary()) {
        panel.open(municipalityRecord(elements.municipality.value), button, layerId);
      } else if (!elements.municipality.value && supportsRegionSummary()) {
        panel.open(regionRecord(), button, layerId);
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
