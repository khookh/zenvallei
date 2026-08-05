import * as maplibregl from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { collectionBounds, geometryBounds } from "./data.js";
import { t } from "./i18n.js";

maplibregl.setWorkerUrl(mapLibreWorkerUrl);

// These IDs are intentionally stable because browser diagnostics and saved
// tests use them to query rendered sector geometry.
const SECTOR_SOURCE_ID = "heat-sectors";
const COMMON_LAYER_IDS = Object.freeze({
  hit: "heat-sectors-hit-area",
  outline: "heat-sectors-outline",
  selected: "heat-sector-selected",
});

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
  let selectedSectorId = "";
  let basemapErrorReported = false;
  let hoveredId = null;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "260px" });

  const attributions = [...new Set(
    [...layers.values()].flatMap((layer) => layer.getAttributions?.() ?? []),
  )];
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

  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "bottom-right");
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: attributions.length ? attributions.join(" · ") : undefined,
  }), "bottom-right");

  const attributionDisclosure = container.querySelector(".maplibregl-ctrl-attrib");
  const attributionButton = container.querySelector(".maplibregl-ctrl-attrib-button");
  const syncAttributionState = () => attributionButton?.setAttribute(
    "aria-expanded",
    String(attributionDisclosure?.classList.contains("maplibregl-compact-show") ?? false),
  );
  // MapLibre deliberately opens compact attribution on first render. Greenwave
  // keeps the complete source list available, but starts with the compact
  // information button so the map is not obscured.
  attributionDisclosure?.removeAttribute("open");
  attributionDisclosure?.classList.remove("maplibregl-compact-show");
  syncAttributionState();
  const attributionObserver = new MutationObserver(syncAttributionState);
  if (attributionDisclosure) {
    attributionObserver.observe(attributionDisclosure, {
      attributes: true,
      attributeFilter: ["class", "open"],
    });
  }

  const currentLayer = () => layers.get(activeLayerId);

  const updateMapAccessibility = () => {
    const translatedControls = [
      [container.querySelector(".maplibregl-ctrl-zoom-in"), "maplibre.zoomIn"],
      [container.querySelector(".maplibregl-ctrl-zoom-out"), "maplibre.zoomOut"],
      [container.querySelector(".maplibregl-ctrl-attrib-button"), "maplibre.toggleAttribution"],
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
  };
  updateMapAccessibility();

  const activeFilter = () => activeMunicipality
    ? ["==", ["get", "municipality"], activeMunicipality]
    : null;

  const applyLayerFilter = () => {
    const filter = activeFilter();
    [COMMON_LAYER_IDS.hit, COMMON_LAYER_IDS.outline].forEach((layerId) => {
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
        }, COMMON_LAYER_IDS.outline);
        map.addLayer({
          id: COMMON_LAYER_IDS.selected,
          type: "line",
          source: SECTOR_SOURCE_ID,
          filter: ["==", ["get", "sectorId"], ""],
          paint: { "line-color": "#0B2F3A", "line-width": 4, "line-blur": 0.25 },
        });

        map.on("mousemove", COMMON_LAYER_IDS.hit, (event) => {
          const feature = event.features?.[0];
          if (!feature) return;
          map.getCanvas().style.cursor = "pointer";
          if (hoveredId && hoveredId !== feature.id) {
            map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
          }
          hoveredId = feature.id;
          map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: true });
          const record = scores[feature.properties.sectorId];
          const model = currentLayer().getPopupModel(feature, record);
          popup.setLngLat(event.lngLat).setDOMContent(renderPopup(model)).addTo(map);
        });
        map.on("mouseleave", COMMON_LAYER_IDS.hit, () => {
          map.getCanvas().style.cursor = "";
          if (hoveredId) map.setFeatureState({ source: SECTOR_SOURCE_ID, id: hoveredId }, { hover: false });
          hoveredId = null;
          popup.remove();
        });
        map.on("click", COMMON_LAYER_IDS.hit, (event) => {
          const feature = event.features?.[0];
          if (feature) onSectorSelect(feature.properties.sectorId, { source: "map" });
        });

        const sourceDeadline = performance.now() + 10_000;
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
    if (window.innerWidth > 760) {
      return { top: 72, right: window.innerWidth >= 900 && selectedSectorId ? 430 : 28, bottom: 72, left: 28 };
    }
    const canvasBounds = map.getCanvas().getBoundingClientRect();
    const controlsBounds = document.querySelector(".map-controls")?.getBoundingClientRect();
    const legendBounds = document.querySelector(".legend")?.getBoundingClientRect();
    const top = controlsBounds ? Math.max(24, controlsBounds.bottom - canvasBounds.top + 12) : 24;
    const bottom = legendBounds ? Math.max(62, canvasBounds.bottom - legendBounds.top + 12) : 62;
    const maximumTop = Math.max(24, canvasBounds.height - bottom - 120);
    return { top: Math.min(top, maximumTop), right: 68, bottom, left: 20 };
  };

  const fit = (bounds, options = {}) => {
    map.fitBounds(bounds, {
      padding: viewportPadding(),
      maxZoom: options.maxZoom ?? 15,
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 550,
      ...options,
    });
  };

  const setLayerOption = (layerId, name, value) => {
    const layer = layers.get(layerId);
    if (!layer?.setOption?.(map, name, value)) return false;
    popup.remove();
    updateMapAccessibility();
    return true;
  };

  return {
    map,
    ready,
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
        const panelSpace = window.innerWidth >= 900 ? 430 : 0;
        const fullyVisible = Math.min(southwest.x, northeast.x) >= 28
          && Math.max(southwest.x, northeast.x) <= canvas.clientWidth - panelSpace - 28
          && Math.min(southwest.y, northeast.y) >= 72
          && Math.max(southwest.y, northeast.y) <= canvas.clientHeight - 72;
        if (!fullyVisible) fit(bounds, { maxZoom: 15.5 });
      }
    },
    resetView() {
      fit(collectionBounds(geojson, activeMunicipality), { maxZoom: activeMunicipality ? 13.5 : 12 });
    },
    refreshLayout() {
      map.resize();
    },
    async setLayer(layerId) {
      const requestedLayer = layers.get(layerId);
      if (!requestedLayer?.isAvailable()) return false;
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
      popup.remove();
      layers.forEach((layer) => layer.setVisible(map, layer.id === activeLayerId));
      applyLayerFilter();
      updateMapAccessibility();
      return true;
    },
    getActiveLayer() { return activeLayerId; },
    setLayerOption,
    getLayerOption(layerId, name) { return layers.get(layerId)?.getOption?.(name) ?? null; },
    // Kept as a compatibility convenience for existing diagnostics and tests.
    setHeatMetric(metric) { return setLayerOption("heat", "metric", metric); },
    getHeatMetric() { return layers.get("heat")?.getOption?.("metric") ?? null; },
    setLanguage() {
      popup.remove();
      updateMapAccessibility();
    },
    destroy() {
      attributionObserver.disconnect();
      popup.remove();
      map.remove();
    },
  };
}
