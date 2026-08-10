import { formatNumber, t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems, thermalColor } from "./thermal-palette.js";
import {
  comparisonPixelOffset, greenClassSelector, loadImageData, safeAsset, SEALED_URBAN_SOURCE_URLS,
} from "./sealed-urban-shared.js";

const SOURCE_ID = "landsat-groenkaart-canvas";
const RASTER_LAYER_ID = "landsat-groenkaart-temperature";
const BEFORE_LAYER = "heat-sectors-hit-area";

export function validateLandsatGroenkaartManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "landsat-groenkaart"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "groenkaart"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.analysisResolutionMeters !== 30 || manifest.minimumGreenCoverage !== 0.8
    || !manifest.observations || !Array.isArray(manifest.greenClasses) || !manifest.densityNonGreenUrl
    || !manifest.scopeIndexUrl || !manifest.municipalityIndexes) {
    throw new TypeError("Unsupported Landsat-Green Map comparison manifest.");
  }
  return manifest;
}

const scopeId = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}`
    : `sector:${record.sectorId}`;

export function createLandsatGroenkaartComparison({ descriptor, landsatLayer, groenkaartLayer }) {
  let manifest;
  let densityData;
  let densityNonGreenData;
  let scopeData;
  let pointData;
  let statistics;
  let loadedObservation = "";
  let map;
  let canvas;
  let context;
  let active = false;
  let municipality = "";
  let previousYear = 2021;
  let selectedGreen = new Set([1, 2]);
  let generation = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const observationId = () => landsatLayer.getOption("observation");
  const observation = () => landsatLayer.getRuntimeData()?.observation;
  let sectorIdByIndex = new Map();

  const ensureManifest = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateLandsatGroenkaartManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.densityNonGreenUrl = safeAsset(descriptor.assetRoot, manifest.densityNonGreenUrl, ".png");
    manifest.scopeIndexUrl = safeAsset(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    Object.values(manifest.observations).forEach((item) => {
      item.pointDataUrl = safeAsset(descriptor.assetRoot, item.pointDataUrl, ".png");
      item.statisticsUrl = safeAsset(descriptor.assetRoot, item.statisticsUrl, ".json");
    });
    [densityData, densityNonGreenData, scopeData] = await Promise.all([
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
      loadImageData(manifest.scopeIndexUrl, manifest.imageSize),
    ]);
    selectedGreen = new Set(manifest.defaultGreenClasses);
    sectorIdByIndex = new Map(Object.entries(manifest.sectorIndexes).map(([id, index]) => [Number(index), id]));
  };

  const loadObservation = async () => {
    await ensureManifest();
    const id = observationId();
    if (loadedObservation === id) return;
    const item = manifest.observations[id];
    const [pixels, statsResponse] = await Promise.all([
      loadImageData(item.pointDataUrl, manifest.imageSize), fetch(item.statisticsUrl),
    ]);
    if (!statsResponse.ok) throw new Error(`Comparison statistics HTTP ${statsResponse.status}.`);
    pointData = pixels;
    statistics = await statsResponse.json();
    loadedObservation = id;
  };

  const allowedIndex = (index, record = null) => {
    const sectorId = sectorIdByIndex.get(index);
    if (!sectorId) return false;
    if (record?.scope === "sector") return sectorId === record.sectorId;
    const selectedMunicipality = record?.scope === "municipality" ? record.municipality : municipality;
    return !selectedMunicipality || manifest.sectorMunicipalities[sectorId] === selectedMunicipality;
  };

  const densityAt = (offset) => {
    let value = 0;
    selectedGreen.forEach((code) => {
      value += (code === 4 ? densityNonGreenData.data[offset] : densityData.data[offset + code - 1]) / 2.55;
    });
    return Math.max(0, Math.min(100, value));
  };

  const temperatureAt = (offset) => {
    const code = pointData.data[offset] * 256 + pointData.data[offset + 1];
    return code ? code / 100 - 100 : null;
  };

  const render = () => {
    if (!active || !context || !pointData) return;
    const output = context.createImageData(canvas.width, canvas.height);
    const municipalityIndex = municipality ? manifest.municipalityIndexes[municipality] : 0;
    for (let offset = 0, pixel = 0; offset < pointData.data.length; offset += 4, pixel += 1) {
      const status = pointData.data[offset + 3];
      const inScope = municipalityIndex ? scopeData.data[offset + 1] === municipalityIndex : scopeData.data[offset] === 1;
      if (!status || !inScope) continue;
      if (status === 255) {
        const temperature = temperatureAt(offset);
        const normalized = Math.round(Math.max(0, Math.min(1, (temperature - 15) / 35)) * 255);
        const color = thermalColor(normalized);
        output.data[offset] = color[0];
        output.data[offset + 1] = color[1];
        output.data[offset + 2] = color[2];
        output.data[offset + 3] = 230;
      } else if (status === 254) {
        const light = (pixel % canvas.width + Math.floor(pixel / canvas.width)) % 2;
        output.data[offset] = light ? 194 : 126;
        output.data[offset + 1] = light ? 201 : 135;
        output.data[offset + 2] = light ? 203 : 139;
        output.data[offset + 3] = 225;
      }
    }
    context.putImageData(output, 0, 0);
    const source = map.getSource(SOURCE_ID);
    source?.setCoordinates(manifest.coordinates);
    source?.play?.();
    map.triggerRepaint();
    requestAnimationFrame(() => source?.pause?.());
  };

  const pixelPoints = (record) => {
    const output = [];
    for (let offset = 0; offset < pointData.data.length; offset += 4) {
      if (pointData.data[offset + 3] !== 255 || !allowedIndex(pointData.data[offset + 2], record)) continue;
      output.push([densityAt(offset), temperatureAt(offset)]);
    }
    return output;
  };

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return;
    render();
    notify();
  };

  return {
    id: "landsat-groenkaart",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "groenkaart",
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
      previousYear = Number(groenkaartLayer.getOption("year") ?? 2021);
      groenkaartLayer.setOption(map, "year", 2021);
      groenkaartLayer.setVisible(map, false);
      landsatLayer.setVisible(map, false);
      if (!map.getSource(SOURCE_ID)) {
        canvas = document.createElement("canvas");
        canvas.width = manifest.imageSize[0];
        canvas.height = manifest.imageSize[1];
        canvas.className = "comparison-render-canvas";
        canvas.setAttribute("aria-hidden", "true");
        document.body.append(canvas);
        context = canvas.getContext("2d", { alpha: true });
        map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
        map.addLayer({ id: RASTER_LAYER_ID, type: "raster", source: SOURCE_ID,
          paint: { "raster-opacity": .9, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, BEFORE_LAYER);
      }
      active = true;
      await refresh();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      if (map?.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map?.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      context = null;
      groenkaartLayer.setOption(map, "year", previousYear);
      groenkaartLayer.setVisible(map, false);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
    setMunicipality(value = "") { municipality = value; if (active) { render(); notify(); } return true; },
    toggleGreenClass(code) {
      const value = Number(code);
      if (selectedGreen.has(value)) {
        if (selectedGreen.size === 1) return { changed: false, minimum: true };
        selectedGreen.delete(value);
      } else selectedGreen.add(value);
      render();
      notify();
      return { changed: true };
    },
    getLabel: () => t("landsatGreen.title"),
    getActiveNote: () => t("landsatGreen.activeNote"),
    getContext: () => ({
      meta: t("landsatGreen.contextMeta"), text: t("landsatGreen.contextText"), note: t("landsatGreen.contextNote"),
      sources: [
        authorityLink("landsat", SEALED_URBAN_SOURCE_URLS.landsat),
        authorityLink("natureForests", SEALED_URBAN_SOURCE_URLS.greenMap),
        authorityLink("departmentEnvironment", SEALED_URBAN_SOURCE_URLS.jaarbak),
        authorityLink("copernicusClms", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
      ],
    }),
    getLegendModel: () => ({
      title: t("landsatGreen.legendTitle"), layout: "scale", groups: [{ items: comparisonLegendItems() }],
      gradient: comparisonHeatGradient(), observation: observation(),
      densitySelector: greenClassSelector(manifest, selectedGreen),
      note: t("landsatGreen.legendNote"),
    }),
    getPopupModel(_feature, record) {
      const stats = statistics?.sectorStats?.[record.sectorId];
      const density = [...selectedGreen].reduce((sum, code) => sum + Number(stats?.meanDensityByGreenClass?.[code] ?? 0), 0);
      return { title: record.sectorName, subtitle: t("landsatGreen.popupSubtitle"), lines: stats?.clearPixelCount
        ? [t("landsatGreen.popupValues", { density: formatNumber(density, 1), temperature: formatNumber(stats.meanTemperatureC, 1) })]
        : [t("sealedUrban.noComparableValue")] };
    },
    inspectPoint(point) {
      const offset = comparisonPixelOffset(manifest, point);
      if (offset < 0 || pointData?.data[offset + 3] !== 255 || !allowedIndex(pointData.data[offset + 2])) {
        return { unavailable: true };
      }
      return { density: densityAt(offset), temperature: temperatureAt(offset), acquiredAt: observation()?.acquiredAt };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("landsatGreen.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("landsatGreen.popupSubtitle"),
        subtitle: landsatLayer.getPointPopupModel?.({ acquiredAt: result.acquiredAt, status: "clear", temperatureC: result.temperature })?.subtitle,
        lines: [t("landsatGreen.popupValues", {
          density: formatNumber(result.density, 1), temperature: formatNumber(result.temperature, 1),
        })],
      };
    },
    getPanelModel(record) {
      const key = [...selectedGreen].sort((a, b) => a - b).join("+");
      const selector = greenClassSelector(manifest, selectedGreen);
      return {
        template: "sealed-urban-scatter", comparisonId: "landsat-groenkaart", record,
        title: t("landsatGreen.chartTitle"), definition: t("landsatGreen.definition"),
        xLabel: t("sealedUrban.axisPixelGreenDensity"), yLabel: t("sealedUrban.axisTemperature"),
        xKey: "density", yKey: "temperature", pixelPoints: pixelPoints(record),
        regression: statistics?.regressions?.[scopeId(record)]?.[key] ?? null,
        slopeScale: 10, slopeUnit: t("landsatGreen.slopeUnit"), observation: observation(),
        selectedClasses: [...selectedGreen],
        selectedClassLabels: selector.items.filter((item) => item.selected).map((item) => item.label),
        methodology: t("landsatGreen.methodology"), caveat: t("sealedUrban.pixelRegressionCaveat"),
      };
    },
  };
}
