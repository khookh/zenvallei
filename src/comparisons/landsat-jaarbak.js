import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems, thermalColor } from "./thermal-palette.js";

const SOURCE_ID = "landsat-jaarbak-canvas";
const RASTER_LAYER_ID = "landsat-jaarbak-temperature";
const SEALED_SOURCE_ID = "landsat-jaarbak-sealed-canvas";
const SEALED_LAYER_ID = "landsat-jaarbak-sealed";
const BEFORE_LAYER = "heat-sectors-hit-area";

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
  let sealedCanvas;
  let sealedContext;
  let scopeData;
  let municipality = "";
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

  const draw = async () => {
    if (!active || !manifest || !outputContext || !sealedContext) return;
    const requestGeneration = ++drawGeneration;
    const observationId = activeObservationId();
    landsatLayer.setVisible(map, true);
    if (map.getLayer(RASTER_LAYER_ID)) map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "none");
    if (map.getLayer(SEALED_LAYER_ID)) map.setLayoutProperty(SEALED_LAYER_ID, "visibility", "none");
    try {
      const [pixels, scopes] = await Promise.all([
        loadPixels(observationId),
        scopeData ??= loadImageData(manifest.scopeIndexUrl, manifest.imageSize),
        loadDistribution(observationId),
      ]);
      if (!active || requestGeneration !== drawGeneration || observationId !== activeObservationId()) return;
      const output = outputContext.createImageData(canvas.width, canvas.height);
      const sealed = sealedContext.createImageData(sealedCanvas.width, sealedCanvas.height);
      const municipalityIndex = municipality ? manifest.municipalityIndexes[municipality] : 0;
      for (let offset = 0, pixel = 0; offset < pixels.data.length; offset += 4, pixel += 1) {
        // The red scope channel is the dissolved Zennevallei union and the
        // green channel contains dissolved municipalities. Neither inherits
        // the analytical sector-tie gaps used by distribution statistics.
        const inScope = municipalityIndex
          ? scopes.data[offset + 1] === municipalityIndex
          : scopes.data[offset] === 1;
        if (!inScope) continue;
        // Green channel 1 is the majority-sealed result prepared from the
        // native 1 m JaarBAK source on this exact 30 m Landsat grid.
        if (pixels.data[offset + 1] === 1) {
          sealed.data[offset] = 127;
          sealed.data[offset + 1] = 0;
          sealed.data[offset + 2] = 29;
          sealed.data[offset + 3] = 255;
        }
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
      sealedContext.putImageData(sealed, 0, 0);
      const source = map.getSource(SOURCE_ID);
      const sealedSource = map.getSource(SEALED_SOURCE_ID);
      source?.setCoordinates(manifest.coordinates);
      sealedSource?.setCoordinates(manifest.coordinates);
      source?.play?.();
      sealedSource?.play?.();
      map.triggerRepaint();
      requestAnimationFrame(() => {
        source?.pause?.();
        sealedSource?.pause?.();
      });
      map.setLayoutProperty(SEALED_LAYER_ID, "visibility", "visible");
      map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "visible");
      map.moveLayer(SEALED_LAYER_ID, RASTER_LAYER_ID);
      map.moveLayer(RASTER_LAYER_ID, BEFORE_LAYER);
      landsatLayer.setVisible(map, false);
      map.triggerRepaint();
      renderedScopeKey = `${observationId}|${municipality}`;
      loadError = null;
      notify();
    } catch (error) {
      if (requestGeneration === drawGeneration) {
        if (map.getLayer(SEALED_LAYER_ID)) map.setLayoutProperty(SEALED_LAYER_ID, "visibility", "none");
        if (map.getLayer(RASTER_LAYER_ID)) map.setLayoutProperty(RASTER_LAYER_ID, "visibility", "none");
        landsatLayer.setVisible(map, true);
        renderedScopeKey = "";
        loadError = error;
        notify();
      }
      throw error;
    }
  };

  const mount = async () => {
    await ensureManifest();
    if (!map.getSource(SOURCE_ID)) {
      canvas = document.createElement("canvas");
      canvas.id = "landsat-jaarbak-comparison-canvas";
      canvas.width = manifest.imageSize[0];
      canvas.height = manifest.imageSize[1];
      canvas.className = "comparison-render-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);
      outputContext = canvas.getContext("2d", { alpha: true });
      sealedCanvas = document.createElement("canvas");
      sealedCanvas.id = "landsat-jaarbak-sealed-canvas";
      sealedCanvas.width = manifest.imageSize[0];
      sealedCanvas.height = manifest.imageSize[1];
      sealedCanvas.className = "comparison-render-canvas";
      sealedCanvas.setAttribute("aria-hidden", "true");
      document.body.append(sealedCanvas);
      sealedContext = sealedCanvas.getContext("2d", { alpha: true });
      map.addSource(SEALED_SOURCE_ID, {
        type: "canvas", canvas: sealedCanvas, coordinates: manifest.coordinates, animate: false,
      });
      map.addLayer({
        id: SEALED_LAYER_ID,
        type: "raster",
        source: SEALED_SOURCE_ID,
        paint: { "raster-opacity": 0.96, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, BEFORE_LAYER);
      map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
      map.addLayer({
        id: RASTER_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: { "raster-opacity": 0.72, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, BEFORE_LAYER);
    }
    await draw();
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
      if (map.getLayer(SEALED_LAYER_ID)) map.removeLayer(SEALED_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      if (map.getSource(SEALED_SOURCE_ID)) map.removeSource(SEALED_SOURCE_ID);
      canvas?.remove();
      sealedCanvas?.remove();
      canvas = null;
      outputContext = null;
      sealedCanvas = null;
      sealedContext = null;
      loadError = null;
      renderedScopeKey = "";
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
        await mount();
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
        // The faint JaarBAK base renders sealed pixels only. Keep that visual
        // key separate from the thermal scale and do not imply that unsealed
        // pixels receive a second map colour.
        comparisonLegend: {
          title: t("soilComparison.baseLegendTitle"),
          items: [{ label: t("soilComparison.sealed"), color: "#a11d2f" }],
        },
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
