import * as maplibregl from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { collectionBounds, geometryBounds } from "./data.js";
import { t } from "./i18n.js";
import { createMapSourceDialog } from "./map-source-dialog.js";

maplibregl.setWorkerUrl(mapLibreWorkerUrl);

// These IDs are intentionally stable because browser diagnostics and saved
// tests use them to query rendered sector geometry.
const SECTOR_SOURCE_ID = "heat-sectors";
const COMMON_LAYER_IDS = Object.freeze({
  hit: "heat-sectors-hit-area",
  outlineCasing: "heat-sectors-outline-casing",
  outline: "heat-sectors-outline",
  selected: "heat-sector-selected",
  inspectionRadius: "point-inspection-radius",
});
const INSPECTION_RADIUS_SOURCE_ID = "point-inspection-radius-source";
const GUIDE_SOURCE_ID = "guide-geography-source";
const GUIDE_LAYER_IDS = Object.freeze({
  municipalityFill: "guide-municipality-fill",
  municipalityCasing: "guide-municipality-casing",
  municipalityLine: "guide-municipality-line",
  regionShadow: "guide-region-shadow",
  regionCasing: "guide-region-casing",
  regionLine: "guide-region-line",
});
const GUIDE_RASTER_IDS = Object.freeze([0, 1].map((slot) => ({
  source: `guide-landsat-source-${slot}`,
  layer: `guide-landsat-raster-${slot}`,
})));

function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(finish, milliseconds);
    const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
    function finish(error = null) {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function radiusPolygon(lngLat, radiusMeters, points = 64) {
  const latitudeRadians = lngLat.lat * Math.PI / 180;
  const latitudeScale = radiusMeters / 111_320;
  const longitudeScale = radiusMeters / (111_320 * Math.max(0.01, Math.cos(latitudeRadians)));
  const coordinates = Array.from({ length: points + 1 }, (_, index) => {
    const angle = index / points * Math.PI * 2;
    return [lngLat.lng + Math.cos(angle) * longitudeScale, lngLat.lat + Math.sin(angle) * latitudeScale];
  });
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coordinates] } };
}

/**
 * Keep MapLibre camera padding inside a usable viewport. Responsive surfaces
 * can resize in the same frame as a filter or focus request; passing padding
 * that temporarily consumes the complete canvas makes fitBounds derive a NaN
 * centre. The minimum map window also keeps the requested geography visible.
 */
export function clampViewportPadding(padding, width, height, minimumMapSize = 120) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : minimumMapSize;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : minimumMapSize;
  const result = Object.fromEntries(["top", "right", "bottom", "left"].map((key) => [
    key,
    Math.max(0, Number.isFinite(padding?.[key]) ? padding[key] : 0),
  ]));

  const constrainAxis = (startKey, endKey, size) => {
    const maximumTotal = Math.max(0, size - Math.min(minimumMapSize, size));
    const total = result[startKey] + result[endKey];
    if (total <= maximumTotal || total === 0) return;
    const ratio = maximumTotal / total;
    result[startKey] *= ratio;
    result[endKey] *= ratio;
  };
  constrainAxis("left", "right", safeWidth);
  constrainAxis("top", "bottom", safeHeight);
  return result;
}

export function interactionCursor(layer) {
  if (layer?.isDrawingActive?.()) return "crosshair";
  if (layer?.isPointInspectionActive?.()) return layer.getInspectionCursor?.() ?? "pointer";
  return "";
}

function renderPopup(model) {
  const wrapper = document.createElement("div");
  wrapper.className = "sector-tooltip";

  const title = document.createElement("strong");
  title.textContent = model.title;
  wrapper.append(title);

  if (model.subtitle) {
    const subtitle = document.createElement("span");
    subtitle.textContent = model.subtitle;
    wrapper.append(subtitle);
  }

  model.lines.forEach((line) => {
    const value = document.createElement("b");
    value.textContent = line;
    wrapper.append(value);
  });
  return wrapper;
}

/**
 * Create the shared MapLibre shell. Dataset-specific sources, styles and popup
 * meanings are delegated to the registered layer modules.
 */
export function createMapController({
  container,
  geojson,
  scores,
  layers,
  config,
  initialLayerId = "heat",
  onSectorSelect,
  onBasemapError,
  onLayerError,
}) {
  const fullBounds = collectionBounds(geojson);
  const featureById = new Map(geojson.features.map((feature) => [feature.properties.sectorId, feature]));
  let activeMunicipality = "";
  let activeLayerId = initialLayerId;
  let popupModelProvider = null;
  let pointInspectionProvider = null;
  let selectedSectorId = "";
  let viewportPaddingOverride = null;
  let basemapErrorReported = false;
  let hoveredId = null;
  let inspectionTimer = 0;
  let inspectionRequest = null;
  let guideMode = false;
  let guideMarkers = [];
  let guideRasterSlot = -1;
  let guideRasterGeneration = 0;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "260px" });

  const clearInspection = () => {
    window.clearTimeout(inspectionTimer);
    inspectionTimer = 0;
    inspectionRequest?.abort();
    inspectionRequest = null;
    map?.getSource?.(INSPECTION_RADIUS_SOURCE_ID)?.setData?.({ type: "FeatureCollection", features: [] });
  };

  const inspectPoint = (lngLat, { immediate = false } = {}) => {
    const layer = pointInspectionProvider ?? currentLayer();
    if (!layer?.inspectPoint || !layer?.getPointPopupModel || layer.isPointInspectionActive?.() === false) return false;
    clearInspection();
    const radiusMeters = layer.getInspectionRadiusMeters?.() ?? 0;
    if (radiusMeters > 0) {
      map.getSource(INSPECTION_RADIUS_SOURCE_ID)?.setData(radiusPolygon(lngLat, radiusMeters));
    }
    const run = async () => {
      const controller = new AbortController();
      inspectionRequest = controller;
      try {
        const result = await layer.inspectPoint(
          { lng: lngLat.lng, lat: lngLat.lat },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || layer !== (pointInspectionProvider ?? currentLayer())) return;
        const popupModel = layer.getPointPopupModel(result);
        if (!popupModel) {
          popup.remove();
          return;
        }
        popup.setLngLat(lngLat).setDOMContent(renderPopup(popupModel)).addTo(map);
      } catch (error) {
        if (error.name !== "AbortError") popup.remove();
      } finally {
        if (inspectionRequest === controller) inspectionRequest = null;
      }
    };
    if (immediate) run();
    else inspectionTimer = window.setTimeout(run, 90);
    return true;
  };

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: [config.tileUrl],
          tileSize: config.tileSize,
          maxzoom: config.maximumZoom,
          attribution: config.tileAttribution,
        },
      },
      layers: [{ id: "osm-background", type: "raster", source: "osm" }],
    },
    bounds: fullBounds,
    fitBoundsOptions: { padding: 44, duration: 0 },
    minZoom: 9,
    maxZoom: 18,
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    attributionControl: false,
  });

  const sourceDialog = createMapSourceDialog({ config, layers });
  map.addControl(sourceDialog.control, "bottom-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "bottom-right");

  const currentLayer = () => layers.get(activeLayerId);
  const refreshInteractionCursor = () => {
    map.getCanvas().style.cursor = interactionCursor(currentLayer());
  };

  const updateMapAccessibility = () => {
    const translatedControls = [
      [container.querySelector(".maplibregl-ctrl-zoom-in"), "maplibre.zoomIn"],
      [container.querySelector(".maplibregl-ctrl-zoom-out"), "maplibre.zoomOut"],
    ];
    translatedControls.forEach(([element, key]) => {
      if (!element) return;
      const label = t(key);
      element.setAttribute("aria-label", label);
      element.setAttribute("title", label);
    });
    const canvas = map.getCanvas();
    canvas.setAttribute("aria-label", t("map.regionForLayer", { layer: currentLayer()?.getLabel() ?? "" }));
    canvas.setAttribute("title", t("maplibre.mapTitle"));
    sourceDialog.updateLanguage();
  };
  updateMapAccessibility();

  const activeFilter = () => activeMunicipality
    ? ["==", ["get", "municipality"], activeMunicipality]
    : null;

  const applyLayerFilter = () => {
    const filter = activeFilter();
    [COMMON_LAYER_IDS.hit, COMMON_LAYER_IDS.outlineCasing, COMMON_LAYER_IDS.outline].forEach((layerId) => {
      if (map.getLayer(layerId)) map.setFilter(layerId, filter);
    });
    layers.forEach((layer) => layer.applyFilter(map, filter, { municipality: activeMunicipality }));
  };

  const ready = new Promise((resolve, reject) => {
    // The sector overlay depends on the style, not on successful basemap tiles.
    // Initialising at style.load keeps local data usable during a tile outage.
    map.once("style.load", async () => {
      try {
        performance.mark("heat-overlay-start");
        map.addSource(SECTOR_SOURCE_ID, { type: "geojson", data: geojson, promoteId: "sectorId" });

        const initialLayer = currentLayer();
        if (!initialLayer || !await initialLayer.mount(map, { sectorSourceId: SECTOR_SOURCE_ID })) {
          throw new Error(`Initial layer '${activeLayerId}' is unavailable.`);
        }
        initialLayer.setVisible(map, true);

        map.addLayer({
          id: COMMON_LAYER_IDS.outlineCasing,
          type: "line",
          source: SECTOR_SOURCE_ID,
          paint: {
            "line-color": "rgba(7,34,42,0.72)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 14, 3.2],
          },
        });
        map.addLayer({
          id: COMMON_LAYER_IDS.outline,
          type: "line",
          source: SECTOR_SOURCE_ID,
          paint: {
            "line-color": "rgba(255,255,255,0.92)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 14, 1.2],
          },
        });
        map.addLayer({
          id: COMMON_LAYER_IDS.hit,
          type: "fill",
          source: SECTOR_SOURCE_ID,
          paint: {
            "fill-color": "#ffffff",
            "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.12, 0],
          },
        }, COMMON_LAYER_IDS.outlineCasing);
        map.addLayer({
          id: COMMON_LAYER_IDS.selected,
          type: "line",
          source: SECTOR_SOURCE_ID,
          filter: ["==", ["get", "sectorId"], ""],
          paint: { "line-color": "#0B2F3A", "line-width": 4, "line-blur": 0.25 },
        });
        map.addSource(INSPECTION_RADIUS_SOURCE_ID, {
          type: "geojson", data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: COMMON_LAYER_IDS.inspectionRadius,
          type: "line",
          source: INSPECTION_RADIUS_SOURCE_ID,
          paint: { "line-color": "#0b6e69", "line-width": 2.5, "line-opacity": 0.95 },
        });

        map.on("mousemove", COMMON_LAYER_IDS.hit, (event) => {
          const feature = event.features?.[0];
          if (!feature) return;
          if (currentLayer()?.isDrawingActive?.()) {
            popup.remove();
            map.getCanvas().style.cursor = "crosshair";
            return;
          }
          map.getCanvas().style.cursor = currentLayer()?.isPointInspectionActive?.()
            ? (currentLayer()?.getInspectionCursor?.() ?? "crosshair") : "pointer";
          if (hoveredId && hoveredId !== feature.id) {
            map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
          }
          hoveredId = feature.id;
          map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: true });
          if (!inspectPoint(event.lngLat)) {
            const record = scores[feature.properties.sectorId];
            const model = popupModelProvider?.(feature, record, event) ?? currentLayer().getPopupModel(feature, record);
            popup.setLngLat(event.lngLat).setDOMContent(renderPopup(model)).addTo(map);
          }
        });
        map.on("mouseleave", COMMON_LAYER_IDS.hit, () => {
          // A tap is followed by a synthetic pointer leave on coarse-pointer
          // browsers.  Aborting here used to cancel the inspection request and
          // made scenario/density popups disappear before they could be read.
          const retainTappedInspection = window.matchMedia("(pointer: coarse)").matches
            && currentLayer()?.isPointInspectionActive?.();
          if (retainTappedInspection) {
            if (hoveredId) map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
            hoveredId = null;
            refreshInteractionCursor();
            return;
          }
          clearInspection();
          refreshInteractionCursor();
          if (hoveredId) map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
          hoveredId = null;
          popup.remove();
        });
        // Drawing belongs to the map surface, not to the invisible sector hit
        // layer. A general handler allows polygons to cross sector or region
        // boundaries so the worker can account for outside-scope area.
        map.on("click", (event) => {
          const layer = currentLayer();
          if (layer?.isDrawingActive?.()) layer.handleMapClick?.(event);
        });
        map.on("click", COMMON_LAYER_IDS.hit, async (event) => {
          const feature = event.features?.[0];
          const layer = currentLayer();
          if (layer?.isDrawingActive?.()) return;
          const inspectedFeature = await layer?.inspectFeature?.(map, event);
          if (inspectedFeature) {
            popup.setLngLat(event.lngLat).setDOMContent(renderPopup(inspectedFeature)).addTo(map);
            return;
          }
          const isTouch = event.originalEvent?.pointerType === "touch"
            || window.matchMedia("(pointer: coarse)").matches;
          if (isTouch && inspectPoint(event.lngLat, { immediate: true })) return;
          if (feature) onSectorSelect(feature.properties.sectorId, { source: "map" });
        });
        map.on("dblclick", (event) => {
          currentLayer()?.handleMapDoubleClick?.(event);
        });

        // Vite compiles the MapLibre worker on first use in development mode.
        // Keep the production failure bound strict while allowing that one-time
        // local compilation to finish on slower Windows machines.
        const sourceDeadline = performance.now() + (import.meta.env.DEV ? 45_000 : 10_000);
        const waitForSource = () => {
          if (map.getSource(SECTOR_SOURCE_ID)?.loaded?.()) {
            map.triggerRepaint();
            requestAnimationFrame(() => {
              performance.mark("heat-overlay-ready");
              performance.measure("heat-overlay-first-render", "heat-overlay-start", "heat-overlay-ready");
              resolve();
            });
          } else if (performance.now() >= sourceDeadline) {
            const error = new Error("overlay-timeout");
            error.code = "overlay-timeout";
            reject(error);
          } else {
            window.setTimeout(waitForSource, 16);
          }
        };
        waitForSource();
      } catch (error) {
        reject(error);
      }
    });
    map.once("error", (event) => {
      if (!map.loaded() && /webgl|context/i.test(event.error?.message ?? "")) reject(event.error);
    });
  });

  map.on("error", (event) => {
    if (!basemapErrorReported && /tile|raster|404|failed to fetch|network/i.test(event.error?.message ?? "")) {
      basemapErrorReported = true;
      onBasemapError?.(event.error);
    }
  });

  const viewportPadding = () => {
    const canvas = map.getCanvas();
    if (viewportPaddingOverride) {
      return clampViewportPadding(viewportPaddingOverride, canvas.clientWidth, canvas.clientHeight);
    }
    if (window.innerWidth > 760) {
      return clampViewportPadding(
        { top: 72, right: window.innerWidth >= 900 && selectedSectorId ? 430 : 28, bottom: 72, left: 28 },
        canvas.clientWidth,
        canvas.clientHeight,
      );
    }
    const canvasBounds = canvas.getBoundingClientRect();
    const controlsBounds = document.querySelector(".map-controls")?.getBoundingClientRect();
    const legendBounds = document.querySelector(".legend")?.getBoundingClientRect();
    const top = controlsBounds ? Math.max(24, controlsBounds.bottom - canvasBounds.top + 12) : 24;
    const bottom = legendBounds ? Math.max(62, canvasBounds.bottom - legendBounds.top + 12) : 62;
    const maximumTop = Math.max(24, canvasBounds.height - bottom - 120);
    return clampViewportPadding(
      { top: Math.min(top, maximumTop), right: 68, bottom, left: 20 },
      canvas.clientWidth,
      canvas.clientHeight,
    );
  };

  const fit = (bounds, options = {}) => {
    const coordinates = bounds.flat();
    if (coordinates.length !== 4 || coordinates.some((value) => !Number.isFinite(value))) return false;
    // Stop an earlier responsive camera transition before measuring the canvas.
    // This avoids overlapping fitBounds calculations while controls or the
    // result sheet are changing size.
    map.stop();
    map.resize();
    map.fitBounds(bounds, {
      padding: viewportPadding(),
      maxZoom: options.maxZoom ?? 15,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550,
      ...options,
    });
    return true;
  };

  const setLayerOption = (layerId, name, value) => {
    const layer = layers.get(layerId);
    if (!layer?.setOption?.(map, name, value)) return false;
    clearInspection();
    popup.remove();
    updateMapAccessibility();
    return true;
  };

  const setSharedLayersVisible = (visible) => {
    Object.values(COMMON_LAYER_IDS).forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    });
  };

  const guideLineGradient = (progress, color) => {
    if (progress <= 0) return "rgba(0,0,0,0)";
    if (progress >= 1) return color;
    return ["step", ["line-progress"], color, progress, "rgba(0,0,0,0)"];
  };

  return {
    map,
    ready,
    refreshInteractionCursor,
    openSourceDialog(triggerElement = null) { sourceDialog.open(triggerElement); },
    enterGuideMode(geography) {
      guideMode = true;
      clearInspection();
      popup.remove();
      layers.forEach((layer) => layer.setVisible(map, false));
      setSharedLayersVisible(false);
      if (map.getSource(GUIDE_SOURCE_ID)) return;
      map.addSource(GUIDE_SOURCE_ID, { type: "geojson", data: geography, lineMetrics: true });
      map.addLayer({
        id: GUIDE_LAYER_IDS.municipalityFill, type: "fill", source: GUIDE_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "municipality"], ["<", ["get", "revealIndex"], 0]],
        paint: { "fill-color": "#087d79", "fill-opacity": 0.2 },
      });
      map.addLayer({
        id: GUIDE_LAYER_IDS.municipalityCasing, type: "line", source: GUIDE_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "municipality"], ["<", ["get", "revealIndex"], 0]],
        paint: { "line-color": "rgba(3,28,35,0.96)", "line-width": 5.4 },
      });
      map.addLayer({
        id: GUIDE_LAYER_IDS.municipalityLine, type: "line", source: GUIDE_SOURCE_ID,
        filter: ["all", ["==", ["get", "kind"], "municipality"], ["<", ["get", "revealIndex"], 0]],
        paint: { "line-color": "rgba(247,255,254,0.99)", "line-width": 2.7 },
      });
      guideMarkers = geography.features
        .filter(({ properties }) => properties.kind === "municipality-label")
        .map((feature) => {
          const label = document.createElement("span");
          label.className = "guide-municipality-label";
          label.textContent = feature.properties.name;
          label.hidden = true;
          return {
            revealIndex: feature.properties.revealIndex,
            element: label,
            marker: new maplibregl.Marker({ element: label, anchor: "center" })
              .setLngLat(feature.geometry.coordinates).addTo(map),
          };
        });
      map.addLayer({
        id: GUIDE_LAYER_IDS.regionShadow, type: "line", source: GUIDE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "region-outline"],
        paint: { "line-width": 11, "line-gradient": guideLineGradient(0, "rgba(3,25,31,0.98)") },
      });
      map.addLayer({
        id: GUIDE_LAYER_IDS.regionCasing, type: "line", source: GUIDE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "region-outline"],
        paint: { "line-width": 7.2, "line-gradient": guideLineGradient(0, "rgba(255,255,255,0.99)") },
      });
      map.addLayer({
        id: GUIDE_LAYER_IDS.regionLine, type: "line", source: GUIDE_SOURCE_ID,
        filter: ["==", ["get", "kind"], "region-outline"],
        paint: { "line-width": 3.5, "line-gradient": guideLineGradient(0, "#19b8b1") },
      });
      const { clientWidth, clientHeight } = map.getCanvas();
      const spareWidth = Math.max(0, clientWidth - clientHeight * 1.12);
      const sidePadding = Math.max(44, spareWidth / 2);
      fit(fullBounds, {
        padding: { top: 44, right: sidePadding, bottom: 44, left: sidePadding },
        maxZoom: 11.7,
        duration: 0,
      });
    },
    setGuideRegionProgress(progress) {
      if (!guideMode) return;
      if (map.getLayer(GUIDE_LAYER_IDS.regionShadow)) {
        map.setPaintProperty(GUIDE_LAYER_IDS.regionShadow, "line-gradient", guideLineGradient(progress, "rgba(3,25,31,0.98)"));
        map.setPaintProperty(GUIDE_LAYER_IDS.regionCasing, "line-gradient", guideLineGradient(progress, "rgba(255,255,255,0.99)"));
        map.setPaintProperty(GUIDE_LAYER_IDS.regionLine, "line-gradient", guideLineGradient(progress, "#19b8b1"));
      }
    },
    setGuideMunicipalityCount(count) {
      [GUIDE_LAYER_IDS.municipalityFill, GUIDE_LAYER_IDS.municipalityCasing, GUIDE_LAYER_IDS.municipalityLine].forEach((layerId) => {
        if (map.getLayer(layerId)) map.setFilter(layerId, ["all", ["==", ["get", "kind"], "municipality"], ["<", ["get", "revealIndex"], count]]);
      });
      guideMarkers.forEach(({ revealIndex, element }) => { element.hidden = revealIndex >= count; });
    },
    setGuideGeographyVisible(visible) {
      Object.values(GUIDE_LAYER_IDS).forEach((layerId) => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      });
      guideMarkers.forEach(({ element }) => {
        element.style.display = visible ? "" : "none";
        element.style.opacity = visible ? "1" : "0";
      });
    },
    async showGuideRaster(url, { signal, fadeGeography = false } = {}) {
      const generation = ++guideRasterGeneration;
      const nextSlot = (guideRasterSlot + 1) % GUIDE_RASTER_IDS.length;
      const next = GUIDE_RASTER_IDS[nextSlot];
      const transitionMs = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900;
      if (map.getLayer(next.layer)) map.removeLayer(next.layer);
      if (map.getSource(next.source)) map.removeSource(next.source);
      map.addSource(next.source, { type: "raster", url: `pmtiles://${url}`, tileSize: 256 });
      map.addLayer({
        id: next.layer, type: "raster", source: next.source,
        paint: {
          "raster-opacity": 0,
          "raster-opacity-transition": { duration: transitionMs, delay: 0 },
          "raster-fade-duration": 0,
          "raster-resampling": "nearest",
        },
      }, map.getLayer(GUIDE_LAYER_IDS.municipalityFill) ? GUIDE_LAYER_IDS.municipalityFill : COMMON_LAYER_IDS.hit);
      const probe = fetch(url, { cache: "no-store", headers: { Range: "bytes=0-0" }, signal });
      const loaded = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => finish(new Error("Guide raster readiness timed out.")), import.meta.env.DEV ? 45_000 : 15_000);
        const onSourceData = (event) => {
          if (event.sourceId === next.source && (event.tile || event.isSourceLoaded || map.isSourceLoaded(next.source))) finish();
        };
        const onError = (event) => { if (event.sourceId === next.source) finish(event.error ?? new Error("Guide raster failed.")); };
        const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
        function finish(error = null) {
          window.clearTimeout(timeout);
          map.off("sourcedata", onSourceData);
          map.off("error", onError);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        }
        map.on("sourcedata", onSourceData);
        map.on("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const [response] = await Promise.all([probe, loaded]);
        if (![200, 206].includes(response.status)) throw new Error(`Guide raster HTTP ${response.status}.`);
        if (signal?.aborted || generation !== guideRasterGeneration || !guideMode) throw new DOMException("Aborted", "AbortError");

        const previous = guideRasterSlot >= 0 ? GUIDE_RASTER_IDS[guideRasterSlot] : null;
        if (previous && map.getLayer(previous.layer)) {
          map.setPaintProperty(previous.layer, "raster-opacity-transition", { duration: transitionMs, delay: 0 });
          map.setPaintProperty(previous.layer, "raster-opacity", 0);
        }
        map.setPaintProperty(next.layer, "raster-opacity", 0.8);

        if (fadeGeography) {
          const transitions = [
            [GUIDE_LAYER_IDS.municipalityFill, "fill-opacity", 0],
            [GUIDE_LAYER_IDS.municipalityCasing, "line-opacity", 0],
            [GUIDE_LAYER_IDS.municipalityLine, "line-opacity", 0],
            [GUIDE_LAYER_IDS.regionShadow, "line-opacity", 0],
            [GUIDE_LAYER_IDS.regionCasing, "line-opacity", 0],
            [GUIDE_LAYER_IDS.regionLine, "line-opacity", 0],
          ];
          transitions.forEach(([layerId, property, value]) => {
            if (!map.getLayer(layerId)) return;
            map.setPaintProperty(layerId, `${property}-transition`, { duration: transitionMs, delay: 0 });
            map.setPaintProperty(layerId, property, value);
          });
          guideMarkers.forEach(({ element }) => {
            element.style.transitionDuration = `${transitionMs}ms`;
            element.style.opacity = "0";
          });
        }

        map.triggerRepaint();
        await abortableDelay(transitionMs, signal);
        if (signal?.aborted || generation !== guideRasterGeneration || !guideMode) throw new DOMException("Aborted", "AbortError");

        if (fadeGeography) {
          Object.values(GUIDE_LAYER_IDS).forEach((layerId) => {
            if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
          });
          guideMarkers.forEach(({ element }) => { element.style.display = "none"; });
        }
        if (previous) {
          if (map.getLayer(previous.layer)) map.removeLayer(previous.layer);
          if (map.getSource(previous.source)) map.removeSource(previous.source);
        }
        guideRasterSlot = nextSlot;
        map.triggerRepaint();
        return true;
      } catch (error) {
        if (map.getLayer(next.layer)) map.removeLayer(next.layer);
        if (map.getSource(next.source)) map.removeSource(next.source);
        throw error;
      }
    },
    exitGuideMode() {
      guideMode = false;
      guideRasterGeneration += 1;
      GUIDE_RASTER_IDS.forEach(({ layer, source }) => {
        if (map.getLayer(layer)) map.removeLayer(layer);
        if (map.getSource(source)) map.removeSource(source);
      });
      guideRasterSlot = -1;
      Object.values(GUIDE_LAYER_IDS).reverse().forEach((layerId) => {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      });
      if (map.getSource(GUIDE_SOURCE_ID)) map.removeSource(GUIDE_SOURCE_ID);
      guideMarkers.forEach(({ marker }) => marker.remove());
      guideMarkers = [];
      setSharedLayersVisible(true);
      currentLayer()?.setVisible(map, true);
      applyLayerFilter();
      fit(fullBounds, { maxZoom: 12, duration: 0 });
    },
    setMunicipality(municipality) {
      activeMunicipality = municipality;
      applyLayerFilter();
      fit(collectionBounds(geojson, municipality), { maxZoom: municipality ? 13.5 : 12 });
    },
    setSelected(sectorId, { focus = false } = {}) {
      selectedSectorId = sectorId ?? "";
      map.setFilter(COMMON_LAYER_IDS.selected, ["==", ["get", "sectorId"], selectedSectorId]);
      if (focus && featureById.has(selectedSectorId)) {
        const bounds = geometryBounds(featureById.get(selectedSectorId).geometry);
        const [southwest, northeast] = bounds.map((coordinate) => map.project(coordinate));
        const canvas = map.getCanvas();
        const padding = viewportPadding();
        const fullyVisible = Math.min(southwest.x, northeast.x) >= padding.left
          && Math.max(southwest.x, northeast.x) <= canvas.clientWidth - padding.right
          && Math.min(southwest.y, northeast.y) >= padding.top
          && Math.max(southwest.y, northeast.y) <= canvas.clientHeight - padding.bottom;
        if (!fullyVisible) fit(bounds, { maxZoom: 15.5 });
      }
    },
    setExternalHover(sectorId = "") {
      if (hoveredId && hoveredId !== sectorId) {
        map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
      }
      hoveredId = sectorId || null;
      if (hoveredId) map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: true });
    },
    setPopupModelProvider(provider = null) {
      popupModelProvider = typeof provider === "function" ? provider : null;
      popup.remove();
    },
    setPointInspectionProvider(provider = null) {
      clearInspection();
      pointInspectionProvider = provider?.inspectPoint && provider?.getPointPopupModel ? provider : null;
      popup.remove();
    },
    async ensureLayer(layerId) {
      const layer = layers.get(layerId);
      if (!layer || !await layer.mount(map, {
        sectorSourceId: SECTOR_SOURCE_ID,
        beforeLayerId: COMMON_LAYER_IDS.hit,
      })) return false;
      layer.applyFilter(map, activeFilter(), { municipality: activeMunicipality });
      return true;
    },
    resetView() {
      fit(collectionBounds(geojson, activeMunicipality), { maxZoom: activeMunicipality ? 13.5 : 12 });
    },
    refreshLayout() {
      map.resize();
    },
    setViewportPadding(padding) {
      if (!padding || ["top", "right", "bottom", "left"].some((key) => !Number.isFinite(padding[key]))) {
        viewportPaddingOverride = null;
        return;
      }
      viewportPaddingOverride = { ...padding };
    },
    async setLayer(layerId) {
      const requestedLayer = layers.get(layerId);
      if (!requestedLayer?.isAvailable()) return false;
      // Lazy source creation may overlap with a camera transition requested by
      // the preceding UI action. A layer change is never navigation, so stop
      // that transition and restore the complete camera after mounting.
      const camera = {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        padding: map.getPadding(),
      };
      map.stop();
      try {
        if (!await requestedLayer.mount(map, {
          sectorSourceId: SECTOR_SOURCE_ID,
          beforeLayerId: COMMON_LAYER_IDS.hit,
        })) return false;
      } catch (error) {
        onLayerError?.(layerId, error);
        return false;
      }
      activeLayerId = layerId;
      clearInspection();
      popup.remove();
      layers.forEach((layer) => layer.setVisible(map, layer.id === activeLayerId));
      applyLayerFilter();
      updateMapAccessibility();
      refreshInteractionCursor();
      map.jumpTo(camera);
      return true;
    },
    getActiveLayer() { return activeLayerId; },
    getCamera() {
      return {
        center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(),
        pitch: map.getPitch(), padding: map.getPadding(),
      };
    },
    restoreCamera(camera) { if (camera) map.jumpTo(camera); },
    setLayerOption,
    getLayerOption(layerId, name) { return layers.get(layerId)?.getOption?.(name) ?? null; },
    // Kept as a compatibility convenience for existing diagnostics and tests.
    setHeatMetric(metric) { return setLayerOption("heat", "metric", metric); },
    getHeatMetric() { return layers.get("heat")?.getOption?.("metric") ?? null; },
    setLanguage() {
      clearInspection();
      popup.remove();
      updateMapAccessibility();
    },
    destroy() {
      clearInspection();
      sourceDialog.destroy();
      popup.remove();
      map.remove();
    },
  };
}
