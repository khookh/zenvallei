import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { defineLayer } from "./layer-contract.js";
import { createScenarioCoverRaster } from "./scenario-cover-raster.js";
import { createScenarioRuntime } from "./scenario-runtime.js";

const DATASET_ID = "land-cover-scenario";
const DRAW_SOURCE = "lst-scenario-drawing-source";
const DRAW_FILL = "lst-scenario-drawing-fill";
const DRAW_CASING = "lst-scenario-drawing-casing";
const DRAW_LINE = "lst-scenario-drawing-line";
const DRAW_VERTICES = "lst-scenario-drawing-vertices";
const DELTA_SOURCE = "lst-scenario-delta-source";
const DELTA_LAYER = "lst-scenario-delta-layer";
const COVER_CATEGORIES = Object.freeze(["high", "low", "sealed", "agriculture", "water", "bare", "locked"]);

export const DELTA_STOPS = Object.freeze([
  -14.12, -2, -1, -.5, -.25, -.1, -.05, -.025, 0,
  .025, .05, .1, .25, .5, 1, 2, 14.12,
]);
const DELTA_COLOURS = Object.freeze({ cooling: [33, 102, 172], warming: [178, 24, 43] });
export const DELTA_ALPHA_STOPS = Object.freeze([
  [0, 0], [.01, 0], [.025, 89], [.05, 128], [.1, 166], [.25, 199],
  [.5, 224], [1, 240], [2, 250], [14.12, 255],
]);
export const SCENARIO_COVER_OPACITY = .78;
export const SCENARIO_COVER_WITH_DELTA_OPACITY = .48;

export function scenarioDeltaColour(value) {
  const bounded = Math.max(-14.12, Math.min(14.12, Number(value) || 0));
  return [...(bounded < 0 ? DELTA_COLOURS.cooling : DELTA_COLOURS.warming)];
}

export function scenarioDeltaStyle(value) {
  const bounded = Math.max(-14.12, Math.min(14.12, Number(value) || 0));
  const magnitude = Math.abs(bounded);
  if (magnitude < .01) return { colour: scenarioDeltaColour(bounded), alpha: 0 };
  const upper = Math.max(1, DELTA_ALPHA_STOPS.findIndex(([stop]) => stop >= magnitude));
  const [leftValue, leftAlpha] = DELTA_ALPHA_STOPS[upper - 1];
  const [rightValue, rightAlpha] = DELTA_ALPHA_STOPS[upper];
  const amount = (magnitude - leftValue) / Math.max(.000001, rightValue - leftValue);
  return { colour: scenarioDeltaColour(bounded), alpha: Math.round(leftAlpha + (rightAlpha - leftAlpha) * amount) };
}

export function validateScenarioDescriptor(descriptor) {
  if (!descriptor || descriptor.datasetId !== DATASET_ID || descriptor.kind !== "scenario"
    || descriptor.baselineYears?.greenMap !== 2021 || descriptor.baselineYears?.urbanAtlas !== 2021
    || descriptor.baselineYears?.soilSealing !== 2024 || descriptor.baselineYears?.landUseWater !== 2025
    || !descriptor.manifestUrl) {
    throw new TypeError("Invalid land-cover scenario descriptor.");
  }
  return descriptor;
}

export function validateScenarioManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 7 || manifest.datasetId !== DATASET_ID
    || manifest.baselineYears?.greenMap !== 2021 || manifest.baselineYears?.urbanAtlas !== 2021
    || manifest.baselineYears?.soilSealing !== 2024 || manifest.baselineYears?.landUseWater !== 2025
    || manifest.psf?.sigmaMeters !== 79.5
    || manifest.psf?.gridResolutionMeters !== 15 || manifest.psf?.kernelSize !== 41
    || manifest.maskResolutionMeters !== 1 || manifest.temperatureGridResolutionMeters !== 30
    || !manifest.methods?.radoux?.source?.url || !manifest.methods?.xgboost?.source?.url
    || (manifest.methods.xgboost.available && (
      manifest.methods.xgboost.modelContractVersion !== 5
      || !manifest.methods.xgboost.modelSha256
      || !manifest.methods.xgboost.featureArtifactSha256
      || !manifest.methods.xgboost.catalogManifestSha256
      || !manifest.methods.xgboost.inferenceGrid?.sha256
    ))
    || !Array.isArray(manifest.methodOrder)
    || manifest.methodOrder.length !== 2
    || !["radoux", "xgboost"].every((id) => manifest.methodOrder.includes(id))
    || Object.keys(manifest.methods).length !== 2
    || !manifest.analysisWaterMask?.url || !manifest.analysisWaterMask?.sha256
    || manifest.analysisWaterMask.rendered !== false || manifest.analysisWaterMask.editable !== false
    || !manifest.urbanAtlasClassMaskUrl || !manifest.urbanAtlasClassIndexes?.["50000"]
    || manifest.browserRuntime?.protocolVersion !== 1
    || !manifest.browserRuntime?.baseline?.url || !manifest.browserRuntime?.outputScopes?.url
    || manifest.limits?.submittedAreaHa !== 200) {
    throw new TypeError("Unsupported land-cover scenario manifest.");
  }
  return manifest;
}

export function validateScenarioResult(result, sessionId, revision) {
  const distribution = result?.scopeStats?.region?.deltaDistribution;
  if (!result || result.schemaVersion !== 7 || result.sessionId !== sessionId
    || result.revision !== revision || !result.deltaRasters?.radoux
    || !result.scopeStats?.region || !distribution
    || distribution.affectedThresholdC !== .01
    || !Array.isArray(distribution.bins)) {
    throw new TypeError("Unsupported land-cover scenario result.");
  }
  return result;
}

export function scenarioOperationForTarget(target) {
  if (target === "restore") return { action: "restore", target: null };
  if (target === "unseal") return { action: "convert-to-low", target: "low" };
  if (target === "remove-high") return { action: "remove-high", target: null };
  if (["high", "sealed"].includes(target)) return { action: "convert", target };
  throw new TypeError("Unsupported land-cover scenario target.");
}

export function scenarioPointPopupModel(value, selectedMethod = "xgboost") {
  if (value?.status !== "available") return null;
  const lines = [];
  if (value.urbanAtlasClassCode) {
    lines.push(t("scenario.popupUrbanAtlas", {
      class: t(`urbanAtlas.class.${value.urbanAtlasClassCode}`),
    }));
  }
  const delta = value.deltaCByMethod?.[selectedMethod];
  if (Number.isFinite(delta) && Math.abs(delta) >= .01) {
    lines.push(t("scenario.popupDeltaMethod", {
      method: t(`scenario.method.${selectedMethod}`), value: formatNumber(delta, 2),
    }));
  }
  return lines.length ? { title: t("scenario.popupTitle"), lines } : null;
}

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

function polygonFeature(vertices) {
  if (!vertices.length) return emptyCollection();
  const vertexFeatures = vertices.map((coordinates, index) => ({
    type: "Feature", properties: { draft: true, vertex: index + 1 },
    geometry: { type: "Point", coordinates },
  }));
  if (vertices.length < 3) {
    return { type: "FeatureCollection", features: [{
      type: "Feature", properties: { draft: true },
      geometry: { type: "LineString", coordinates: vertices },
    }, ...vertexFeatures] };
  }
  return { type: "FeatureCollection", features: [{
    type: "Feature", properties: { draft: true },
    geometry: { type: "Polygon", coordinates: [[...vertices, vertices[0]]] },
  }, ...vertexFeatures] };
}

function distinctScenarioVertices(points) {
  return points.filter((point, index, all) => !index
    || Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]) > 1e-8);
}

function scopeStats(result, record) {
  if (!result?.scopeStats) return null;
  if (record.scope === "region") return result.scopeStats.region;
  if (record.scope === "municipality") return result.scopeStats.municipalities?.[record.municipality] ?? null;
  return result.scopeStats.sectors?.[record.sectorId] ?? null;
}

function deltaScaleGradient() {
  return `linear-gradient(90deg,${DELTA_STOPS.map((value) => {
    const { colour, alpha } = scenarioDeltaStyle(value);
    return `rgb(${colour.join(" ")} / ${(alpha / 255).toFixed(3)}) ${((value + 14.12) / 28.24 * 100).toFixed(2)}%`;
  }).join(",")})`;
}

function renderDelta(values, width, height) {
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index];
    const offset = index * 4;
    const { colour, alpha } = scenarioDeltaStyle(delta);
    output[offset] = colour[0];
    output[offset + 1] = colour[1];
    output[offset + 2] = colour[2];
    output[offset + 3] = alpha;
  }
  return new ImageData(output, width, height);
}

export function createLandCoverScenarioLayer({ descriptor: inputDescriptor, groenkaartLayer, jaarbakLayer }) {
  // Revisions and edits are intentionally limited to one page session.
  const sessionId = globalThis.crypto?.randomUUID?.()
    ?? `scenario-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let descriptor;
  let manifest = null;
  let manifestPromise = null;
  let loadError = "";
  try { descriptor = validateScenarioDescriptor(inputDescriptor); }
  catch (error) { loadError = error.message; descriptor = { available: false, assetRoot: "" }; }

  let map;
  let mounted = false;
  let visible = false;
  let activeMunicipality = "";
  let target = "high";
  let drawing = false;
  let vertices = [];
  let operations = [];
  let presentedOperations = [];
  let redoOperations = [];
  let revision = 0;
  let result = null;
  let selectedMethod = "xgboost";
  let methodFallback = false;
  let deltaVisible = false;
  const visibleCategories = new Set(COVER_CATEGORIES);
  const deltaImages = new Map();
  let generation = 0;
  let requestController = null;
  let calculationError = "";
  let calculating = false;
  let canvas;
  let canvasContext;
  let runtime;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  let greenArchive = "";
  let soilArchive = "";
  let urbanArchive = "";
  let analysisWaterArchive = "";
  const coverMap = createScenarioCoverRaster({
    id: "lst-scenario-cover", beforeLayerId: "heat-sectors-hit-area",
  });

  const ensureManifest = async () => {
    if (manifest) return manifest;
    if (!manifestPromise) manifestPromise = fetch(descriptor.manifestUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Scenario manifest HTTP ${response.status}.`);
        manifest = validateScenarioManifest(await response.json());
        if (!manifest.methods?.[selectedMethod]?.available) {
          selectedMethod = "radoux";
          methodFallback = true;
        }
        return manifest;
      }).catch((error) => { loadError = error.message; manifestPromise = null; throw error; });
    return manifestPromise;
  };

  const updateDraft = () => map?.getSource(DRAW_SOURCE)?.setData(polygonFeature(vertices));

  const setLayerVisible = (layerId, nextVisible) => {
    if (map?.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", nextVisible ? "visible" : "none");
  };

  const applyPresentation = () => {
    const showDelta = Boolean(visible && deltaVisible && result);
    coverMap.setVisible(Boolean(visible));
    coverMap.setOpacity(showDelta ? SCENARIO_COVER_WITH_DELTA_OPACITY : SCENARIO_COVER_OPACITY);
    setLayerVisible(DELTA_LAYER, showDelta);
    setLayerVisible(DRAW_FILL, Boolean(visible && drawing));
    setLayerVisible(DRAW_CASING, Boolean(visible && drawing));
    setLayerVisible(DRAW_LINE, Boolean(visible && drawing));
    setLayerVisible(DRAW_VERTICES, Boolean(visible && drawing));
    // Draft geometry must remain legible above thermal rasters and boundaries.
    [DRAW_FILL, DRAW_CASING, DRAW_LINE, DRAW_VERTICES].forEach((layerId) => {
      if (map?.getLayer(layerId)) map.moveLayer(layerId);
    });
    map?.triggerRepaint();
  };

  const coverConfiguration = (operationSnapshot = presentedOperations) => ({
    greenUrl: greenArchive,
    soilUrl: soilArchive,
    urbanUrl: urbanArchive,
    analysisWaterUrl: analysisWaterArchive,
    waterIndex: manifest.urbanAtlasClassIndexes["50000"],
    operations: operationSnapshot.map((operation) => ({ ...operation })),
    visibleCategories: [...visibleCategories],
  });

  const refreshCover = async (operationSnapshot = presentedOperations) => {
    if (!mounted || !greenArchive || !soilArchive || !urbanArchive || !analysisWaterArchive) return false;
    return coverMap.show(map, coverConfiguration(operationSnapshot));
  };

  const renderSelectedDelta = () => {
    const values = deltaImages.get(selectedMethod) ?? deltaImages.get("radoux");
    const raster = result?.deltaRasters?.[selectedMethod] ?? result?.deltaRasters?.radoux;
    if (!values || !raster) return;
    canvas.width = raster.width;
    canvas.height = raster.height;
    canvasContext = canvas.getContext("2d", { alpha: true });
    canvasContext.putImageData(renderDelta(values, raster.width, raster.height), 0, 0);
    const source = map.getSource(DELTA_SOURCE);
    source.setCoordinates(raster.coordinates);
    source.play?.();
    map.triggerRepaint();
    requestAnimationFrame(() => source.pause?.());
  };

  const renderResult = async (nextResult, requestGeneration, operationSnapshot) => {
    const images = Object.entries(nextResult.deltaRasters ?? {}).map(([method, raster]) => (
      [method, new Float32Array(raster.values)]
    ));
    if (requestGeneration !== generation) return;
    // The cover source remains on its last validated generation until every
    // replacement tile is ready. Updating the delta canvas immediately after
    // this awaited swap occurs in the same task, before MapLibre's next paint.
    await refreshCover(operationSnapshot);
    if (requestGeneration !== generation) return;
    presentedOperations = [...operationSnapshot];
    deltaImages.clear();
    images.forEach(([method, encoded]) => deltaImages.set(method, encoded));
    if (!deltaImages.has(selectedMethod)) {
      selectedMethod = "radoux";
      methodFallback = true;
    }
    result = nextResult;
    if ((nextResult.scopeStats?.region?.acceptedAreaHa ?? 0) > 0) deltaVisible = true;
    renderSelectedDelta();
    applyPresentation();
  };

  const calculate = async () => {
    if (!mounted) return false;
    const requestGeneration = ++generation;
    requestController?.abort();
    requestController = new AbortController();
    calculating = true;
    calculationError = "";
    const operationSnapshot = operations.map((operation) => ({ ...operation }));
    notify();
    try {
      const payload = await runtime.simulate(
        { schemaVersion: 1, sessionId, revision, operations: operationSnapshot },
        requestController.signal,
      );
      await renderResult(
        validateScenarioResult(payload, sessionId, revision), requestGeneration, operationSnapshot,
      );
      return true;
    } catch (error) {
      if (error.name !== "AbortError" && requestGeneration === generation) calculationError = error.message;
      return false;
    } finally {
      if (requestGeneration === generation) calculating = false;
      notify();
    }
  };

  const finishDrawing = async () => {
    const cleanedVertices = distinctScenarioVertices(vertices);
    if (!drawing || cleanedVertices.length < 3) return false;
    const operation = scenarioOperationForTarget(target);
    operations.push({
      id: `operation-${revision + 1}`,
      ...operation,
      geometry: { type: "Polygon", coordinates: [[...cleanedVertices, cleanedVertices[0]]] },
    });
    redoOperations = [];
    revision += 1;
    drawing = false;
    vertices = [];
    map?.doubleClickZoom?.enable();
    updateDraft();
    notify();
    return calculate();
  };

  const cancelDrawing = () => {
    drawing = false;
    vertices = [];
    map?.doubleClickZoom?.enable();
    updateDraft();
    applyPresentation();
    notify();
  };

  const editorModel = () => ({
    target, drawing, vertexCount: vertices.length,
    canFinish: distinctScenarioVertices(vertices).length >= 3,
    calculating, error: calculationError,
    canUndo: operations.length > 0 && !drawing,
    canRedo: redoOperations.length > 0 && !drawing,
    canReset: operations.length > 0 && !drawing,
    limits: manifest?.limits,
  });

  return defineLayer({
    id: DATASET_ID,
    categoryId: "heat",
    supportsMunicipalitySummary: true,
    supportsRegionSummary: true,
    isAvailable: () => Boolean(descriptor.available !== false && !loadError),
    getUnavailableReasonKey: () => loadError ? "scenario.loadError" : "scenario.unavailable",
    getLabel: () => t("layers.landCoverScenario"),
    getContext: () => ({
      meta: t("scenario.contextMeta"), text: t(`scenario.contextText.${selectedMethod}`),
      note: calculationError ? t("scenario.error", { message: calculationError }) : "",
      sources: [productLink(
        manifest?.methods?.[selectedMethod]?.productId ?? selectedMethod,
        manifest?.methods?.[selectedMethod]?.source?.url,
      )],
    }),
    getLegendModel: () => ({
      title: t("scenario.coverLegendTitle"), layout: "scenario", groups: [],
      scenarioSelector: {
        title: t("scenario.categoryPrompt"),
        items: [
          { id: "high", label: t("scenario.high"), color: "#1f7f00", pattern: true },
          { id: "low", label: t("scenario.low"), color: "#bfff00" },
          { id: "sealed", label: t("scenario.sealed"), color: "#e8292f" },
          { id: "agriculture", label: t("groenkaart.agriculture"), color: "#ffe600" },
          { id: "water", label: t("scenario.class.water"), color: "#4691d0" },
          { id: "bare", label: t("scenario.class.bare"), color: "#b09976" },
          { id: "locked", label: t("scenario.locked"), color: "#adadad" },
        ].map((item) => ({ ...item, selected: visibleCategories.has(item.id) })),
        delta: { label: t("scenario.deltaToggle"), selected: deltaVisible, disabled: !result },
      },
      continuousScale: result && deltaVisible ? {
        gradient: deltaScaleGradient(), ticks: [-14.12, -2, -.5, 0, .5, 2, 14.12], unit: "°C",
        accessibleLabel: t("scenario.deltaLegendAccessible"),
        transparentCentre: true,
      } : null,
      methodSelector: {
        title: t("scenario.methodPrompt"),
        items: (manifest?.methodOrder ?? ["radoux", "xgboost"]).map((id) => ({
          id, label: t(`scenario.method.${id}`), selected: selectedMethod === id,
          disabled: !manifest?.methods?.[id]?.available,
        })),
      },
      note: deltaVisible
        ? `${t("scenario.coverLegendNote")} ${t("scenario.deltaLegendNote")}`
        : t("scenario.coverLegendNote"),
    }),
    getPopupModel: (feature, _record) => ({
      title: feature.properties.sectorName, subtitle: feature.properties.municipality,
      lines: [t("scenario.popupHint")],
    }),
    getPanelModel: (record) => ({
      template: "land-cover-scenario", record, manifest, selectedMethod, methodFallback,
      diagnostics: result?.diagnosticsByMethod?.[selectedMethod],
      editor: editorModel(), stats: scopeStats(result?.scopeStatsByMethod?.[selectedMethod] ? {
        scopeStats: result.scopeStatsByMethod[selectedMethod],
      } : result, record), hasResult: Boolean(result),
    }),
    async mount(nextMap, context) {
      map = nextMap;
      await Promise.all([ensureManifest(), groenkaartLayer.ensureManifest(), jaarbakLayer.ensureManifest()]);
      runtime ??= createScenarioRuntime({ manifest, assetRoot: descriptor.assetRoot });
      greenArchive = await groenkaartLayer.resolveArchive(2021, activeMunicipality);
      soilArchive = await jaarbakLayer.resolveArchive(2024, activeMunicipality);
      urbanArchive = new URL(
        manifest.urbanAtlasClassMaskUrl,
        new URL(descriptor.assetRoot, window.location.origin),
      ).href;
      analysisWaterArchive = new URL(
        manifest.analysisWaterMask.url,
        new URL(descriptor.assetRoot, window.location.origin),
      ).href;
      if (!map.getSource(DELTA_SOURCE)) {
        canvas = document.createElement("canvas");
        canvas.id = "lst-scenario-delta-canvas";
        canvas.width = manifest.outputGrid.width;
        canvas.height = manifest.outputGrid.height;
        canvas.setAttribute("aria-hidden", "true");
        document.body.append(canvas);
        map.addSource(DELTA_SOURCE, {
          type: "canvas", canvas,
          coordinates: [[2.9, 50.9], [4.7, 50.9], [4.7, 50.6], [2.9, 50.6]], animate: false,
        });
        map.addLayer({
          id: DELTA_LAYER, type: "raster", source: DELTA_SOURCE,
          layout: { visibility: "none" },
          paint: { "raster-opacity": 1, "raster-resampling": "linear", "raster-fade-duration": 0 },
        }, context.beforeLayerId);
      }
      if (!map.getSource(DRAW_SOURCE)) {
        map.addSource(DRAW_SOURCE, { type: "geojson", data: emptyCollection() });
        map.addLayer({
          id: DRAW_FILL, type: "fill", source: DRAW_SOURCE,
          layout: { visibility: "none" }, paint: { "fill-color": "#ffffff", "fill-opacity": .2 },
        });
        map.addLayer({
          id: DRAW_CASING, type: "line", source: DRAW_SOURCE,
          layout: { visibility: "none" },
          paint: { "line-color": "#123b43", "line-width": 7, "line-opacity": .92 },
        });
        map.addLayer({
          id: DRAW_LINE, type: "line", source: DRAW_SOURCE,
          layout: { visibility: "none" }, paint: { "line-color": "#ffffff", "line-width": 4 },
        });
        map.addLayer({
          id: DRAW_VERTICES, type: "circle", source: DRAW_SOURCE,
          layout: { visibility: "none" },
          paint: {
            "circle-radius": 5, "circle-color": "#ffffff",
            "circle-stroke-width": 2.5, "circle-stroke-color": "#123b43",
          },
        });
      }
      mounted = true;
      await refreshCover();
      return true;
    },
    setVisible(_map, nextVisible) { visible = nextVisible; if (!visible && drawing) cancelDrawing(); applyPresentation(); },
    async applyFilter(_map, _filter, context = {}) {
      const municipality = context.municipality ?? "";
      if (municipality === activeMunicipality) return;
      activeMunicipality = municipality;
      if (!mounted) return;
      greenArchive = await groenkaartLayer.resolveArchive(2021, activeMunicipality);
      soilArchive = await jaarbakLayer.resolveArchive(2024, activeMunicipality);
      await refreshCover();
    },
    getScenarioEditorModel: editorModel,
    subscribeScenario(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setScenarioTarget(nextTarget) {
      if (!["high", "remove-high", "sealed", "unseal", "restore"].includes(nextTarget) || drawing) return false;
      target = nextTarget; notify(); return true;
    },
    toggleScenarioCategory(category) {
      if (!COVER_CATEGORIES.includes(category)) return false;
      if (visibleCategories.has(category)) visibleCategories.delete(category);
      else visibleCategories.add(category);
      refreshCover().catch((error) => { calculationError = error.message; notify(); });
      return true;
    },
    toggleScenarioDelta() {
      if (!result) return false;
      deltaVisible = !deltaVisible;
      applyPresentation();
      return true;
    },
    setScenarioMethod(nextMethod) {
      if (!(manifest?.methodOrder ?? []).includes(nextMethod)
        || !manifest?.methods?.[nextMethod]?.available) return false;
      selectedMethod = nextMethod;
      methodFallback = false;
      renderSelectedDelta();
      applyPresentation();
      notify();
      return true;
    },
    beginScenarioPolygon() {
      if (drawing || calculating) return false;
      drawing = true; vertices = []; map?.doubleClickZoom?.disable(); updateDraft(); applyPresentation(); notify(); return true;
    },
    finishScenarioPolygon: finishDrawing,
    cancelScenarioPolygon: cancelDrawing,
    removeScenarioVertex() { if (!drawing || !vertices.length) return false; vertices.pop(); updateDraft(); notify(); return true; },
    async undoScenario() {
      if (drawing || calculating || !operations.length) return false;
      redoOperations.push(operations.pop()); revision += 1; notify(); return calculate();
    },
    async redoScenario() {
      if (drawing || calculating || !redoOperations.length) return false;
      operations.push(redoOperations.pop()); revision += 1; notify(); return calculate();
    },
    async resetScenario() {
      if (drawing || calculating || !operations.length) return false;
      operations = []; redoOperations = []; revision += 1; notify(); return calculate();
    },
    retryScenario: calculate,
    isDrawingActive: () => drawing,
    handleMapClick(event) {
      if (!drawing) return false;
      vertices.push([event.lngLat.lng, event.lngLat.lat]); updateDraft(); notify(); return true;
    },
    handleMapDoubleClick(event) {
      if (!drawing) return false;
      event.preventDefault?.(); finishDrawing(); return true;
    },
    isPointInspectionActive: () => Boolean(result && !drawing),
    getInspectionCursor: () => "pointer",
    async inspectPoint(point, { signal } = {}) {
      if (!result) return { status: "empty" };
      return runtime.inspect({
        sessionId, revision: result.revision, method: selectedMethod, lng: point.lng, lat: point.lat,
      }, signal);
    },
    getPointPopupModel(value) {
      return scenarioPointPopupModel(value, selectedMethod);
    },
    getRuntimeData: () => ({
      manifest, result, operations: [...operations], selectedMethod, methodFallback,
    }),
  });
}
