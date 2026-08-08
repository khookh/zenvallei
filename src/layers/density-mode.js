import DensityRenderWorker from "../workers/density-render-worker.js?worker";
import { formatNumber, getLanguage, t } from "../i18n.js";

const CANVAS_SOURCE_ID = (datasetId) => `${datasetId}-density-source`;
const CANVAS_LAYER_ID = (datasetId) => `${datasetId}-density-raster`;
const BEFORE_LAYER = "heat-sectors-hit-area";
const rasterCache = new Map();
const scopeCache = new Map();
const DENSITY_COLOURS = Object.freeze({
  jaarbak: ["#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a", "#ef3b2c", "#cb181d", "#a50f15", "#85000d", "#740008", "#67000d"],
  groenkaart: ["#f7fbff", "#e3eef8", "#c6dbef", "#a9cce5", "#6baed6", "#4292c6", "#2171b5", "#1764a0", "#0d4f8b", "#0a3e70", "#08306b"],
});

const localized = (value, fallback = "") => typeof value === "string"
  ? value
  : value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;

export function validateDensityContract(contract, datasetId) {
  if (!contract || contract.schemaVersion !== 1 || contract.radiusMeters !== 100
    || contract.denominator !== "complete-circle" || !contract.years
    || !Array.isArray(contract.coordinates) || contract.coordinates.length !== 4) {
    throw new TypeError(`${datasetId}: invalid density contract.`);
  }
  return contract;
}

async function loadRaster(url, contract) {
  if (rasterCache.has(url)) return rasterCache.get(url);
  const promise = import("geotiff").then(async ({ fromUrl }) => {
    const tiff = await fromUrl(url, { cacheSize: 32 * 1024 * 1024 });
    const image = await tiff.getImage();
    if (image.getWidth() !== contract.imageSize[0] || image.getHeight() !== contract.imageSize[1]) {
      throw new Error("Density raster dimensions do not match its manifest.");
    }
    const rasters = await image.readRasters();
    await tiff.close?.();
    return rasters;
  }).catch((error) => {
    rasterCache.delete(url);
    throw error;
  });
  rasterCache.set(url, promise);
  return promise;
}

async function loadScope(url, contract) {
  if (scopeCache.has(url)) return scopeCache.get(url);
  const promise = fetch(url).then(async (response) => {
    if (!response.ok) throw new Error(`Density scope HTTP ${response.status}.`);
    const bitmap = await createImageBitmap(await response.blob());
    if (bitmap.width !== contract.imageSize[0] || bitmap.height !== contract.imageSize[1]) {
      bitmap.close();
      throw new Error("Density scope dimensions do not match its manifest.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }).catch((error) => {
    scopeCache.delete(url);
    throw error;
  });
  scopeCache.set(url, promise);
  return promise;
}

function webMercator(lng, lat) {
  const x = lng * 20037508.34 / 180;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const y = Math.log(Math.tan((90 + clamped) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
  return [x, y];
}

export function createDensityMode({ datasetId, getManifest, getYear, getMunicipality, setClassificationVisible }) {
  let map;
  let active = false;
  let visible = false;
  let canvas;
  let context;
  let worker;
  let loaded;
  let generation = 0;
  let cancelPendingRender = () => {};
  let selectedCodes = datasetId === "groenkaart" ? new Set([1, 2]) : new Set([1]);
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const selectedBandIndexes = (contract) => [...selectedCodes].map((code) => {
    const position = contract.bands.findIndex((band) => Number(band.code) === Number(code));
    if (position < 0) throw new Error(`Density band ${code} is unavailable.`);
    return position;
  });

  const render = async () => {
    if (!active || !map) return;
    const manifest = getManifest();
    const contract = validateDensityContract(manifest?.density, datasetId);
    const year = getYear();
    const entry = contract.years?.[year];
    if (!entry?.dataUrl) throw new Error(`${datasetId}: density year ${year} is unavailable.`);
    const requestGeneration = ++generation;
    const [bands, scope] = await Promise.all([
      loadRaster(entry.dataUrl, contract),
      loadScope(contract.scopeIndexUrl, contract),
    ]);
    if (!active || requestGeneration !== generation) return;
    loaded = { bands, scope, contract, year };
    cancelPendingRender();
    worker?.terminate();
    worker = new DensityRenderWorker();
    const rendered = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Density rendering timed out.")), 8000);
      cancelPendingRender = () => {
        window.clearTimeout(timeout);
        resolve(null);
      };
      worker.onmessage = ({ data }) => {
        if (data.type !== "rendered" || data.generation !== requestGeneration) return;
        window.clearTimeout(timeout);
        cancelPendingRender = () => {};
        resolve(data.output);
      };
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        cancelPendingRender = () => {};
        reject(event.error ?? new Error(event.message));
      };
    });
    worker.postMessage({
      type: "initialise", generation: requestGeneration,
      width: contract.imageSize[0], height: contract.imageSize[1], densityBands: [...bands], scope,
    });
    worker.postMessage({
      type: "render", generation: requestGeneration,
      selectedBands: selectedBandIndexes(contract),
      municipalityIndex: contract.municipalityIndexes[getMunicipality()] ?? 0,
      palette: datasetId === "jaarbak" ? "sealed" : "green",
    });
    const output = await rendered;
    if (!output || !active || requestGeneration !== generation) return;
    context.putImageData(new ImageData(output, canvas.width, canvas.height), 0, 0);
    const source = map.getSource(CANVAS_SOURCE_ID(datasetId));
    source?.setCoordinates(contract.coordinates);
    source?.play?.();
    map.triggerRepaint();
    requestAnimationFrame(() => source?.pause?.());
    notify();
  };

  const mount = (nextMap) => {
    map = nextMap;
    if (map.getSource(CANVAS_SOURCE_ID(datasetId))) return;
    const contract = validateDensityContract(getManifest()?.density, datasetId);
    canvas = document.createElement("canvas");
    canvas.id = `${datasetId}-density-canvas`;
    canvas.width = contract.imageSize[0];
    canvas.height = contract.imageSize[1];
    canvas.className = "density-render-canvas";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    context = canvas.getContext("2d", { alpha: true });
    map.addSource(CANVAS_SOURCE_ID(datasetId), {
      type: "canvas", canvas, coordinates: contract.coordinates, animate: false,
    });
    map.addLayer({
      id: CANVAS_LAYER_ID(datasetId), type: "raster", source: CANVAS_SOURCE_ID(datasetId),
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.88, "raster-resampling": "linear", "raster-fade-duration": 0 },
    }, map.getLayer(BEFORE_LAYER) ? BEFORE_LAYER : undefined);
  };

  const setDensityVisible = (nextVisible) => {
    visible = nextVisible;
    if (map?.getLayer(CANVAS_LAYER_ID(datasetId))) {
      map.setLayoutProperty(CANVAS_LAYER_ID(datasetId), "visibility", active && visible ? "visible" : "none");
    }
  };

  const classDefinitions = () => {
    const items = getManifest()?.classesOrScale?.items ?? [];
    return items.filter((item) => datasetId === "groenkaart" || Number(item.value) === 1).map((item) => ({
      code: Number(item.value), label: localized(item.label, String(item.value)), color: item.color,
      selected: selectedCodes.has(Number(item.value)),
    }));
  };

  return {
    isActive: () => active,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async toggle(nextMap) {
      map = nextMap;
      active = !active;
      if (active) {
        mount(map);
        setClassificationVisible(false);
        setDensityVisible(true);
        try { await render(); } catch (error) {
          active = false;
          setDensityVisible(false);
          setClassificationVisible(visible);
          throw error;
        }
      } else {
        generation += 1;
        cancelPendingRender();
        worker?.terminate();
        setDensityVisible(false);
        setClassificationVisible(visible);
      }
      notify();
      return active;
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      if (active) {
        setClassificationVisible(false);
        setDensityVisible(nextVisible);
      } else setClassificationVisible(nextVisible);
    },
    refresh() { if (active) return render(); return Promise.resolve(); },
    toggleClass(code) {
      const numeric = Number(code);
      if (datasetId !== "groenkaart" || ![1, 2, 3, 4].includes(numeric)) return { changed: false };
      if (selectedCodes.has(numeric)) {
        if (selectedCodes.size === 1) return { changed: false, minimum: true };
        selectedCodes.delete(numeric);
      } else selectedCodes.add(numeric);
      render();
      notify();
      return { changed: true };
    },
    getLegendModel() {
      const year = getYear();
      const colours = DENSITY_COLOURS[datasetId];
      return {
        title: t(datasetId === "jaarbak" ? "density.sealedLegend" : "density.greenLegend", { year }),
        note: t("density.legendNote", { year, radius: 100 }),
        footnote: t("density.legendFootnote"),
        layout: "scale",
        groups: [{ items: colours.map((color, index) => ({ label: String(index * 10), color })) }, { items: [] }],
        densitySelector: datasetId === "groenkaart" ? {
          title: t("density.selectedClasses"), items: classDefinitions(),
        } : null,
      };
    },
    async inspectPoint(point) {
      if (!active || !loaded || loaded.year !== getYear()) return { status: "loading" };
      const [x, y] = webMercator(point.lng, point.lat);
      const [minx, miny, maxx, maxy] = loaded.contract.boundsEpsg3857;
      if (x < minx || x >= maxx || y < miny || y >= maxy) return { status: "outside" };
      const column = Math.floor((x - minx) / ((maxx - minx) / loaded.contract.imageSize[0]));
      const row = Math.floor((maxy - y) / ((maxy - miny) / loaded.contract.imageSize[1]));
      const pixel = row * loaded.contract.imageSize[0] + column;
      const scopeOffset = pixel * 4;
      const municipalityIndex = loaded.contract.municipalityIndexes[getMunicipality()] ?? 0;
      if (!loaded.scope[scopeOffset + 1]
        || (municipalityIndex && loaded.scope[scopeOffset] !== municipalityIndex)) return { status: "outside" };
      const selected = classDefinitions().filter((item) => item.selected).map((item) => {
        const band = loaded.contract.bands.findIndex((candidate) => Number(candidate.code) === item.code);
        const value = loaded.bands[band][pixel];
        return { ...item, percentage: value === loaded.contract.noDataValue ? null : value / loaded.contract.encodingScale };
      });
      const coverageBand = loaded.contract.bands.findIndex((band) => band.code === "validCoverage");
      const coverageValue = loaded.bands[coverageBand][pixel];
      if (selected.some((item) => item.percentage == null) || coverageValue === loaded.contract.noDataValue) {
        return { status: "unavailable", year: loaded.year };
      }
      const percentage = Math.min(100, selected.reduce((sum, item) => sum + item.percentage, 0));
      return {
        status: "available", year: loaded.year, percentage,
        areaHa: percentage / 100 * loaded.contract.circleAreaHa,
        coverage: coverageValue / loaded.contract.encodingScale,
        radiusMeters: loaded.contract.radiusMeters, selected,
      };
    },
    getPointPopupModel(result) {
      if (result.status !== "available") {
        return { title: t("density.popupTitle"), lines: [t(result.status === "loading" ? "density.loading" : "density.unavailable")] };
      }
      const label = datasetId === "jaarbak" ? t("density.sealedSurface") : t("density.selectedGreenMapClasses");
      return {
        title: t("density.popupTitle"), subtitle: t("density.popupMeta", { year: result.year, radius: result.radiusMeters }),
        lines: [
          `${label}: ${formatNumber(result.percentage)}% (${formatNumber(result.areaHa)} ha)`,
          ...result.selected.map((item) => `${item.label}: ${formatNumber(item.percentage)}%`),
          result.coverage < 99.99 ? t("density.sourceCoverage", { value: formatNumber(result.coverage) }) : t("density.completeCoverage"),
        ],
      };
    },
    getInspectionRadiusMeters: () => 100,
    getClassSelection: () => [...selectedCodes],
  };
}
