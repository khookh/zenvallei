import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems, thermalColor } from "./thermal-palette.js";
import {
  comparisonAreaRecord, hideIncomeSymbols, incomeLegend, loadImageData, mountIncomeSymbols,
  ordinaryLeastSquares, safeAsset, SEALED_URBAN_SOURCE_URLS, sectorPointLabel,
} from "./sealed-urban-shared.js";

const SOURCE_ID = "landsat-income-canvas";
const RASTER_LAYER_ID = "landsat-income-temperature";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-landsat";
const BEFORE_LAYER = "heat-sectors-hit-area";
const scopeId = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}` : `sector:${record.sectorId}`;

export function validateLandsatIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "landsat-income"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "income"
    || manifest.incomeYear !== 2023 || manifest.analysisResolutionMeters !== 30
    || manifest.minimumSectorPixels !== 10 || !manifest.observations
    || !manifest.scopeIndexUrl || !manifest.municipalityIndexes) {
    throw new TypeError("Unsupported Landsat-income comparison manifest.");
  }
  return manifest;
}

export function createLandsatIncomeComparison({ descriptor, landsatLayer, incomeLayer }) {
  let manifest;
  let map;
  let canvas;
  let context;
  let active = false;
  let municipality = "";
  let highlightedSectorId = "";
  let pointData;
  let scopeData;
  let statistics;
  let loadedObservation = "";
  let generation = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const observationId = () => landsatLayer.getOption("observation");
  const observation = () => landsatLayer.getRuntimeData()?.observation;

  const ensureManifest = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateLandsatIncomeManifest(await response.json());
    manifest.scopeIndexUrl = safeAsset(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    Object.values(manifest.observations).forEach((item) => {
      item.pointDataUrl = safeAsset(descriptor.assetRoot, item.pointDataUrl, ".png");
      item.statisticsUrl = safeAsset(descriptor.assetRoot, item.statisticsUrl, ".json");
    });
    scopeData = await loadImageData(manifest.scopeIndexUrl, manifest.imageSize);
  };

  const loadObservation = async () => {
    await ensureManifest();
    const id = observationId();
    if (loadedObservation === id) return;
    const item = manifest.observations[id];
    if (!item) throw new Error(`No sealed-urban comparison data for ${id}.`);
    const [pixels, statsResponse] = await Promise.all([
      loadImageData(item.pointDataUrl, manifest.imageSize), fetch(item.statisticsUrl),
    ]);
    if (!statsResponse.ok) throw new Error(`Comparison statistics HTTP ${statsResponse.status}.`);
    pointData = pixels;
    statistics = await statsResponse.json();
    loadedObservation = id;
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
        const code = pointData.data[offset] * 256 + pointData.data[offset + 1];
        const temperature = code / 100 - 100;
        const normalized = Math.round(Math.max(0, Math.min(1, (temperature - 15) / 35)) * 255);
        const color = thermalColor(normalized);
        output.data[offset] = color[0];
        output.data[offset + 1] = color[1];
        output.data[offset + 2] = color[2];
        output.data[offset + 3] = 226;
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

  const points = () => Object.values(statistics?.sectorStats ?? {}).flatMap((record) => {
    if (record.clearPixelCount < manifest.minimumSectorPixels || !Number.isFinite(record.income)
      || !Number.isFinite(record.meanTemperatureC) || (municipality && record.municipality !== municipality)) return [];
    return [{ ...record, temperature: record.meanTemperatureC }];
  }).sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return;
    mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
    render();
    notify();
  };

  return {
    id: "landsat-income",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "income",
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
      landsatLayer.setVisible(map, false);
      incomeLayer.setVisible(map, false);
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
          paint: { "raster-opacity": .88, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, BEFORE_LAYER);
      }
      active = true;
      await refresh();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      highlightedSectorId = "";
      if (map?.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map?.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      context = null;
      hideIncomeSymbols(map, SYMBOL_LAYER_ID);
      incomeLayer.setVisible(map, false);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
    setMunicipality(value = "") {
      municipality = value;
      if (active) {
        mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
        render();
        notify();
      }
      return true;
    },
    setHighlightedSector(value = "") { highlightedSectorId = value; if (active) notify(); },
    getLabel: () => t("landsatIncome.title"),
    getActiveNote: () => t("landsatIncome.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("landsatIncome.contextMeta"), text: t("landsatIncome.contextText"), note: t("landsatIncome.contextNote"),
      sources: [
        authorityLink("landsat", SEALED_URBAN_SOURCE_URLS.landsat),
        authorityLink("departmentEnvironment", SEALED_URBAN_SOURCE_URLS.jaarbak),
        authorityLink("copernicusClms", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        authorityLink("statbel", SEALED_URBAN_SOURCE_URLS.income),
      ],
    }),
    getLegendModel: () => ({
      title: t("landsatIncome.legendTitle"), layout: "scale", groups: [{ items: comparisonLegendItems() }],
      gradient: comparisonHeatGradient(), comparisonLegend: incomeLegend(),
      note: t("landsatIncome.legendNote"), observation: observation(),
    }),
    getPopupModel(_feature, record) {
      const point = points().find(({ sectorId }) => sectorId === record.sectorId);
      return { title: record.sectorName, subtitle: t("landsatIncome.popupSubtitle"),
        lines: point ? [sectorPointLabel(point, { x: "income", y: "temperature", observation: observation()?.acquiredAt })]
          : [t("sealedUrban.noComparableValue")] };
    },
    getPanelModel(record) {
      const current = points();
      const areaRecord = comparisonAreaRecord(record, municipality);
      return {
        template: "sealed-urban-scatter", comparisonId: "landsat-income", record: areaRecord,
        title: t("landsatIncome.chartTitle"), definition: t("landsatIncome.definition"),
        xLabel: t("sealedUrban.axisIncome"), yLabel: t("sealedUrban.axisTemperature"),
        xKey: "income", yKey: "temperature", points: current,
        regression: statistics.regressions?.[scopeId(areaRecord)]
          ?? ordinaryLeastSquares(current, "income", "temperature"),
        slopeScale: 10_000, slopeUnit: t("landsatIncome.slopeUnit"),
        highlightedSectorId, observation: observation(),
        methodology: t("landsatIncome.methodology"), caveat: t("sealedUrban.regressionCaveat"),
      };
    },
  };
}
