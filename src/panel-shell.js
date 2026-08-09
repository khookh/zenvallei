import { t } from "./i18n.js";
import { DEFAULT_HEAT_METRIC, normalizeHeatMetric } from "./heat-metric.js";
import { renderAboutPanelModel, renderSectorPanelModel } from "./panel.js";

/** Responsive shell that owns focus, disclosure state and panel rerendering. */
export function createDetailPanel({
  panel,
  content,
  closeButton,
  toggleButton = document.createElement("button"),
  peekButton = document.createElement("button"),
  peekLabel = document.createElement("span"),
  peekValue = document.createElement("strong"),
  getPanelModel,
  getAboutModel,
  heatMetric = DEFAULT_HEAT_METRIC,
  onLayerOptionChange,
  onOpen,
  onPresentationRequest,
  onClose,
}) {
  if (typeof getPanelModel !== "function" || typeof getAboutModel !== "function") {
    throw new TypeError("The detail panel requires layer-owned panel and about model providers.");
  }

  let returnFocusElement = null;
  let currentView = null;
  let activeHeatMetric = normalizeHeatMetric(heatMetric);
  let presentation = "closed";
  let openSectionIds = new Set();

  const updatePeekSummary = () => {
    const title = content.querySelector("h2")?.textContent?.trim() ?? "";
    const value = content.querySelector(".income-hero-metric strong, .score-orb strong, .land-cover-dominant, .panel-subtitle")
      ?.textContent?.trim() ?? "";
    peekLabel.textContent = title;
    peekValue.textContent = value;
  };

  const applyPresentation = (nextPresentation) => {
    if (!currentView && nextPresentation !== "closed") return;
    presentation = nextPresentation;
    const visible = nextPresentation !== "closed";
    const peek = nextPresentation === "peek";
    panel.classList.toggle("is-open", visible);
    panel.classList.toggle("is-peek", peek);
    panel.setAttribute("aria-hidden", String(!visible));
    content.hidden = peek;
    peekButton.hidden = !peek;
    toggleButton.hidden = !visible || peek;
    toggleButton.setAttribute("aria-expanded", String(!peek));
    const minimiseLabel = t("panel.minimise");
    const expandLabel = t("panel.expand");
    toggleButton.setAttribute("aria-label", minimiseLabel);
    toggleButton.title = minimiseLabel;
    peekButton.setAttribute("aria-label", expandLabel);
    peekButton.title = expandLabel;
    if (visible) updatePeekSummary();
  };

  const captureRenderState = () => {
    content.querySelectorAll("details[data-section]").forEach((element) => {
      if (element.open) openSectionIds.add(element.dataset.section);
      else openSectionIds.delete(element.dataset.section);
    });
    return {
      openSections: [...openSectionIds],
      hadExpandedSection: openSectionIds.size > 0,
      focusKey: content.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null,
    };
  };

  const renderCurrentView = ({ preserveState = true, focusPanel = false } = {}) => {
    if (!currentView) return;
    const renderState = preserveState ? captureRenderState() : { openSections: [], hadExpandedSection: false, focusKey: null };
    if (currentView.type === "about") {
      const model = getAboutModel();
      content.innerHTML = renderAboutPanelModel(model);
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
    openSectionIds = new Set(renderState.openSections);
    if (renderState.hadExpandedSection && !restoredSection) content.querySelector("details[data-section]")?.setAttribute("open", "");
    if (renderState.focusKey) {
      [...content.querySelectorAll("[data-focus-key]")]
        .find((element) => element.dataset.focusKey === renderState.focusKey)
        ?.focus({ preventScroll: true });
    } else if (focusPanel) {
      requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    }
    updatePeekSummary();
  };

  const close = ({ restoreFocus = true } = {}) => {
    const closedView = currentView;
    currentView = null;
    applyPresentation("closed");
    onClose?.(closedView, returnFocusElement);
    if (restoreFocus && returnFocusElement instanceof HTMLElement) {
      requestAnimationFrame(() => returnFocusElement.focus({ preventScroll: true }));
    }
  };

  const show = (view, triggerElement) => {
    returnFocusElement = triggerElement instanceof HTMLElement ? triggerElement : document.activeElement;
    currentView = view;
    openSectionIds = new Set();
    renderCurrentView({ preserveState: false, focusPanel: true });
    applyPresentation("expanded");
    panel.scrollTop = 0;
    onOpen?.();
  };

  const open = (record, triggerElement = null, layerId = "heat") => show({ type: "record", record, layerId }, triggerElement);
  const openAbout = (triggerElement = null) => show({ type: "about" }, triggerElement);
  const setPanelLanguage = () => {
    if (currentView && presentation !== "closed") {
      renderCurrentView({ preserveState: true });
      applyPresentation(presentation);
    }
  };
  const setActiveLayer = (layerId) => {
    if (currentView?.type !== "record") return;
    const changedLayer = currentView.layerId !== layerId;
    currentView.layerId = layerId;
    if (presentation !== "closed") {
      renderCurrentView({ preserveState: !changedLayer });
      if (changedLayer) panel.scrollTop = 0;
    }
  };
  const setHeatMetric = (metric) => {
    activeHeatMetric = normalizeHeatMetric(metric);
    if (currentView?.type === "record" && currentView.layerId === "heat" && presentation !== "closed") {
      renderCurrentView({ preserveState: true });
    }
  };

  closeButton.addEventListener("click", () => close());
  toggleButton.addEventListener("click", () => onPresentationRequest?.("peek", toggleButton));
  peekButton.addEventListener("click", () => onPresentationRequest?.("expanded", peekButton));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !content.querySelector("dialog[open]")) close();
  });
  content.addEventListener("click", (event) => {
    const expand = event.target.closest("[data-expand-comparison-chart]");
    if (expand) {
      const dialog = expand.closest("section")?.querySelector("[data-comparison-chart-dialog]");
      if (dialog) {
        dialog.dataset.returnFocusKey = "comparison-chart-expand";
        expand.dataset.focusKey = "comparison-chart-expand";
        dialog.showModal();
        dialog.querySelector("[data-close-comparison-chart]")?.focus();
      }
      return;
    }
    const closeChart = event.target.closest("[data-close-comparison-chart]");
    if (closeChart) {
      const dialog = closeChart.closest("dialog");
      dialog?.close();
      content.querySelector('[data-focus-key="comparison-chart-expand"]')?.focus();
      return;
    }
    const button = event.target.closest("[data-panel-heat-metric]");
    if (!button) return;
    onLayerOptionChange?.("metric", button.dataset.panelHeatMetric, button);
  });
  content.addEventListener("toggle", (event) => {
    const section = event.target.closest?.("details[data-section]");
    if (!section) return;
    if (section.open) openSectionIds.add(section.dataset.section);
    else openSectionIds.delete(section.dataset.section);
  }, true);
  content.addEventListener("keydown", (event) => {
    const histogramBin = event.target.closest("[data-histogram-bin]");
    if (histogramBin && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const bins = [...content.querySelectorAll("[data-histogram-bin]")];
      const direction = event.key === "ArrowRight" ? 1 : -1;
      bins[(bins.indexOf(histogramBin) + direction + bins.length) % bins.length]?.focus();
      return;
    }
    const button = event.target.closest("[data-panel-heat-metric]");
    if (!button || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...content.querySelectorAll("[data-panel-heat-metric]")];
    const currentIndex = buttons.indexOf(button);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
  });
  const updateHistogramOutput = (event) => {
    const bin = event.target.closest?.("[data-histogram-label]");
    if (!bin) return;
    const output = bin.closest("[data-comparison-chart]")?.querySelector("[data-histogram-output]");
    if (output) output.textContent = bin.dataset.histogramLabel;
    const crosshair = bin.closest("[data-comparison-chart]")?.querySelector("[data-comparison-crosshair]");
    if (crosshair) {
      crosshair.hidden = false;
      crosshair.setAttribute("x1", bin.dataset.histogramX);
      crosshair.setAttribute("x2", bin.dataset.histogramX);
    }

  };
  content.addEventListener("focusin", updateHistogramOutput);
  content.addEventListener("pointerover", updateHistogramOutput);
  return {
    open,
    openAbout,
    close,
    setLanguage: setPanelLanguage,
    setActiveLayer,
    setHeatMetric,
    refresh: () => renderCurrentView({ preserveState: true }),
    setPresentation: applyPresentation,
    getPresentation: () => presentation,
    isOpen: () => presentation !== "closed",
    isMunicipalitySummary: () => currentView?.type === "record" && currentView.record.scope === "municipality",
  };
}
