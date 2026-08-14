import { t } from "./i18n.js";
import { DEFAULT_HEAT_METRIC, normalizeHeatMetric } from "./heat-metric.js";
import { renderAboutPanelModel, renderSectorPanelModel } from "./panel.js";
import { mountPixelScatterCharts } from "./scatter-chart.js";

/** Responsive shell that owns focus, disclosure state and panel rerendering. */
export function createDetailPanel({
  panel,
  content,
  closeButton,
  getPanelModel,
  getAboutModel,
  heatMetric = DEFAULT_HEAT_METRIC,
  onLayerOptionChange,
  onOpen,
  onPresentationRequest,
  onClose,
  onOpenSources,
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

  const applyPresentation = (nextPresentation) => {
    if (!currentView && nextPresentation !== "closed") return;
    presentation = nextPresentation === "closed" ? "closed" : "expanded";
    const visible = nextPresentation !== "closed";
    panel.classList.toggle("is-open", visible);
    panel.setAttribute("aria-hidden", String(!visible));
    content.hidden = false;
    closeButton.setAttribute("aria-label", t("panel.close"));
    closeButton.title = t("panel.close");
    closeButton.querySelector("path")?.setAttribute("d", "m6 6 12 12M18 6 6 18");
  };

  const captureRenderState = () => {
    const expandedChart = content.querySelector("[data-comparison-chart-dialog][open]");
    content.querySelectorAll("details[data-section]").forEach((element) => {
      if (element.open) openSectionIds.add(element.dataset.section);
      else openSectionIds.delete(element.dataset.section);
    });
    return {
      openSections: [...openSectionIds],
      hadExpandedSection: openSectionIds.size > 0,
      focusKey: content.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null,
      expandedChartOpen: Boolean(expandedChart),
      expandedChartId: expandedChart?.dataset.chartDialogId ?? null,
      expandedChartScrollTop: expandedChart?.querySelector(".comparison-chart-dialog-content")?.scrollTop ?? 0,
    };
  };

  const renderCurrentView = ({ preserveState = true, focusPanel = false } = {}) => {
    if (!currentView) return;
    const renderState = preserveState ? captureRenderState() : {
      openSections: [],
      hadExpandedSection: false,
      focusKey: null,
      expandedChartOpen: false,
      expandedChartId: null,
      expandedChartScrollTop: 0,
    };
    if (currentView.type === "about") {
      const model = getAboutModel();
      content.innerHTML = renderAboutPanelModel(model);
    } else {
      const model = getPanelModel(currentView.layerId, currentView.record, {
        heatMetric: activeHeatMetric,
      });
      content.innerHTML = renderSectorPanelModel(model);
      mountPixelScatterCharts(content, model);
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
    // Comparison data can finish loading while its expanded chart is open. Reopen
    // the newly rendered dialog so an asynchronous panel refresh never dismisses it.
    if (renderState.expandedChartOpen) {
      // Some comparisons expose two independent charts. Restore the chart that
      // was actually open rather than falling back to the first dialog.
      const expandedChart = renderState.expandedChartId
        ? content.querySelector(`[data-chart-dialog-id="${CSS.escape(renderState.expandedChartId)}"]`)
        : content.querySelector("[data-comparison-chart-dialog]");
      if (expandedChart && !expandedChart.open) {
        expandedChart.showModal();
        const body = expandedChart.querySelector(".comparison-chart-dialog-content");
        if (body) body.scrollTop = renderState.expandedChartScrollTop;
        expandedChart.querySelector("[data-close-comparison-chart]")?.focus({ preventScroll: true });
      }
    }
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
    const sameRecordView = currentView?.type === "record"
      && view.type === "record"
      && currentView.layerId === view.layerId
      && currentView.record?.sectorId === view.record?.sectorId
      && currentView.record?.scope === view.record?.scope
      && currentView.record?.municipality === view.record?.municipality;
    returnFocusElement = triggerElement instanceof HTMLElement ? triggerElement : document.activeElement;
    currentView = view;
    if (!sameRecordView) openSectionIds = new Set();
    renderCurrentView({ preserveState: sameRecordView, focusPanel: !sameRecordView });
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
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !content.querySelector("dialog[open]")) close();
  });
  content.addEventListener("click", (event) => {
    const sourceButton = event.target.closest("[data-open-map-sources]");
    if (sourceButton) {
      onOpenSources?.(sourceButton);
      return;
    }
    const expand = event.target.closest("[data-expand-comparison-chart]");
    if (expand) {
      const target = expand.dataset.dialogTarget;
      const dialog = target
        ? content.querySelector(`[data-chart-dialog-id="${CSS.escape(target)}"]`)
        : expand.closest("section")?.querySelector("[data-comparison-chart-dialog]");
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
    const populationGroup = event.target.closest("[data-green-population-group]");
    if (populationGroup && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const groups = [...populationGroup.closest("[data-green-population-chart]")
        .querySelectorAll("[data-green-population-group]")];
      const currentIndex = groups.indexOf(populationGroup);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? groups.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length;
      groups.forEach((group, index) => group.setAttribute("tabindex", index === nextIndex ? "0" : "-1"));
      groups[nextIndex]?.focus();
      return;
    }
    const histogramBin = event.target.closest("[data-histogram-bin]");
    if (histogramBin && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const chart = histogramBin.closest("[data-comparison-chart]") ?? content;
      const bins = [...chart.querySelectorAll("[data-histogram-bin]")];
      const currentIndex = bins.indexOf(histogramBin);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? bins.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + bins.length) % bins.length;
      bins.forEach((bin, index) => bin.setAttribute("tabindex", index === nextIndex ? "0" : "-1"));
      bins[nextIndex]?.focus();
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
  const updateGreenPopulationGroup = (event) => {
    const group = event.target.closest?.("[data-green-population-group]");
    if (!group) return;
    const output = group.closest("[data-green-population-chart]")?.querySelector("[data-green-population-output]");
    if (output) output.textContent = group.dataset.boxLabel;
    const guide = group.closest("[data-green-population-chart]")?.querySelector("[data-population-temperature-guide]");
    if (guide && group.dataset.guideX) {
      guide.hidden = false;
      guide.setAttribute("x1", group.dataset.guideX);
      guide.setAttribute("x2", group.dataset.guideX);
    }
  };
  content.addEventListener("focusin", updateGreenPopulationGroup);
  content.addEventListener("pointerover", updateGreenPopulationGroup);
  content.addEventListener("pointermove", (event) => {
    const chart = event.target.closest?.("[data-green-population-chart]");
    const svg = chart?.querySelector("[data-cumulative-population-plot]");
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const pointerX = (event.clientX - bounds.left) / Math.max(1, bounds.width) * viewBox.width;
    const left = Number(svg.dataset.plotLeft);
    const right = Number(svg.dataset.plotRight);
    if (pointerX < left || pointerX > right) return;
    const groups = [...svg.querySelectorAll("[data-green-population-group]")];
    const selected = groups.find((group) => {
      const start = Number(group.getAttribute("x"));
      return pointerX >= start && pointerX <= start + Number(group.getAttribute("width"));
    }) ?? groups.at(-1);
    const output = chart.querySelector("[data-green-population-output]");
    if (output && selected) output.textContent = selected.dataset.boxLabel;
    const guide = svg.querySelector("[data-population-temperature-guide]");
    if (guide) {
      guide.hidden = false;
      guide.setAttribute("x1", pointerX);
      guide.setAttribute("x2", pointerX);
    }
  });
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
