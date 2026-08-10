import GreenUrbanDensityWorker from "../workers/green-urban-density-worker.js?worker";
import { getLanguage, t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";

const SOURCE_ID = "groenkaart-urban-atlas-canvas";
const RASTER_LAYER_ID = "groenkaart-urban-atlas-density";
const QUERY_LAYER_ID = "groenkaart-urban-atlas-query";
const OUTLINE_LAYER_ID = "groenkaart-urban-atlas-outlines";
const URBAN_ATLAS_SOURCE = "urban-atlas";
const BEFORE_LAYER = "heat-sectors-hit-area";
const DENSITY_COLORS = ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"];

const localized = (value, fallback = "") => typeof value === "string"
  ? value
  : value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;

function assetUrl(root, value, extension) {
  if (typeof value !== "string" || value.includes("..") || !value.endsWith(extension)) {
    throw new TypeError(`Unsafe Green Map comparison asset '${value}'.`);
  }
  return `${root}${value}`;
}

export function validateGreenUrbanManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "groenkaart-urban-atlas"
    || manifest.primaryLayerId !== "groenkaart" || manifest.secondaryLayerId !== "urban-atlas"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.analysisResolutionMeters !== 10 || manifest.densityRadiusMeters !== 100
    || !Array.isArray(manifest.fabricClasses) || manifest.fabricClasses.length !== 5
    || manifest.fabricClasses.some(({ code }) => !["11100", "11210", "11220", "11230", "11240"].includes(code))
    || !manifest.excludedUrbanAtlasCodes?.includes("11300")) {
    throw new TypeError("Unsupported Green Map-Urban Atlas comparison manifest.");
  }
  return manifest;
}

async function loadImage(url, size) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Comparison image HTTP ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob());
  if (bitmap.width !== size[0] || bitmap.height !== size[1]) {
    bitmap.close();
    throw new Error("Comparison image dimensions do not match the manifest.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

async function loadDensity(url, size) {
  const { fromUrl } = await import("geotiff");
  const tiff = await fromUrl(url, { cacheSize: 32 * 1024 * 1024 });
  const image = await tiff.getImage();
  if (image.getWidth() !== size[0] || image.getHeight() !== size[1]) {
    await tiff.close?.();
    throw new Error("Comparison density dimensions do not match the manifest.");
  }
  const bands = await image.readRasters();
  await tiff.close?.();
  return [...bands];
}

export function combinedGreenDensity(stats, selectedGreenClasses) {
  return selectedGreenClasses.reduce((sum, code) => {
    const value = stats?.meanDensityByGreenClass?.[String(code)];
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

export function createGroenkaartUrbanAtlasComparison({ descriptor, groenkaartLayer, urbanAtlasLayer, urbanAtlas }) {
  let manifest;
  let statistics;
  let map;
  let active = false;
  let municipality = "";
  let canvas;
  let context;
  let worker;
  let workerReady;
  const renderRequests = new Map();
  let generation = 0;
  let loadedAssets;
  let selectedGreen = new Set([1, 2]);
  let selectedFabric = new Set();
  let previousGreenMapYear = 2021;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureData = async () => {
    if (manifest && statistics && loadedAssets) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateGreenUrbanManifest(await response.json());
    manifest.fabricMaskUrl = assetUrl(descriptor.assetRoot, manifest.fabricMaskUrl, ".png");
    manifest.statisticsUrl = assetUrl(descriptor.assetRoot, manifest.statisticsUrl, ".json");
    manifest.scopeIndexUrl = assetUrl(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    manifest.densityDataUrl = assetUrl(descriptor.assetRoot, manifest.densityDataUrl, ".tif");
    selectedGreen = new Set(manifest.defaultGreenClasses);
    selectedFabric = new Set(manifest.defaultFabricClasses);
    const [statsResponse, densityBands, scope, fabric] = await Promise.all([
      fetch(manifest.statisticsUrl),
      loadDensity(manifest.densityDataUrl, manifest.imageSize),
      loadImage(manifest.scopeIndexUrl, manifest.imageSize),
      loadImage(manifest.fabricMaskUrl, manifest.imageSize),
    ]);
    if (!statsResponse.ok) throw new Error(`Comparison statistics HTTP ${statsResponse.status}.`);
    statistics = await statsResponse.json();
    loadedAssets = { densityBands, scope, fabric };
  };

  const filterOutlines = () => {
    if (!map?.getLayer(OUTLINE_LAYER_ID)) return;
    const classFilter = ["in", ["to-string", ["get", "classCode"]], ["literal", [...selectedFabric]]];
    map.setFilter(OUTLINE_LAYER_ID, municipality
      ? ["all", classFilter, ["==", ["get", "municipality"], municipality]]
      : classFilter);
    if (map.getLayer(QUERY_LAYER_ID)) map.setFilter(QUERY_LAYER_ID, municipality
      ? ["all", classFilter, ["==", ["get", "municipality"], municipality]]
      : classFilter);
  };

  const render = async () => {
    if (!active || !loadedAssets || !context) return;
    const requestGeneration = ++generation;
    if (!worker) {
      worker = new GreenUrbanDensityWorker();
      // The scientific density arrays are transferred to one long-lived worker.
      // Surface toggles then send only small selector messages instead of cloning
      // the four raster bands on every interaction.
      workerReady = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Green density comparison initialisation timed out.")), 8_000);
        worker.onmessage = ({ data }) => {
          if (data.type === "ready") {
            window.clearTimeout(timeout);
            resolve();
            return;
          }
          if (data.type === "rendered") {
            const pending = renderRequests.get(data.generation);
            if (!pending) return;
            window.clearTimeout(pending.timeout);
            renderRequests.delete(data.generation);
            pending.resolve(data.output);
          }
        };
        worker.onerror = (event) => {
          window.clearTimeout(timeout);
          const error = event.error ?? new Error(event.message);
          reject(error);
          renderRequests.forEach((pending) => {
            window.clearTimeout(pending.timeout);
            pending.reject(error);
          });
          renderRequests.clear();
        };
      });
      const transferableBands = loadedAssets.densityBands.map((band) => band.buffer);
      worker.postMessage({
        type: "initialise", width: manifest.imageSize[0], height: manifest.imageSize[1],
        densityBands: loadedAssets.densityBands, scope: loadedAssets.scope, fabric: loadedAssets.fabric,
      }, [...transferableBands, loadedAssets.scope.buffer, loadedAssets.fabric.buffer]);
    }
    await workerReady;
    const output = await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        renderRequests.delete(requestGeneration);
        reject(new Error("Green density comparison rendering timed out."));
      }, 8_000);
      renderRequests.set(requestGeneration, { resolve, reject, timeout });
      const bandIndexes = [...selectedGreen].map((code) => (
        manifest.densityBands.findIndex((band) => Number(band.code) === code)
      ));
      const fabricIndexes = manifest.fabricClasses
        .filter(({ code }) => selectedFabric.has(code)).map(({ index }) => index);
      worker.postMessage({
        type: "render", generation: requestGeneration,
        selectedDensityBands: bandIndexes,
        selectedFabricIndexes: fabricIndexes,
        municipalityIndex: manifest.municipalityIndexes[municipality] ?? 0,
        encodingScale: manifest.densityEncodingScale,
        noDataValue: manifest.densityNoDataValue,
      });
    });
    if (!active || requestGeneration !== generation) return;
    context.putImageData(new ImageData(output, canvas.width, canvas.height), 0, 0);
    const source = map.getSource(SOURCE_ID);
    source?.setCoordinates(manifest.coordinates);
    source?.play?.();
    filterOutlines();
    map.triggerRepaint();
    requestAnimationFrame(() => source?.pause?.());
  };

  const toggle = (set, value) => {
    if (set.has(value)) {
      if (set.size === 1) return { changed: false, minimum: true };
      set.delete(value);
    } else set.add(value);
    render();
    notify();
    return { changed: true };
  };

  return {
    id: "groenkaart-urban-atlas",
    primaryLayerId: "groenkaart",
    secondaryLayerId: "urban-atlas",
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await Promise.all([
        ensureData(),
        groenkaartLayer.ensureManifest(),
        urbanAtlasLayer.mount(map, { beforeLayerId: BEFORE_LAYER }),
      ]);
      previousGreenMapYear = Number(groenkaartLayer.getOption("year") ?? 2021);
      groenkaartLayer.setOption(map, "year", 2021);
      groenkaartLayer.setVisible(map, false);
      urbanAtlasLayer.setVisible(map, false);
      if (!map.getSource(SOURCE_ID)) {
        canvas = document.createElement("canvas");
        canvas.width = manifest.imageSize[0];
        canvas.height = manifest.imageSize[1];
        canvas.className = "comparison-render-canvas";
        canvas.setAttribute("aria-hidden", "true");
        document.body.append(canvas);
        context = canvas.getContext("2d", { alpha: true });
        map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
        map.addLayer({
          id: RASTER_LAYER_ID, type: "raster", source: SOURCE_ID,
          paint: { "raster-opacity": .92, "raster-resampling": "linear", "raster-fade-duration": 0 },
        }, BEFORE_LAYER);
        const colors = manifest.fabricClasses.flatMap((item) => [item.code, item.color]);
        // A practically transparent fill keeps the selected Urban Atlas
        // polygons queryable for pointer labels without visually competing
        // with the scientific Green Map density raster.
        map.addLayer({
          id: QUERY_LAYER_ID, type: "fill", source: URBAN_ATLAS_SOURCE,
          paint: { "fill-color": "#ffffff", "fill-opacity": .001 },
        }, BEFORE_LAYER);
        map.addLayer({
          id: OUTLINE_LAYER_ID, type: "line", source: URBAN_ATLAS_SOURCE,
          paint: {
            "line-color": ["match", ["to-string", ["get", "classCode"]], ...colors, "#ffffff"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, .5, 15, 1.3],
            "line-opacity": .62,
          },
        }, BEFORE_LAYER);
      }
      active = true;
      await render();
      notify();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      // Keep the prepared arrays in the worker for a later reactivation. They
      // were transferred rather than cloned, so rebuilding the worker here
      // would require an unnecessary network reload of the 2021 density COG.
      if (map?.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
      if (map?.getLayer(QUERY_LAYER_ID)) map.removeLayer(QUERY_LAYER_ID);
      if (map?.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map?.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      context = null;
      urbanAtlasLayer.setVisible(map, false);
      groenkaartLayer.setOption(map, "year", previousGreenMapYear);
      groenkaartLayer.setVisible(map, true);
      notify();
    },
    async setMunicipality(value = "") {
      municipality = value;
      if (active) await render();
      notify();
      return true;
    },
    toggleGreenClass(code) { return toggle(selectedGreen, Number(code)); },
    toggleFabricClass(code) { return toggle(selectedFabric, String(code)); },
    getLabel: () => t("greenUrbanComparison.title"),
    getActiveNote: () => t("greenUrbanComparison.activeNote"),
    getContext: () => ({
      meta: t("greenUrbanComparison.contextMeta"),
      text: t("greenUrbanComparison.contextText"),
      note: t("greenUrbanComparison.contextNote"),
      sources: [
        authorityLink("natureForests", "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021"),
        authorityLink("digitalFlanders", "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021"),
        authorityLink("copernicusClms", urbanAtlas?.source?.productUrl),
      ],
    }),
    getPopupModel(feature, record, event) {
      const base = groenkaartLayer.getPopupModel(feature, record);
      const surface = event && map?.getLayer(QUERY_LAYER_ID)
        ? map.queryRenderedFeatures(event.point, { layers: [QUERY_LAYER_ID] })[0]
        : null;
      const code = String(surface?.properties?.classCode ?? "");
      const urbanClass = manifest?.fabricClasses.find((item) => item.code === code);
      return {
        ...base,
        lines: [
          ...base.lines,
          urbanClass
            ? t("greenUrbanComparison.popupFabric", { surface: t(`urbanAtlas.class.${urbanClass.code}`), code: urbanClass.code })
            : t("greenUrbanComparison.popupNoFabric"),
        ],
      };
    },
    getLegendModel() {
      return {
        title: t("greenUrbanComparison.legendTitle"),
        note: t("greenUrbanComparison.legendNote"),
        layout: "scale",
        groups: [
          { items: DENSITY_COLORS.map((color, index) => ({ label: String(index * 25), color })) },
          { items: [] },
        ],
        dualSelector: {
          green: {
            title: t("greenUrbanComparison.greenSelector"),
            items: manifest.greenClasses.map((item) => ({
              value: Number(item.value), label: localized(item.label, String(item.value)),
              color: item.color, selected: selectedGreen.has(Number(item.value)),
            })),
          },
          fabric: {
            title: t("greenUrbanComparison.fabricSelector"),
            items: manifest.fabricClasses.map((item) => ({
              value: item.code, label: t(`urbanAtlas.class.${item.code}`),
              color: item.color, selected: selectedFabric.has(item.code),
            })),
          },
        },
        footnote: t("greenUrbanComparison.legendFootnote"),
      };
    },
    getPanelModel(record) {
      const scopeId = record.scope === "region" ? "region:zennevallei"
        : record.scope === "municipality" ? `municipality:${record.municipality}`
          : `sector:${record.sectorId}`;
      const scope = statistics?.scopes?.[scopeId];
      const selectionKey = [...selectedGreen].sort((left, right) => left - right).join("+");
      return {
        template: "groenkaart-urban-atlas-comparison", record,
        selectedGreenClasses: [...selectedGreen],
        selectedFabricClasses: manifest.fabricClasses.filter(({ code }) => selectedFabric.has(code)).map((item) => ({
          ...item,
          label: t(`urbanAtlas.class.${item.code}`),
          stats: scope?.classes?.[item.code],
          meanDensity: combinedGreenDensity(scope?.classes?.[item.code], [...selectedGreen]),
          densityDistribution: scope?.classes?.[item.code]?.densityDistributions?.[selectionKey] ?? null,
        })),
        greenClassLabels: manifest.greenClasses.filter(({ value }) => selectedGreen.has(Number(value)))
          .map((item) => localized(item.label, String(item.value))),
        analysisResolutionMeters: manifest.analysisResolutionMeters,
        densityRadiusMeters: manifest.densityRadiusMeters,
      };
    },
  };
}
