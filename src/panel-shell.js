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
  isPersistentView = () => false,
  onSectorHover,
}) {
  if (typeof getPanelModel !== "function" || typeof getAboutModel !== "function") {
    throw new TypeError("The detail panel requires layer-owned panel and about model providers.");
  }

  let returnFocusElement = null;
  let currentView = null;
  let activeHeatMetric = normalizeHeatMetric(heatMetric);
  let presentation = "closed";
  let openSectionIds = new Set();
  let suspendedPersistentView = null;
  let suspendedPresentation = "expanded";

  const persistentCurrentView = () => Boolean(currentView && isPersistentView(currentView));

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
    const closeLabel = persistentCurrentView() ? minimiseLabel : t("panel.close");
    closeButton.setAttribute("aria-label", closeLabel);
    closeButton.title = closeLabel;
    closeButton.querySelector("path")?.setAttribute("d", persistentCurrentView() ? "M6 12h12" : "m6 6 12 12M18 6 6 18");
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

  const close = ({ restoreFocus = true, force = false } = {}) => {
    if (!force && currentView?.type === "about" && suspendedPersistentView) {
      currentView = suspendedPersistentView;
      suspendedPersistentView = null;
      renderCurrentView({ preserveState: false, focusPanel: true });
      applyPresentation(suspendedPresentation);
      onPresentationRequest?.(suspendedPresentation, closeButton);
      return;
    }
    if (!force && persistentCurrentView()) {
      applyPresentation("peek");
      onPresentationRequest?.("peek", closeButton);
      return;
    }
    const closedView = currentView;
    currentView = null;
    suspendedPersistentView = null;
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

  const open = (record, triggerElement = null, layerId = "heat") => {
    suspendedPersistentView = null;
    show({ type: "record", record, layerId }, triggerElement);
  };
  const openAbout = (triggerElement = null) => {
    if (persistentCurrentView()) {
      suspendedPersistentView = currentView;
      suspendedPresentation = presentation === "closed" ? "expanded" : presentation;
    }
    show({ type: "about" }, triggerElement);
  };
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
        const resetChartScroll = () => {
          dialog.scrollTop = 0;
          const body = dialog.querySelector(".comparison-chart-dialog-content");
          if (body) body.scrollTop = 0;
        };
        resetChartScroll();
        dialog.querySelector("[data-close-comparison-chart]")?.focus();
        requestAnimationFrame(() => requestAnimationFrame(resetChartScroll));
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
    const scatterPoint = event.target.closest("[data-scatter-sector]");
    if (scatterPoint && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const points = [...scatterPoint.closest("[data-sector-comparison-chart]").querySelectorAll("[data-scatter-sector]")];
      const currentIndex = points.indexOf(scatterPoint);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? points.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + points.length) % points.length;
      points.forEach((point, index) => point.setAttribute("tabindex", index === nextIndex ? "0" : "-1"));
      points[nextIndex]?.focus();
      return;
    }
    const populationBar = event.target.closest("[data-population-score-bar]");
    if (populationBar && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const bars = [...populationBar.closest("[data-heat-population-bar-chart]").querySelectorAll("[data-population-score-bar]")];
      const currentIndex = bars.indexOf(populationBar);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? bars.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + bars.length) % bars.length;
      bars.forEach((bar, index) => bar.setAttribute("tabindex", index === nextIndex ? "0" : "-1"));
      bars[nextIndex]?.focus();
      return;
    }
    const densityBox = event.target.closest("[data-green-density-box]");
    if (densityBox && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const boxes = [...densityBox.closest("[data-green-density-chart]").querySelectorAll("[data-green-density-box]")];
      const currentIndex = boxes.indexOf(densityBox);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? boxes.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + boxes.length) % boxes.length;
      boxes.forEach((box, index) => box.setAttribute("tabindex", index === nextIndex ? "0" : "-1"));
      boxes[nextIndex]?.focus();
      return;
    }
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
  const updateScatterPoint = (event) => {
    const point = event.target.closest?.("[data-scatter-sector]");
    if (!point) return;
    const chart = point.closest("[data-sector-comparison-chart]");
    chart?.querySelectorAll("[data-scatter-sector].is-highlighted").forEach((item) => item.classList.remove("is-highlighted"));
    point.classList.add("is-highlighted");
    const output = chart?.querySelector("[data-scatter-output]");
    if (output) output.textContent = point.dataset.scatterLabel;
    onSectorHover?.(point.dataset.scatterSector);
  };
  content.addEventListener("focusin", updateScatterPoint);
  content.addEventListener("pointerover", updateScatterPoint);
  const updatePopulationBar = (event) => {
    const bar = event.target.closest?.("[data-population-score-bar]");
    if (!bar) return;
    const chart = bar.closest("[data-heat-population-bar-chart]");
    const output = chart?.querySelector("[data-population-bar-output]");
    if (output) output.textContent = bar.dataset.barLabel;
  };
  content.addEventListener("focusin", updatePopulationBar);
  content.addEventListener("pointerover", updatePopulationBar);
  const updateGreenDensityBox = (event) => {
    const box = event.target.closest?.("[data-green-density-box]");
    if (!box) return;
    const output = box.closest("[data-green-density-chart]")?.querySelector("[data-green-density-output]");
    if (output) output.textContent = box.dataset.greenDensityLabel;
  };
  content.addEventListener("focusin", updateGreenDensityBox);
  content.addEventListener("pointerover", updateGreenDensityBox);
  content.addEventListener("pointerout", (event) => {
    if (!event.target.closest?.("[data-scatter-sector]") || event.relatedTarget?.closest?.("[data-scatter-sector]")) return;
    onSectorHover?.("");
  });
  content.addEventListener("focusout", (event) => {
    if (!event.target.closest?.("[data-scatter-sector]") || event.relatedTarget?.closest?.("[data-scatter-sector]")) return;
    onSectorHover?.("");
  });
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
