const EXPANDED_MIN_WIDTH = 1180;
const MEDIUM_MIN_WIDTH = 760;

export function surfaceModeForWidth(width) {
  if (width >= EXPANDED_MIN_WIDTH) return "expanded";
  if (width >= MEDIUM_MIN_WIDTH) return "medium";
  return "compact";
}

function intersects(left, right) {
  return left.left < right.right && left.right > right.left
    && left.top < right.bottom && left.bottom > right.top;
}

export function visibleSurfaceIntersections(elements) {
  const visible = elements.filter((element) => element
    && !element.hidden
    && element.getAttribute("aria-hidden") !== "true"
    && element.getClientRects().length);
  const collisions = [];
  for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
      if (intersects(visible[leftIndex].getBoundingClientRect(), visible[rightIndex].getBoundingClientRect())) {
        collisions.push([visible[leftIndex], visible[rightIndex]]);
      }
    }
  }
  return collisions;
}

/** Coordinate controls, legend and results as adaptive map surfaces. */
export function createMapSurfaceLayout({
  shell,
  controls,
  legend,
  panel,
  setControlsExpanded,
  setLegendExpanded,
  setPanelPresentation,
  getPanelPresentation,
  onPaddingChange,
}) {
  const desired = {
    controlsExpanded: true,
    legendExpanded: legend.open,
    panelPresentation: "closed",
  };
  let mode = surfaceModeForWidth(shell.clientWidth || window.innerWidth);
  let priority = "controls";
  let applying = false;
  let frame = 0;
  let initialised = false;

  const boundsWithinShell = (element) => {
    if (!element || element.hidden || !element.getClientRects().length) return null;
    const root = shell.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      left: Math.max(0, rect.left - root.left),
      right: Math.max(0, root.right - rect.right),
      top: Math.max(0, rect.top - root.top),
      bottom: Math.max(0, root.bottom - rect.bottom),
      width: rect.width,
      height: rect.height,
    };
  };

  const padding = () => {
    const root = shell.getBoundingClientRect();
    const controlBounds = boundsWithinShell(controls);
    const legendBounds = boundsWithinShell(legend);
    const panelBounds = panel.getAttribute("aria-hidden") === "true" ? null : boundsWithinShell(panel);
    const next = { top: 24, right: 28, bottom: 62, left: 28 };
    if (mode === "expanded") {
      if (controlBounds) next.left = Math.ceil(controlBounds.left + controlBounds.width + 16);
      if (panelBounds && getPanelPresentation() === "expanded") next.right = Math.ceil(panelBounds.right + panelBounds.width + 16);
      if (legendBounds) next.bottom = Math.ceil(legendBounds.bottom + legendBounds.height + 14);
    } else {
      if (controlBounds && controls.classList.contains("is-collapsed") === false) {
        next.top = Math.min(Math.ceil(controlBounds.top + controlBounds.height + 12), Math.max(24, root.height - 180));
      }
      if (legendBounds) next.bottom = Math.ceil(legendBounds.bottom + legendBounds.height + 12);
      if (panelBounds) next.bottom = Math.max(next.bottom, Math.ceil(panelBounds.bottom + panelBounds.height + 12));
      next.left = 20;
      next.right = 68;
    }
    return next;
  };

  const apply = () => {
    frame = 0;
    applying = true;
    mode = surfaceModeForWidth(shell.clientWidth || window.innerWidth);
    shell.dataset.surfaceMode = mode;

    // A result may open during the same frame in which this coordinator is
    // created. Trust the visible panel rectangle if its open request arrived
    // before the layout object was assigned to the application.
    if (!initialised
      && panel.getAttribute("aria-hidden") === "false"
      && desired.panelPresentation === "closed") {
      desired.panelPresentation = "expanded";
      priority = "panel";
    }
    initialised = true;

    let controlsExpanded = desired.controlsExpanded;
    let legendExpanded = desired.legendExpanded;
    let panelPresentation = desired.panelPresentation;
    if (mode !== "expanded") {
      if (priority === "panel" && panelPresentation === "expanded") {
        controlsExpanded = false;
        legendExpanded = false;
      } else if (priority === "legend" && legendExpanded) {
        controlsExpanded = false;
        panelPresentation = "closed";
      } else {
        legendExpanded = false;
        if (controlsExpanded) panelPresentation = "closed";
      }
    }

    setControlsExpanded(controlsExpanded);
    setLegendExpanded(legendExpanded);
    setPanelPresentation(panelPresentation);
    const verticallyConstrained = shell.clientHeight < 420;
    legend.classList.toggle(
      "is-surface-suppressed",
      mode !== "expanded" && verticallyConstrained
        && ((priority === "panel" && panelPresentation === "expanded")
          || (priority === "controls" && controlsExpanded)),
    );

    requestAnimationFrame(() => {
      const controlRect = controls.getBoundingClientRect();
      const panelRect = panel.getAttribute("aria-hidden") === "true" ? null : panel.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const controlsAreExpanded = !controls.classList.contains("is-collapsed");
      const legendDockLeft = mode === "expanded" && controlsAreExpanded
        ? Math.ceil(controlRect.right - shellRect.left + 16)
        : 16;
      const available = mode === "expanded"
        ? (panelRect?.left ?? shellRect.right) - shellRect.left - legendDockLeft - 16
        : shellRect.width - 32;
      legend.style.setProperty("--legend-safe-width", `${Math.max(196, Math.floor(available))}px`);
      legend.style.setProperty("--legend-dock-left", `${legendDockLeft}px`);
      const nativeControlRight = mode === "expanded" && panelRect && getPanelPresentation() === "expanded"
        ? Math.ceil(shellRect.right - panelRect.left + 14)
        : 12;
      shell.style.setProperty("--map-native-right", `${nativeControlRight}px`);
      legend.classList.toggle("is-auto-compact", mode === "expanded" && available < 360);
      if (mode === "expanded" && available < 360 && legend.open) setLegendExpanded(false);
      applying = false;
      onPaddingChange?.(padding());
    });
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(apply);
  };

  const observer = new ResizeObserver(schedule);
  [shell, controls, legend, panel].forEach((element) => observer.observe(element));

  const requestControls = (expanded) => {
    desired.controlsExpanded = expanded;
    if (expanded) {
      priority = "controls";
      if (mode !== "expanded") {
        desired.legendExpanded = false;
        desired.panelPresentation = "closed";
      }
    }
    schedule();
  };
  const requestLegend = (expanded) => {
    if (!applying) desired.legendExpanded = expanded;
    if (expanded) {
      priority = "legend";
      if (mode !== "expanded") {
        desired.controlsExpanded = false;
        desired.panelPresentation = "closed";
      }
    }
    schedule();
  };
  const requestPanel = (presentation) => {
    desired.panelPresentation = presentation;
    if (presentation === "expanded" && mode !== "expanded") {
      desired.controlsExpanded = false;
      desired.legendExpanded = false;
    }
    priority = presentation === "expanded"
      ? "panel"
      : (desired.legendExpanded ? "legend" : "controls");
    schedule();
  };

  schedule();
  return {
    requestControls,
    requestLegend,
    requestPanel,
    getMode: () => mode,
    getPadding: padding,
    reconcile: schedule,
    isApplying: () => applying,
    destroy() {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
