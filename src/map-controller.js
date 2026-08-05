import * as maplibregl from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { collectionBounds, geometryBounds } from "./data.js";
import {
  DEFAULT_HEAT_METRIC,
  HEAT_METRICS,
  heatMetricColorExpression,
  heatMetricStatus,
  heatMetricValue,
} from "./heat-metric.js";
import { formatNumber, formatScore, t } from "./i18n.js";

maplibregl.setWorkerUrl(mapLibreWorkerUrl);

const LAYER_IDS = Object.freeze({
  fill: "heat-sectors-fill",
  landCover: "land-cover-raster",
  urbanAtlas: "urban-atlas-fill",
  hit: "heat-sectors-hit-area",
  outline: "heat-sectors-outline",
  selected: "heat-sector-selected",
});

function classDefinition(landCover, code) {
  return landCover?.classes?.find((entry) => entry.code === code);
}

function urbanAtlasDefinition(urbanAtlas, code) {
  return urbanAtlas?.classes?.find((entry) => String(entry.code) === String(code));
}

function derivativeAttribution(landCover, urbanAtlas) {
  if (!landCover?.raster?.available && !urbanAtlas?.available) return undefined;
  const parts = [
    '<a href="https://land.copernicus.eu/en/data-policy" target="_blank" rel="noreferrer">Generated using European Union\'s Copernicus Land Monitoring Service information</a>',
  ];
  if (landCover?.source?.doi) {
    parts.push(`<a href="${landCover.source.doi}" target="_blank" rel="noreferrer">DOI</a>`);
  }
  if (urbanAtlas?.source?.doi) {
    parts.push(`<a href="${urbanAtlas.source.doi}" target="_blank" rel="noreferrer">Urban Atlas DOI</a>`);
  }
  return parts.join(" · ");
}

function popupContent(feature, scoreRecord, landCover, urbanAtlas, activeLayer, activeHeatMetric) {
  const wrapper = document.createElement("div");
  wrapper.className = "sector-tooltip";
  const title = document.createElement("strong");
  title.textContent = feature.properties.sectorName;
  const location = document.createElement("span");
  location.textContent = feature.properties.municipality;
  const score = document.createElement("b");
  if (activeLayer === "land-cover") {
    const stats = landCover?.sectorStats?.[feature.properties.sectorId];
    const dominant = classDefinition(landCover, stats?.dominantClassCode);
    score.textContent = dominant
      ? `${t(`class.${dominant.key}`)} · ${t("landCover.vegetation")}: ${t("unit.percentage", { value: formatNumber(stats.vegetationPercentage) })}`
      : t("landCover.noData");
  } else if (activeLayer === "urban-atlas") {
    const stats = urbanAtlas?.sectorStats?.[feature.properties.sectorId];
    score.textContent = stats
      ? `${t("urbanAtlas.greenCoverage")}: ${t("unit.percentage", { value: formatNumber(stats.green.percentage) })} · ${t("urbanAtlas.artificialisation")}: ${t("unit.percentage", { value: formatNumber(stats.artificial.percentage) })}`
      : t("urbanAtlas.noData");
  } else {
    const metricStatus = heatMetricStatus(scoreRecord, activeHeatMetric);
    score.textContent = metricStatus === "scored"
      ? t("popup.metricScore", {
        metric: t(`heatMetric.${activeHeatMetric}`),
        score: formatScore(heatMetricValue(scoreRecord, activeHeatMetric)),
      })
      : metricStatus === "institution-present-no-score"
        ? t("popup.institution")
        : t("popup.metricNoScore", { metric: t(`heatMetric.${activeHeatMetric}`) });
  }
  wrapper.append(title, location, score);
  return wrapper;
}

export function createMapController({ container, geojson, scores, methodology, landCover, urbanAtlas, config, onSectorSelect, onBasemapError, onUrbanAtlasError }) {
  const fullBounds = collectionBounds(geojson);
  const featureById = new Map(geojson.features.map((feature) => [feature.properties.sectorId, feature]));
  let activeMunicipality = "";
  let activeLayer = "heat";
  let activeHeatMetric = DEFAULT_HEAT_METRIC;
  let selectedSectorId = "";
  let urbanAtlasLoadPromise = null;
  let basemapErrorReported = false;
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: "260px" });
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
    customAttribution: derivativeAttribution(landCover, urbanAtlas),
  }), "bottom-right");

  const activeLayerLabel = () => {
    if (activeLayer === "land-cover") return t("layers.landCover", { year: landCover?.activeYear ?? 2020 });
    if (activeLayer === "urban-atlas") return t("layers.urbanAtlas", { year: urbanAtlas?.activeYear ?? 2021 });
    if (activeHeatMetric === DEFAULT_HEAT_METRIC) return t("layers.heat");
    return t("layers.heatWithMetric", { metric: t(`heatMetric.${activeHeatMetric}`) });
  };

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
    canvas.setAttribute("aria-label", t("map.regionForLayer", { layer: activeLayerLabel() }));
    canvas.setAttribute("title", t("maplibre.mapTitle"));
  };
  updateMapAccessibility();

  const ready = new Promise((resolve, reject) => {
    map.once("load", () => {
      let sourceReady = false;
      const finishReady = () => {
        if (sourceReady) return;
        sourceReady = true;
        performance.mark("heat-overlay-ready");
        performance.measure("heat-overlay-first-render", "heat-overlay-start", "heat-overlay-ready");
        resolve();
      };
      performance.mark("heat-overlay-start");
      map.addSource("heat-sectors", { type: "geojson", data: geojson, promoteId: "sectorId" });
      map.addLayer({
        id: LAYER_IDS.fill,
        type: "fill",
        source: "heat-sectors",
        paint: {
          "fill-color": heatMetricColorExpression(scores, activeHeatMetric, methodology.palette),
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.82, 0.68],
        },
      });
      map.addLayer({
        id: LAYER_IDS.outline,
        type: "line",
        source: "heat-sectors",
        paint: { "line-color": "rgba(255,255,255,0.92)", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.55, 14, 1.2] },
      });
      map.addLayer({
        id: LAYER_IDS.hit,
        type: "fill",
        source: "heat-sectors",
        paint: {
          "fill-color": "#ffffff",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.12, 0],
        },
      }, LAYER_IDS.outline);
      map.addLayer({
        id: LAYER_IDS.selected,
        type: "line",
        source: "heat-sectors",
        filter: ["==", ["get", "sectorId"], ""],
        paint: { "line-color": "#0B2F3A", "line-width": 4, "line-blur": 0.25 },
      });

      let hoveredId = null;
      map.on("mousemove", LAYER_IDS.hit, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        map.getCanvas().style.cursor = "pointer";
        if (hoveredId && hoveredId !== feature.id) map.setFeatureState({ source: "heat-sectors", id: hoveredId }, { hover: false });
        hoveredId = feature.id;
        map.setFeatureState({ source: "heat-sectors", id: hoveredId }, { hover: true });
        popup.setLngLat(event.lngLat).setDOMContent(popupContent(
          feature,
          scores[feature.properties.sectorId],
          landCover,
          urbanAtlas,
          activeLayer,
          activeHeatMetric,
        )).addTo(map);
      });
      map.on("mouseleave", LAYER_IDS.hit, () => {
        map.getCanvas().style.cursor = "";
        if (hoveredId) map.setFeatureState({ source: "heat-sectors", id: hoveredId }, { hover: false });
        hoveredId = null;
        popup.remove();
      });
      map.on("click", LAYER_IDS.hit, (event) => {
        const feature = event.features?.[0];
        if (feature) onSectorSelect(feature.properties.sectorId, { source: "map" });
      });
      const sourceDeadline = performance.now() + 10_000;
      const waitForSource = () => {
        if (map.getSource("heat-sectors")?.loaded?.()) {
          map.triggerRepaint();
          requestAnimationFrame(finishReady);
        } else if (performance.now() >= sourceDeadline) {
          const error = new Error("overlay-timeout");
          error.code = "overlay-timeout";
          reject(error);
        } else {
          window.setTimeout(waitForSource, 16);
        }
      };
      waitForSource();
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

  const applyLayerFilter = () => {
    const filter = activeMunicipality ? ["==", ["get", "municipality"], activeMunicipality] : null;
    map.setFilter(LAYER_IDS.fill, filter);
    map.setFilter(LAYER_IDS.hit, filter);
    map.setFilter(LAYER_IDS.outline, filter);
    if (map.getLayer(LAYER_IDS.urbanAtlas)) map.setFilter(LAYER_IDS.urbanAtlas, filter);
  };

  const ensureRasterLayer = (layerId, sourceId, raster) => {
    if (map.getLayer(layerId)) return;
    map.addSource(sourceId, {
      type: "image",
      url: raster.imageUrl,
      coordinates: raster.coordinates,
    });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      layout: { visibility: "none" },
      paint: {
        "raster-opacity": landCover.opacity ?? 0.68,
        "raster-resampling": "nearest",
      },
    }, LAYER_IDS.hit);
  };

  const setLayerVisibility = (layerId, visible) => {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  };

  const ensureUrbanAtlasLayer = async () => {
    if (map.getLayer(LAYER_IDS.urbanAtlas)) return true;
    if (urbanAtlasLoadPromise) return urbanAtlasLoadPromise;
    if (!urbanAtlas?.available || !urbanAtlas.geojsonUrl) return false;
    urbanAtlasLoadPromise = (async () => {
      performance.clearMarks("urban-atlas-load-start");
      performance.clearMarks("urban-atlas-load-ready");
      performance.mark("urban-atlas-load-start");
      const response = await fetch(urbanAtlas.geojsonUrl);
      if (!response.ok) throw new Error(`urban-atlas.geojson: HTTP ${response.status}`);
      const data = await response.json();
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
        throw new Error("urban-atlas.geojson bevat geen geldige FeatureCollection.");
      }
      if (data.features.some((feature) => feature.geometry?.type !== "MultiPolygon"
        || !feature.properties?.sectorId || !feature.properties?.classCode)) {
        throw new Error("urban-atlas.geojson bevat een ongeldig sectorfragment.");
      }
      const matchColors = urbanAtlas.classes.flatMap((entry) => [String(entry.code), entry.color]);
      map.addSource("urban-atlas", { type: "geojson", data });
      map.addLayer({
        id: LAYER_IDS.urbanAtlas,
        type: "fill",
        source: "urban-atlas",
        layout: { visibility: "none" },
        paint: {
          "fill-color": ["match", ["to-string", ["get", "classCode"]], ...matchColors, "#000000"],
          "fill-opacity": urbanAtlas.opacity ?? 0.68,
        },
      }, LAYER_IDS.hit);
      applyLayerFilter();
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        const poll = () => {
          if (map.getSource("urban-atlas")?.loaded?.()) return requestAnimationFrame(resolve);
          if (performance.now() >= deadline) return reject(new Error("Urban Atlas-overlay kon niet tijdig worden gerenderd."));
          window.setTimeout(poll, 16);
        };
        poll();
      });
      performance.mark("urban-atlas-load-ready");
      performance.measure("urban-atlas-first-render", "urban-atlas-load-start", "urban-atlas-load-ready");
      return true;
    })().catch((error) => {
      if (map.getLayer(LAYER_IDS.urbanAtlas)) map.removeLayer(LAYER_IDS.urbanAtlas);
      if (map.getSource("urban-atlas")) map.removeSource("urban-atlas");
      urbanAtlasLoadPromise = null;
      onUrbanAtlasError?.(error);
      return false;
    });
    return urbanAtlasLoadPromise;
  };

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
      map.setFilter(LAYER_IDS.selected, ["==", ["get", "sectorId"], selectedSectorId]);
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
    async setLayer(layerId) {
      if (layerId === "land-cover") {
        if (!landCover?.raster?.available) return false;
        ensureRasterLayer(LAYER_IDS.landCover, "land-cover-image", landCover.raster);
      }
      if (layerId === "urban-atlas" && !await ensureUrbanAtlasLayer()) return false;
      activeLayer = layerId;
      popup.remove();
      updateMapAccessibility();
      setLayerVisibility(LAYER_IDS.fill, layerId === "heat");
      setLayerVisibility(LAYER_IDS.landCover, layerId === "land-cover");
      setLayerVisibility(LAYER_IDS.urbanAtlas, layerId === "urban-atlas");
      return true;
    },
    getActiveLayer() { return activeLayer; },
    setHeatMetric(metric) {
      if (!HEAT_METRICS.includes(metric)) return false;
      activeHeatMetric = metric;
      popup.remove();
      if (map.getLayer(LAYER_IDS.fill)) {
        map.setPaintProperty(
          LAYER_IDS.fill,
          "fill-color",
          heatMetricColorExpression(scores, activeHeatMetric, methodology.palette),
        );
      }
      updateMapAccessibility();
      return true;
    },
    getHeatMetric() { return activeHeatMetric; },
    setLanguage() {
      popup.remove();
      updateMapAccessibility();
    },
    destroy() { popup.remove(); map.remove(); },
  };
}
