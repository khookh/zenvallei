import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems, thermalColor } from "./thermal-palette.js";

const SOURCE_ID = "landsat-urban-atlas-canvas";
const RASTER_LAYER_ID = "landsat-urban-atlas-temperature";
const OUTLINE_LAYER_ID = "landsat-urban-atlas-selected-surfaces";
const URBAN_ATLAS_FILL = "urban-atlas-fill";
const URBAN_ATLAS_SOURCE = "urban-atlas";
const BEFORE_LAYER = "heat-sectors-hit-area";

function resolveAsset(root, value, extension) {
  if (typeof value !== "string" || value.includes("..") || !value.endsWith(extension)) {
    throw new TypeError(`Unsafe comparison asset '${value}'.`);
  }
  return `${root}${value}`;
}

export function validateComparisonManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "landsat-urban-atlas"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "urban-atlas") {
    throw new TypeError("Unsupported Landsat-Urban Atlas comparison manifest.");
  }
  if (!Array.isArray(manifest.defaultSeries) || manifest.maximumSeries !== 4
    || !Array.isArray(manifest.coordinates) || manifest.coordinates.length !== 4
    || !manifest.observations || !Array.isArray(manifest.classes) || !Array.isArray(manifest.families)) {
    throw new TypeError("The comparison manifest is incomplete.");
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

function selectedClassIndexes(manifest, selected) {
  const classByCode = new Map(manifest.classes.map((item) => [item.code, item.index]));
  const selectedIndexes = new Set();
  selected.forEach((key) => {
    const definition = key.startsWith("family:")
      ? manifest.families.find((item) => item.key === key)
      : manifest.classes.find((item) => item.key === key);
    (definition?.codes ?? [definition?.code]).filter(Boolean).forEach((code) => selectedIndexes.add(classByCode.get(code)));
  });
  return selectedIndexes;
}

function selectedClassCodes(manifest, selected) {
  const result = new Set();
  selected.forEach((key) => {
    const definition = key.startsWith("family:")
      ? manifest.families.find((item) => item.key === key)
      : manifest.classes.find((item) => item.key === key);
    (definition?.codes ?? [definition?.code]).filter(Boolean).forEach((code) => result.add(code));
  });
  return [...result];
}

function seriesLabel(definition) {
  return definition.type === "family"
    ? t(`comparison.family.${definition.id}`)
    : t(`urbanAtlas.class.${definition.code}`);
}

export function updateSurfaceSelection(manifest, current, key) {
  const selected = new Set(current);
  const definition = [...manifest.families, ...manifest.classes].find((item) => item.key === key);
  if (!definition) return { selected: [...selected], changed: false };
  if (selected.has(key)) {
    selected.delete(key);
    return { selected: [...selected], changed: true };
  }
  const conflicting = definition.type === "family"
    ? manifest.classes.filter((item) => definition.codes.includes(item.code)).map((item) => item.key)
    : manifest.families.filter((item) => item.codes.includes(definition.code)).map((item) => item.key);
  conflicting.forEach((item) => selected.delete(item));
  if (selected.size >= manifest.maximumSeries) return { selected: [...current], changed: false, limit: true };
  selected.add(key);
  return { selected: [...selected], changed: true };
}

export function createLandsatUrbanAtlasComparison({ descriptor, landsatLayer, urbanAtlasLayer, urbanAtlas }) {
  let manifest;
  let manifestPromise;
  let active = false;
  let map;
  let canvas;
  let outputContext;
  let scopeData;
  let municipality = "";
  let selected = new Set();
  const expandedFamilies = new Set();
  const pixelCache = new Map();
  const distributionCache = new Map();
  const resolvedDistributions = new Map();
  const listeners = new Set();

  const notify = () => listeners.forEach((listener) => listener());
  const ensureManifest = async () => {
    if (manifest) return manifest;
    manifestPromise ??= fetch(descriptor.manifestUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
      const loaded = validateComparisonManifest(await response.json());
      loaded.scopeIndexUrl = resolveAsset(descriptor.assetRoot, loaded.scopeIndexUrl, ".png");
      Object.values(loaded.observations).forEach((observation) => {
        observation.pixelDataUrl = resolveAsset(descriptor.assetRoot, observation.pixelDataUrl, ".png");
        observation.distributionUrl = resolveAsset(descriptor.assetRoot, observation.distributionUrl, ".json");
      });
      selected = new Set(loaded.defaultSeries);
      return loaded;
    }).then((loaded) => { manifest = loaded; return loaded; });
    return manifestPromise;
  };
  const activeObservationId = () => landsatLayer.getOption("observation");
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

  const updateSurfaceFilter = () => {
    if (!map?.getLayer(OUTLINE_LAYER_ID) || !map?.getLayer(URBAN_ATLAS_FILL)) return;
    const codes = selectedClassCodes(manifest, selected);
    const classFilter = codes.length
      ? ["in", ["to-string", ["get", "classCode"]], ["literal", codes]]
      : ["==", ["get", "classCode"], "__none__"];
    const filter = municipality ? ["all", classFilter, ["==", ["get", "municipality"], municipality]] : classFilter;
    map.setFilter(URBAN_ATLAS_FILL, filter);
    map.setFilter(OUTLINE_LAYER_ID, filter);
  };

  const draw = async () => {
    if (!active || !manifest || !outputContext) return;
    const observationId = activeObservationId();
    const [pixels, scopes] = await Promise.all([
      loadPixels(observationId),
      scopeData ??= loadImageData(manifest.scopeIndexUrl, manifest.imageSize),
      loadDistribution(observationId),
    ]);
    if (!active || observationId !== activeObservationId()) return;
    const output = outputContext.createImageData(canvas.width, canvas.height);
    const classIndexes = selectedClassIndexes(manifest, selected);
    const municipalityIndex = municipality ? manifest.municipalityIndexes[municipality] : 0;
    for (let offset = 0, pixel = 0; offset < pixels.data.length; offset += 4, pixel += 1) {
      const inScope = !municipalityIndex || scopes.data[offset + 1] === municipalityIndex;
      if (!inScope || !classIndexes.has(pixels.data[offset + 1])) continue;
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
    updateSurfaceFilter();
    map.triggerRepaint();
    requestAnimationFrame(() => source?.pause?.());
    notify();
  };

  const mount = async () => {
    await ensureManifest();
    await urbanAtlasLayer.mount(map, { beforeLayerId: BEFORE_LAYER });
    urbanAtlasLayer.setVisible(map, true);
    map.setPaintProperty(URBAN_ATLAS_FILL, "fill-opacity", 0.18);
    if (!map.getSource(SOURCE_ID)) {
      canvas = document.createElement("canvas");
      canvas.id = "landsat-urban-atlas-comparison-canvas";
      canvas.width = manifest.imageSize[0];
      canvas.height = manifest.imageSize[1];
      canvas.className = "comparison-render-canvas";
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);
      outputContext = canvas.getContext("2d", { alpha: true });
      map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
      map.addLayer({
        id: RASTER_LAYER_ID, type: "raster", source: SOURCE_ID,
        paint: { "raster-opacity": 0.96, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, BEFORE_LAYER);
      const colors = manifest.classes.flatMap((item) => [item.code, item.color]);
      map.addLayer({
        id: OUTLINE_LAYER_ID, type: "line", source: URBAN_ATLAS_SOURCE,
        filter: ["==", ["get", "classCode"], "__none__"],
        paint: {
          "line-color": ["match", ["to-string", ["get", "classCode"]], ...colors, "#ffffff"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.45, 15, 1.25],
          "line-opacity": 0.62,
        },
      }, BEFORE_LAYER);
    }
    await draw();
  };

  const api = {
    id: "landsat-urban-atlas",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "urban-atlas",
    isActive: () => active,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      active = true;
      landsatLayer.setVisible(map, false);
      try {
        await mount();
      } catch (error) {
        active = false;
        landsatLayer.setVisible(map, true);
        throw error;
      }
      notify();
    },
    deactivate() {
      if (!active || !map) return;
      active = false;
      if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
      if (map.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      outputContext = null;
      urbanAtlasLayer.setVisible(map, false);
      if (map.getLayer(URBAN_ATLAS_FILL)) map.setPaintProperty(URBAN_ATLAS_FILL, "fill-opacity", urbanAtlas.opacity ?? 0.68);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await draw(); },
    async setMunicipality(value) {
      municipality = value ?? "";
      if (!active) return;
      await draw();
    },
    toggleSeries(key) {
      if (!manifest) return { changed: false };
      const result = updateSurfaceSelection(manifest, selected, key);
      if (!result.changed) return result;
      selected = new Set(result.selected);
      draw();
      notify();
      return result;
    },
    toggleFamilyDisclosure(id) {
      if (expandedFamilies.has(id)) expandedFamilies.delete(id);
      else expandedFamilies.add(id);
      notify();
    },
    getLegendModel() {
      if (!manifest) return landsatLayer.getLegendModel();
      const activeObservation = landsatLayer.getRuntimeData().observation;
      return {
        ...landsatLayer.getLegendModel(),
        groups: [
          { items: comparisonLegendItems() },
          { items: [{ label: t("landsat.cloudLegend"), color: "repeating-linear-gradient(45deg,#7e878b 0 3px,#c2c9cb 3px 6px)" }] },
        ],
        title: t("comparison.legendTitle"),
        note: landsatLayer.getLegendModel().title,
        gradient: comparisonHeatGradient(),
        surfaceSelector: {
          title: t("comparison.surfaceTitle"),
          help: t("comparison.surfaceHelp", { maximum: manifest.maximumSeries }),
          maximum: manifest.maximumSeries,
          selected: [...selected],
          groups: manifest.families.map((family) => ({
            id: family.id,
            title: seriesLabel(family),
            family: { ...family, label: seriesLabel(family), selected: selected.has(family.key) },
            expanded: expandedFamilies.has(family.id),
            items: manifest.classes.filter((item) => family.codes.includes(item.code))
              .map((item) => ({ ...item, label: seriesLabel(item), selected: selected.has(item.key) })),
          })),
        },
        observation: activeObservation,
      };
    },
    getLabel: () => t("comparison.title"),
    getContext() {
      const runtime = landsatLayer.getRuntimeData();
      return {
        meta: t("comparison.contextMeta"),
        text: t("comparison.contextText"),
        note: `${t("comparison.contextNote")} ${t("landsat.missing2025")}`,
        sources: [
          authorityLink("landsat", runtime.manifest?.source?.productUrl),
          authorityLink("copernicusClms", urbanAtlas?.source?.productUrl),
        ],
      };
    },
    getPanelModel(record, shared) {
      const runtime = landsatLayer.getRuntimeData();
      const distribution = resolvedDistributions.get(activeObservationId());
      const scopeId = record.scope === "region" ? "region:zennevallei"
        : record.scope === "municipality" ? `municipality:${record.municipality}`
          : `sector:${record.sectorId}`;
      const scope = distribution?.scopes?.[scopeId];
      const definitions = [...manifest.families, ...manifest.classes];
      return {
        template: "landsat-urban-atlas-comparison", record, urbanAtlas: shared.urbanAtlas,
        manifest, landsatManifest: runtime.manifest, observation: runtime.observation,
        selectedSeries: [...selected].map((key, index) => {
          const definition = definitions.find((item) => item.key === key);
          return { ...definition, label: seriesLabel(definition), dashIndex: index, stats: scope?.series?.[key] };
        }),
      };
    },
    getSelectedSeries: () => [...selected],
  };
  return api;
}
