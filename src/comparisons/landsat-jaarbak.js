import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems, thermalColor } from "./thermal-palette.js";

const SOURCE_ID = "landsat-jaarbak-canvas";
const RASTER_LAYER_ID = "landsat-jaarbak-temperature";
const JAARBAK_RASTER_LAYER_ID = "jaarbak-local-raster";
const BEFORE_LAYER = "heat-sectors-hit-area";

const waitForPaintCycle = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

function resolveAsset(root, value, extension) {
  if (typeof value !== "string" || value.includes("..") || !value.endsWith(extension)) {
    throw new TypeError(`Unsafe comparison asset '${value}'.`);
  }
  return `${root}${value}`;
}

export function validateLandsatJaarbakManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "landsat-jaarbak"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "jaarbak") {
    throw new TypeError("Unsupported Landsat-JaarBAK comparison manifest.");
  }
  if (manifest.maximumSeries !== 2 || !Array.isArray(manifest.series) || manifest.series.length !== 2
    || !Array.isArray(manifest.coordinates) || manifest.coordinates.length !== 4 || !manifest.observations) {
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
  let canvas;
  let outputContext;
  let scopeData;
  let municipality = "";
  let savedYear;
  let savedOpacity;
  let loadError = null;
  let drawGeneration = 0;
  let renderedScopeKey = "";
  const pixelCache = new Map();
  const distributionCache = new Map();
  const resolvedDistributions = new Map();
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureManifest = async () => {
    if (manifest) return manifest;
    manifestPromise ??= fetch(descriptor.manifestUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
      const loaded = validateLandsatJaarbakManifest(await response.json());
      loaded.scopeIndexUrl = resolveAsset(descriptor.assetRoot, loaded.scopeIndexUrl, ".png");
      Object.values(loaded.observations).forEach((observation) => {
        observation.pixelDataUrl = resolveAsset(descriptor.assetRoot, observation.pixelDataUrl, ".png");
        observation.distributionUrl = resolveAsset(descriptor.assetRoot, observation.distributionUrl, ".json");
      });
      return loaded;
    }).then((loaded) => { manifest = loaded; return loaded; });
    return manifestPromise;
  };
  const activeObservationId = () => landsatLayer.getOption("observation");
  const activeObservation = () => manifest?.observations?.[activeObservationId()];
  const loadPixels = async (observationId) => {
    if (!pixelCache.has(observationId)) {
      pixelCache.set(observationId, loadImageData(manifest.observations[observationId].pixelDataUrl, manifest.imageSize));
    }
    return pixelCache.get(observationId);
  };
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

  const selectJaarbakYear = async ({ retry = false } = {}) => {
    const year = activeObservation()?.secondaryYear;
    if (!year) return;
    jaarbakLayer.setOption(map, "year", year);
    jaarbakLayer.applyFilter(map, null, { municipality });
    jaarbakLayer.setOpacity(0.20);
    // A hidden raster source can report itself as loaded before MapLibre has
    // requested the tiles required by the current viewport. Make JaarBAK
    // renderable beneath ordinary Landsat, then wait for that visible source.
    jaarbakLayer.setVisible(map, true);
    map.triggerRepaint();
    await waitForPaintCycle();
    await jaarbakLayer.waitUntilReady({ retry });
    await waitForPaintCycle();
  };

  const reassertComparisonStack = () => {
    if (!map?.getLayer(JAARBAK_RASTER_LAYER_ID) || !map.getLayer(RASTER_LAYER_ID)) return;
    jaarbakLayer.setOpacity(0.20);
    jaarbakLayer.setVisible(map, true);
    map.moveLayer(JAARBAK_RASTER_LAYER_ID, RASTER_LAYER_ID);
    map.moveLayer(RASTER_LAYER_ID, BEFORE_LAYER);
    map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "visible");
    map.setPaintProperty(RASTER_LAYER_ID, "raster-opacity", 0.94);
    map.triggerRepaint();
  };

  const draw = async ({ retrySource = false } = {}) => {
    if (!active || !manifest || !outputContext) return;
    const requestGeneration = ++drawGeneration;
    const observationId = activeObservationId();
    landsatLayer.setVisible(map, true);
    jaarbakLayer.setVisible(map, false);
    if (map.getLayer(RASTER_LAYER_ID)) map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "none");
    try {
      await selectJaarbakYear({ retry: retrySource });
      const [pixels, scopes] = await Promise.all([
        loadPixels(observationId),
        scopeData ??= loadImageData(manifest.scopeIndexUrl, manifest.imageSize),
        loadDistribution(observationId),
      ]);
      if (!active || requestGeneration !== drawGeneration || observationId !== activeObservationId()) return;
      const output = outputContext.createImageData(canvas.width, canvas.height);
      const municipalityIndex = municipality ? manifest.municipalityIndexes[municipality] : 0;
      for (let offset = 0, pixel = 0; offset < pixels.data.length; offset += 4, pixel += 1) {
        // The red scope channel is the dissolved Zennevallei union and the
        // green channel contains dissolved municipalities. Neither inherits
        // the analytical sector-tie gaps used by distribution statistics.
        const inScope = municipalityIndex
          ? scopes.data[offset + 1] === municipalityIndex
          : scopes.data[offset] === 1;
        if (!inScope) continue;
        const status = pixels.data[offset + 2];
        if (status === 1) {
          const color = thermalColor(pixels.data[offset]);
          output.data[offset] = color[0];
          output.data[offset + 1] = color[1];
          output.data[offset + 2] = color[2];
          output.data[offset + 3] = 255;
        } else if (status === 2) {
          const light = (pixel % canvas.width + Math.floor(pixel / canvas.width)) % 2;
          const color = light ? 194 : 126;
          output.data[offset] = color;
          output.data[offset + 1] = light ? 201 : 135;
          output.data[offset + 2] = light ? 203 : 139;
          output.data[offset + 3] = 235;
        }
      }
      outputContext.putImageData(output, 0, 0);
      const source = map.getSource(SOURCE_ID);
      source?.setCoordinates(manifest.coordinates);
      source?.play?.();
      map.triggerRepaint();
      requestAnimationFrame(() => source?.pause?.());
      reassertComparisonStack();
      await waitForPaintCycle();
      if (!active || requestGeneration !== drawGeneration || observationId !== activeObservationId()) return;
      reassertComparisonStack();
      landsatLayer.setVisible(map, false);
      map.triggerRepaint();
      renderedScopeKey = `${observationId}|${municipality}`;
      loadError = null;
      notify();
    } catch (error) {
      if (requestGeneration === drawGeneration) {
        jaarbakLayer.setVisible(map, false);
        if (map.getLayer(RASTER_LAYER_ID)) map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "none");
        landsatLayer.setVisible(map, true);
        renderedScopeKey = "";
        loadError = error;
        notify();
      }
      throw error;
    }
  };

  const mount = async ({ retrySource = false } = {}) => {
    await ensureManifest();
    await jaarbakLayer.ensureManifest();
    savedYear ??= jaarbakLayer.getOption("year");
    savedOpacity ??= jaarbakLayer.getOpacity();
    await jaarbakLayer.mount(map, { beforeLayerId: BEFORE_LAYER });
    // A Landsat comparison always needs JaarBAK's binary classification, but
    // the user's density-mode preference remains stored for later use.
    jaarbakLayer.setClassificationOverride?.(true);
    jaarbakLayer.setVisible(map, false);
    jaarbakLayer.setOpacity(0.20);
    if (!map.getSource(SOURCE_ID)) {
      canvas = document.createElement("canvas");
      canvas.id = "landsat-jaarbak-comparison-canvas";
      canvas.width = manifest.imageSize[0];
      canvas.height = manifest.imageSize[1];
      canvas.className = "comparison-render-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);
      outputContext = canvas.getContext("2d", { alpha: true });
      map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
      map.addLayer({
        id: RASTER_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: { "raster-opacity": 0.94, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, BEFORE_LAYER);
    }
    await draw({ retrySource });
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
      landsatLayer.setVisible(map, true);
      try { await mount(); } catch (_error) {
        landsatLayer.setVisible(map, true);
        return false;
      }
      notify();
      return true;
    },
    deactivate() {
      if (!active || !map) return;
      active = false;
      drawGeneration += 1;
      if (map.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      outputContext = null;
      loadError = null;
      renderedScopeKey = "";
      jaarbakLayer.setVisible(map, false);
      jaarbakLayer.setClassificationOverride?.(false);
      if (savedYear != null) jaarbakLayer.setOption(map, "year", savedYear);
      if (savedOpacity != null) jaarbakLayer.setOpacity(savedOpacity);
      savedYear = undefined;
      savedOpacity = undefined;
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() {
      if (!active) return;
      try { await draw(); } catch (error) { console.error(error); }
    },
    async setMunicipality(value) {
      const nextMunicipality = value ?? "";
      if (active && nextMunicipality === municipality
        && renderedScopeKey === `${activeObservationId()}|${nextMunicipality}` && !loadError) return true;
      municipality = nextMunicipality;
      if (!active) return true;
      try { await draw(); return true; } catch (error) { console.error(error); return false; }
    },
    async retry(options = {}) {
      municipality = options.municipality ?? municipality;
      if (!active) active = true;
      landsatLayer.setVisible(map, true);
      try {
        await mount({ retrySource: true });
        return true;
      } catch (error) {
        console.error(error);
        return false;
      }
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
        comparisonSeries: manifest?.series?.filter((series) => series.id === "sealed").map((series) => ({
          ...series, label: t(`soilComparison.${series.id}`), selected: true,
        })) ?? [],
        observation: runtime.observation,
      };
    },
    getLabel: () => t("soilComparison.title"),
    getContext() {
      const runtime = landsatLayer.getRuntimeData();
      return {
        meta: t("soilComparison.contextMeta", { year: activeObservation()?.secondaryYear ?? "" }),
        text: t("soilComparison.contextText"),
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
      const scopeId = scopeIdFor(record);
      const definitions = manifest?.series ?? [];
      return {
        template: "landsat-jaarbak-comparison",
        record,
        manifest,
        landsatManifest: runtime.manifest,
        observation: runtime.observation,
        secondaryYear: activeObservation()?.secondaryYear,
        secondaryStatus: activeObservation()?.secondaryStatus,
        surfaceStats: distribution?.surfaceStats?.[scopeId],
        selectedSeries: definitions.map((definition, index) => ({
          ...definition,
          label: t(`soilComparison.${definition.id}`),
          dashIndex: index,
          stats: distribution?.scopes?.[scopeId]?.series?.[definition.key],
        })),
      };
    },
    getSelectedSeries: () => ["class:sealed", "class:unsealed"],
  };
}
