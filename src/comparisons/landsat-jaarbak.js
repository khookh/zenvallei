import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { createExactSealedRaster } from "./exact-sealed-raster.js";
import { comparisonHeatGradient, comparisonLegendItems } from "./thermal-palette.js";

const LANDSAT_LAYER_ID = "landsat-temperature-raster";
const EXACT_SEALED_ID = "landsat-jaarbak-sealed";
const COMPARISON_LANDSAT_OPACITY = 0.72;

function resolveAsset(root, value, extension) {
  if (typeof value !== "string" || value.includes("..") || !value.endsWith(extension)) {
    throw new TypeError(`Unsafe comparison asset '${value}'.`);
  }
  return `${root}${value}`;
}

export function validateLandsatJaarbakManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.comparisonId !== "landsat-jaarbak"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "jaarbak") {
    throw new TypeError("Unsupported Landsat-JaarBAK comparison manifest.");
  }
  if (manifest.maximumSeries !== 2 || !Array.isArray(manifest.series) || manifest.series.length !== 2
    || !Array.isArray(manifest.coordinates) || manifest.coordinates.length !== 4 || !manifest.observations
    || !manifest.analysisScopeIndexUrl || !Array.isArray(manifest.analysisImageSize)
    || manifest.densityAnalysis?.radiusMeters !== 100
    || manifest.densityAnalysis?.validCoverageThreshold !== 95
    || manifest.densityAnalysis?.sampling !== "none") {
    throw new TypeError("The Landsat-JaarBAK comparison manifest is incomplete.");
  }
  return manifest;
}

async function loadImageData(url, expectedSize) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Comparison image HTTP ${response.status}.`);
  const bitmap = await createImageBitmap(await response.blob());
  if (bitmap.width !== expectedSize[0] || bitmap.height !== expectedSize[1]) {
    bitmap.close();
    throw new Error("Comparison image dimensions do not match the manifest.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

const scopeIdFor = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}`
    : `sector:${record.sectorId}`;

export function createLandsatJaarbakComparison({ descriptor, landsatLayer, jaarbakLayer }) {
  let manifest;
  let manifestPromise;
  let active = false;
  let map;
  let municipality = "";
  let loadError = null;
  let previousLandsatOpacity;
  let generation = 0;
  const exactSealed = createExactSealedRaster({
    id: EXACT_SEALED_ID, beforeLayerId: LANDSAT_LAYER_ID, opacity: 0.96,
  });
  const distributionCache = new Map();
  const resolvedDistributions = new Map();
  const densityPointCache = new Map();
  const scopedPointCache = new Map();
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureManifest = async () => {
    if (manifest) return manifest;
    manifestPromise ??= fetch(descriptor.manifestUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
      const loaded = validateLandsatJaarbakManifest(await response.json());
      if (loaded.analysisScopeIndexUrl) {
        loaded.analysisScopeIndexUrl = resolveAsset(descriptor.assetRoot, loaded.analysisScopeIndexUrl, ".png");
      }
      Object.values(loaded.observations).forEach((observation) => {
        observation.distributionUrl = resolveAsset(descriptor.assetRoot, observation.distributionUrl, ".json");
        if (observation.densityPointDataUrl) {
          observation.densityPointDataUrl = resolveAsset(descriptor.assetRoot, observation.densityPointDataUrl, ".png");
          observation.densityDataUrl = resolveAsset(descriptor.assetRoot, observation.densityDataUrl, ".png");
        }
      });
      return loaded;
    }).then((loaded) => { manifest = loaded; return loaded; });
    return manifestPromise;
  };
  const activeObservationId = () => landsatLayer.getOption("observation");
  const activeObservation = () => manifest?.observations?.[activeObservationId()];
  const loadDistribution = async (observationId) => {
    if (!distributionCache.has(observationId)) {
      distributionCache.set(observationId, fetch(manifest.observations[observationId].distributionUrl)
        .then((response) => {
          if (!response.ok) throw new Error(`Comparison distribution HTTP ${response.status}.`);
          return response.json();
        }).then((loaded) => { resolvedDistributions.set(observationId, loaded); return loaded; }));
    }
    return distributionCache.get(observationId);
  };
  const loadDensityPoints = async (observationId) => {
    if (!activeObservation()?.densityPointDataUrl) return null;
    if (!densityPointCache.has(observationId)) {
      densityPointCache.set(observationId, Promise.all([
        loadImageData(activeObservation().densityPointDataUrl, manifest.analysisImageSize),
        loadImageData(activeObservation().densityDataUrl, manifest.analysisImageSize),
        loadImageData(manifest.analysisScopeIndexUrl, manifest.analysisImageSize),
      ]).then(([points, density, scope]) => ({ points, density, scope })));
    }
    return densityPointCache.get(observationId);
  };
  const scopedDensityPoints = (record) => {
    const observationId = activeObservationId();
    const key = `${observationId}|${scopeIdFor(record)}`;
    if (scopedPointCache.has(key)) return scopedPointCache.get(key);
    const loaded = densityPointCache.get(observationId);
    if (!loaded || typeof loaded.then === "function") return null;
    const { points, density, scope } = loaded;
    // Selected sector records have a sectorId but no synthetic scope field.
    const targetSector = record.sectorId && record.scope !== "municipality" && record.scope !== "region"
      ? manifest.sectorIndexes?.[record.sectorId]
      : null;
    const targetMunicipality = record.scope === "municipality" ? manifest.municipalityIndexes?.[record.municipality] : null;
    const belongs = (offset) => {
      if (targetSector) return scope.data[offset + 2] === Number(targetSector);
      if (targetMunicipality) return scope.data[offset + 1] === Number(targetMunicipality);
      return scope.data[offset] === 1;
    };
    let count = 0;
    for (let offset = 0; offset < points.data.length; offset += 4) {
      if (points.data[offset + 3] === 255 && density.data[offset + 2] === 255
        && belongs(offset)) count += 1;
    }
    const packed = new Float32Array(count * 2);
    let write = 0;
    for (let offset = 0; offset < points.data.length; offset += 4) {
      if (points.data[offset + 3] !== 255 || density.data[offset + 2] !== 255
        || !belongs(offset)) continue;
      packed[write++] = (density.data[offset] * 256 + density.data[offset + 1]) / 100;
      packed[write++] = (points.data[offset] * 256 + points.data[offset + 1]) / 100 - 100;
    }
    scopedPointCache.set(key, packed);
    return packed;
  };

  const showExactSealed = async () => {
    const request = ++generation;
    const observation = activeObservation();
    const archiveUrl = await jaarbakLayer.resolveArchive(observation.secondaryYear, municipality);
    await loadDistribution(activeObservationId());
    const pointPromise = loadDensityPoints(activeObservationId()).then((loaded) => {
      if (loaded) densityPointCache.set(activeObservationId(), loaded);
    });
    const shown = await exactSealed.show(map, { mode: "sealed", jaarbakUrl: archiveUrl });
    await pointPromise;
    if (!active || request !== generation) return false;
    landsatLayer.setVisible(map, true);
    landsatLayer.setOpacity(COMPARISON_LANDSAT_OPACITY);
    if (shown && map.getLayer(LANDSAT_LAYER_ID)) map.moveLayer(LANDSAT_LAYER_ID, "heat-sectors-hit-area");
    map.triggerRepaint();
    loadError = null;
    notify();
    return true;
  };

  return {
    id: "landsat-jaarbak",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "jaarbak",
    isActive: () => active,
    hasLoadError: () => Boolean(loadError),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      active = true;
      await ensureManifest();
      previousLandsatOpacity ??= landsatLayer.getOpacity();
      landsatLayer.setVisible(map, true);
      try { return await showExactSealed(); } catch (error) {
        loadError = error;
        exactSealed.remove();
        landsatLayer.setOpacity(previousLandsatOpacity);
        landsatLayer.setVisible(map, true);
        notify();
        return false;
      }
    },
    deactivate() {
      if (!map) return;
      active = false;
      generation += 1;
      exactSealed.remove();
      if (previousLandsatOpacity != null) landsatLayer.setOpacity(previousLandsatOpacity);
      landsatLayer.setVisible(map, true);
      loadError = null;
      notify();
    },
    async refreshObservation() {
      if (!active) return;
      try { await showExactSealed(); } catch (error) { loadError = error; notify(); }
    },
    async setMunicipality(value = "") {
      municipality = value;
      if (!active) return true;
      try { return await showExactSealed(); } catch (error) { loadError = error; notify(); return false; }
    },
    async retry(options = {}) {
      municipality = options.municipality ?? municipality;
      try { return await showExactSealed(); } catch (error) { loadError = error; notify(); return false; }
    },
    getLegendModel() {
      const runtime = landsatLayer.getRuntimeData();
      return {
        ...landsatLayer.getLegendModel(),
        groups: [
          { items: comparisonLegendItems() },
          { items: [{ label: t("landsat.cloudLegend"), color: "repeating-linear-gradient(45deg,#7e878b 0 3px,#c2c9cb 3px 6px)" }] },
        ],
        title: t("soilComparison.legendTitle"),
        note: t("soilComparison.legendNote", { year: activeObservation()?.secondaryYear ?? "" }),
        gradient: comparisonHeatGradient(),
        comparisonLegend: {
          title: t("soilComparison.baseLegendTitle"),
          items: [{ label: t("soilComparison.sealedExact"), color: "#e8292f" }],
        },
        observation: runtime.observation,
      };
    },
    getLabel: () => t("soilComparison.title"),
    getContext() {
      const runtime = landsatLayer.getRuntimeData();
      return {
        meta: t("soilComparison.contextMeta", { year: activeObservation()?.secondaryYear ?? "" }),
        text: t("soilComparison.contextTextExact"),
        note: t("soilComparison.contextNote"),
        sources: [
          authorityLink("landsat", runtime.manifest?.source?.productUrl),
          authorityLink("departmentEnvironment", jaarbakLayer.getRuntimeData()?.descriptor?.source?.url),
        ],
      };
    },
    getPanelModel(record) {
      const runtime = landsatLayer.getRuntimeData();
      const distribution = resolvedDistributions.get(activeObservationId());
      const id = scopeIdFor(record);
      const definitions = manifest?.series ?? [];
      return {
        template: "landsat-jaarbak-comparison",
        record,
        manifest,
        landsatManifest: runtime.manifest,
        observation: runtime.observation,
        secondaryYear: activeObservation()?.secondaryYear,
        secondaryStatus: activeObservation()?.secondaryStatus,
        surfaceStats: distribution?.surfaceStats?.[id],
        selectedSeries: definitions.map((definition, index) => ({
          ...definition,
          label: t(`soilComparison.${definition.id}`),
          dashIndex: index,
          stats: distribution?.scopes?.[id]?.series?.[definition.key],
        })),
        densityScatter: {
          pixelPoints: scopedDensityPoints(record),
          regression: distribution?.densityAnalysis?.[id] ?? null,
          xLabel: t("soilComparison.densityAxis"),
          yLabel: t("sealedUrban.axisTemperature"),
        },
      };
    },
    getSelectedSeries: () => ["class:sealed", "class:unsealed"],
  };
}
