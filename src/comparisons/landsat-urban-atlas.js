import { t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { loadImageData, safeAsset } from "./sealed-urban-shared.js";
import { comparisonHeatGradient, comparisonLegendItems } from "./thermal-palette.js";

const RASTER_LAYER_ID = "landsat-urban-atlas-temperature";
const OUTLINE_LAYER_ID = "landsat-urban-atlas-selected-surfaces";
const URBAN_ATLAS_FILL = "urban-atlas-fill";
const URBAN_ATLAS_SOURCE = "urban-atlas";
const BEFORE_LAYER = "heat-sectors-hit-area";

export function validateComparisonManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 3 || manifest.comparisonId !== "landsat-urban-atlas"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "urban-atlas") {
    throw new TypeError("Unsupported Landsat-Urban Atlas comparison manifest.");
  }
  if (!Array.isArray(manifest.defaultSeries) || manifest.maximumSeries !== 4
    || !Array.isArray(manifest.coordinates) || manifest.coordinates.length !== 4
    || !manifest.observations || !Array.isArray(manifest.classes) || !Array.isArray(manifest.families)
    || !manifest.urbanAtlasClassMaskUrl || !manifest.urbanAtlasClassIndexes
    || !Object.values(manifest.observations).every((item) => item.displayDataUrl && item.distributionUrl)) {
    throw new TypeError("The comparison manifest is incomplete.");
  }
  return manifest;
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

function selectedClassIndexes(manifest, selected) {
  return selectedClassCodes(manifest, selected)
    .map((code) => manifest.urbanAtlasClassIndexes[code])
    .filter(Boolean);
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

/**
 * Temperature is composed through the exact indexed Urban Atlas mask. The
 * distributions area-weight the same polygons while retaining native 30 m
 * Landsat temperatures as their measurement source.
 */
export function createLandsatUrbanAtlasComparison({ descriptor, landsatLayer, urbanAtlasLayer, urbanAtlas }) {
  let manifest;
  let manifestPromise;
  let active = false;
  let map;
  let municipality = "";
  let selected = new Set();
  let displayData;
  let scopeData;
  let loadedObservation = "";
  let generation = 0;
  const expandedFamilies = new Set();
  const distributionCache = new Map();
  const resolvedDistributions = new Map();
  const listeners = new Set();
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });

  const notify = () => listeners.forEach((listener) => listener());
  const activeObservationId = () => landsatLayer.getOption("observation");
  const ensureManifest = async () => {
    if (manifest) return manifest;
    manifestPromise ??= fetch(descriptor.manifestUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
      const loaded = validateComparisonManifest(await response.json());
      loaded.scopeIndexUrl = safeAsset(descriptor.assetRoot, loaded.scopeIndexUrl, ".png");
      loaded.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, loaded.urbanAtlasClassMaskUrl, ".pmtiles");
      Object.values(loaded.observations).forEach((observation) => {
        observation.displayDataUrl = safeAsset(descriptor.assetRoot, observation.displayDataUrl, ".png");
        observation.distributionUrl = safeAsset(descriptor.assetRoot, observation.distributionUrl, ".json.gz");
      });
      selected = new Set(loaded.defaultSeries);
      return loaded;
    }).then((loaded) => { manifest = loaded; return loaded; });
    return manifestPromise;
  };

  const loadDistribution = async (observationId) => {
    if (!distributionCache.has(observationId)) {
      distributionCache.set(observationId,
        fetchJsonAsset(manifest.observations[observationId].distributionUrl, "Comparison distribution")
          .then((loaded) => { resolvedDistributions.set(observationId, loaded); return loaded; }));
    }
    return distributionCache.get(observationId);
  };

  const loadObservation = async () => {
    await ensureManifest();
    const observationId = activeObservationId();
    if (loadedObservation !== observationId) {
      displayData = await loadImageData(manifest.observations[observationId].displayDataUrl, manifest.imageSize);
      loadedObservation = observationId;
    }
    scopeData ??= await loadImageData(manifest.scopeIndexUrl, manifest.imageSize);
    await loadDistribution(observationId);
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

  const render = async () => {
    if (!active || !displayData) return false;
    const request = ++generation;
    const observationId = activeObservationId();
    const shown = await exactRaster.show(map, {
      mode: "temperature",
      urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedClassIndexes(manifest, selected),
      temperatureData: displayData,
      dataBounds: boundsFromCoordinates(manifest.coordinates),
      dataSize: manifest.imageSize,
      scopeData,
      scopeIndex: municipality ? manifest.municipalityIndexes[municipality] : 0,
    });
    if (!active || request !== generation || observationId !== activeObservationId()) return false;
    updateSurfaceFilter();
    notify();
    return shown;
  };

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return false;
    return render();
  };

  const mount = async () => {
    await urbanAtlasLayer.mount(map, { beforeLayerId: BEFORE_LAYER });
    urbanAtlasLayer.setVisible(map, true);
    map.setPaintProperty(URBAN_ATLAS_FILL, "fill-opacity", .10);
    if (!map.getLayer(OUTLINE_LAYER_ID)) {
      const colors = manifest.classes.flatMap((item) => [item.code, item.color]);
      map.addLayer({
        id: OUTLINE_LAYER_ID,
        type: "line",
        source: URBAN_ATLAS_SOURCE,
        filter: ["==", ["get", "classCode"], "__none__"],
        paint: {
          "line-color": ["match", ["to-string", ["get", "classCode"]], ...colors, "#ffffff"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, .45, 15, 1.25],
          "line-opacity": .62,
        },
      }, BEFORE_LAYER);
    }
    return refresh();
  };

  const api = {
    id: "landsat-urban-atlas",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "urban-atlas",
    isActive: () => active,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
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
      return true;
    },
    deactivate() {
      if (!active || !map) return;
      active = false;
      generation += 1;
      exactRaster.remove();
      if (map.getLayer(OUTLINE_LAYER_ID)) map.removeLayer(OUTLINE_LAYER_ID);
      urbanAtlasLayer.setVisible(map, false);
      if (map.getLayer(URBAN_ATLAS_FILL)) map.setPaintProperty(URBAN_ATLAS_FILL, "fill-opacity", urbanAtlas.opacity ?? .68);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
    async setMunicipality(value = "") {
      municipality = value;
      if (active) await render();
      return true;
    },
    toggleSeries(key) {
      if (!manifest) return { changed: false };
      const result = updateSurfaceSelection(manifest, selected, key);
      if (!result.changed) return result;
      selected = new Set(result.selected);
      render().catch(console.error);
      notify();
      return result;
    },
    toggleFamilyDisclosure(id) {
      if (expandedFamilies.has(id)) expandedFamilies.delete(id);
      else expandedFamilies.add(id);
      notify();
    },
    async inspectPoint(point) {
      const mask = await exactRaster.inspectMask(point);
      if (!mask) return { unavailable: true };
      const status = displayData?.data[mask.dataOffset + 3];
      const codeValue = displayData?.data[mask.dataOffset] * 256 + displayData?.data[mask.dataOffset + 1];
      const code = Object.entries(manifest.urbanAtlasClassIndexes)
        .find(([, index]) => index === mask.urbanClassIndex)?.[0];
      return {
        status,
        temperature: status === 255 && codeValue ? codeValue / 100 - 100 : null,
        classCode: code,
        acquiredAt: landsatLayer.getRuntimeData().observation?.acquiredAt,
      };
    },
    getPointPopupModel(result) {
      if (!result || result.unavailable) return { title: t("comparison.title"), lines: [t("comparison.noScopeData")] };
      const lines = [t("comparison.pointSurface", { surface: t(`urbanAtlas.class.${result.classCode}`) })];
      lines.push(result.status === 255
        ? t("comparison.pointTemperature", { value: result.temperature.toFixed(1) })
        : t("landsat.cloudLegend"));
      return { title: t("comparison.pointTitle"), subtitle: landsatLayer.getRuntimeData().observation?.localLabel, lines };
    },
    getLegendModel() {
      if (!manifest) return landsatLayer.getLegendModel();
      return {
        ...landsatLayer.getLegendModel(),
        groups: [
          { items: comparisonLegendItems() },
          { items: [{ label: t("landsat.cloudLegend"), color: "repeating-linear-gradient(45deg,#7e878b 0 3px,#c2c9cb 3px 6px)" }] },
        ],
        title: t("comparison.legendTitle"),
        note: t("comparison.exactMaskNote"),
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
        observation: landsatLayer.getRuntimeData().observation,
      };
    },
    getLabel: () => t("comparison.title"),
    getContext() {
      const runtime = landsatLayer.getRuntimeData();
      return {
        meta: t("comparison.contextMeta"),
        text: t("comparison.contextText"),
        sources: [
          productLink("landsat", runtime.manifest?.source?.productUrl),
          productLink("urbanAtlas", urbanAtlas?.source?.productUrl),
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
        template: "landsat-urban-atlas-comparison",
        record,
        urbanAtlas: shared.urbanAtlas,
        manifest,
        landsatManifest: runtime.manifest,
        observation: runtime.observation,
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
