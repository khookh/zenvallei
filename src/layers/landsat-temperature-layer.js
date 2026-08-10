import { formatNumber, getLanguage, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { defineLayer } from "./layer-contract.js";
import { authorityLink, authorityName } from "../source-authorities.js";
import { createTemporalPmtilesMap } from "./temporal-pmtiles-layer.js";

const DATASET_ID = "landsat-temperature";

export function localDateTime(value, dateOnly = false) {
  if (!value) return "";
  return new Intl.DateTimeFormat(getLanguage() === "nl" ? "nl-BE" : "en-GB", dateOnly
    ? { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Brussels" }
    : {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        timeZone: "Europe/Brussels", timeZoneName: "short",
      }).format(new Date(value));
}

const heatwaveItems = (items = []) => items.filter(({ kind }) => kind === "heatwave");

function validateDescriptor(descriptor) {
  if (!descriptor || descriptor.datasetId !== DATASET_ID) throw new TypeError("Invalid Landsat catalogue descriptor.");
  if (!heatwaveItems(descriptor.timelineItems).length) throw new TypeError("The Landsat timeline is empty.");
  if (!heatwaveItems(descriptor.timelineItems).some(({ value }) => value === descriptor.defaultObservation)) {
    throw new TypeError("The default Landsat observation is absent from the timeline.");
  }
  return descriptor;
}

export function validateLandsatManifest(manifest) {
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || manifest.datasetId !== DATASET_ID) {
    throw new TypeError("Unsupported Landsat temperature manifest.");
  }
  if (!Array.isArray(manifest.timelineItems) || !manifest.timelineItems.length || !manifest.observations) {
    throw new TypeError("The Landsat temperature manifest has no observations.");
  }
  const timeline = heatwaveItems(manifest.timelineItems);
  for (const item of timeline) {
    const observation = manifest.observations[item.value];
    if (!observation?.pmtilesVariants?.all
      || Object.keys(observation.sectorStats ?? {}).length !== 154
      || Object.keys(observation.municipalityStats ?? {}).length !== 7
      || !observation.regionStats) {
      throw new TypeError(`Landsat observation '${item.value}' is incomplete.`);
    }
  }
  return {
    ...manifest,
    schemaVersion: 2,
    timelineItems: timeline,
    observations: Object.fromEntries(timeline.map((item) => [item.value, manifest.observations[item.value]])),
  };
}

async function fetchManifest(descriptor) {
  const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`landsat-temperature: manifest HTTP ${response.status}.`);
  const manifest = validateLandsatManifest(await response.json());
  Object.values(manifest.observations).forEach((observation) => {
    Object.entries(observation.pmtilesVariants).forEach(([key, value]) => {
      if (/^[a-z0-9/_-]+\.pmtiles$/i.test(value)) observation.pmtilesVariants[key] = `${descriptor.assetRoot}${value}`;
    });
    if (/^[a-z0-9/_-]+\.tif$/i.test(observation.queryRaster ?? "")) {
      observation.queryRaster = `${descriptor.assetRoot}${observation.queryRaster}`;
    }
  });
  return manifest;
}

const staticRasterCache = new Map();

async function loadStaticQueryRaster(url, signal) {
  if (staticRasterCache.has(url)) return staticRasterCache.get(url);
  const promise = Promise.all([import("geotiff"), import("proj4")]).then(async ([geotiff, proj4Module]) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Landsat query raster HTTP ${response.status}.`);
    const tiff = await geotiff.fromArrayBuffer(await response.arrayBuffer());
    const image = await tiff.getImage();
    const rasters = await image.readRasters({ samples: [0, 1, 2] });
    await tiff.close?.();
    const project = proj4Module.default;
    project.defs("EPSG:32631", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs");
    return {
      width: image.getWidth(), height: image.getHeight(), bounds: image.getBoundingBox(),
      temperature: rasters[0], status: rasters[1], uncertainty: rasters[2], project,
    };
  }).catch((error) => {
    staticRasterCache.delete(url);
    throw error;
  });
  staticRasterCache.set(url, promise);
  while (staticRasterCache.size > 2) staticRasterCache.delete(staticRasterCache.keys().next().value);
  return promise;
}

async function queryStaticRaster(observation, point, signal) {
  const raster = await loadStaticQueryRaster(observation.queryRaster, signal);
  const [easting, northing] = raster.project("EPSG:4326", "EPSG:32631", [point.lng, point.lat]);
  const [minx, miny, maxx, maxy] = raster.bounds;
  if (easting < minx || easting >= maxx || northing < miny || northing >= maxy) return { status: "outside" };
  const column = Math.floor((easting - minx) / ((maxx - minx) / raster.width));
  const row = Math.floor((maxy - northing) / ((maxy - miny) / raster.height));
  const index = row * raster.width + column;
  const status = Math.round(raster.status[index]);
  if (status === 1) {
    return { status: "clear", temperatureC: raster.temperature[index], uncertaintyK: raster.uncertainty[index] };
  }
  return { status: status === 2 ? "cloud" : "missing" };
}

function observationFor(manifest, descriptor, id) {
  return manifest?.observations?.[id]
    ?? descriptor.timelineItems.find(({ value }) => value === id)
    ?? null;
}

function scopedStats(observation, record) {
  if (!observation) return null;
  if (record.scope === "region") return observation.regionStats;
  if (record.scope === "municipality") return observation.municipalityStats?.[record.municipality];
  return observation.sectorStats?.[record.sectorId];
}

function kindLabel(kind) {
  return t(kind === "heatwave" ? "landsat.kindHeatwave" : "landsat.kindReference");
}

function timelineItems(items) {
  return items.map((item) => ({
    ...item,
    label: `${localDateTime(item.acquiredAt)} · ${kindLabel(item.kind)}`,
    ariaLabel: t("landsat.timelineItem", {
      date: localDateTime(item.acquiredAt),
      kind: kindLabel(item.kind),
    }),
  }));
}

export function createLandsatTemperatureLayer({ descriptor: inputDescriptor, loadManifest = fetchManifest }) {
  let descriptor;
  let manifest = null;
  let manifestPromise = null;
  let loadError = "";
  try {
    const checked = validateDescriptor(inputDescriptor);
    descriptor = { ...checked, timelineItems: heatwaveItems(checked.timelineItems) };
  } catch (error) {
    loadError = error.message;
    descriptor = { timelineItems: [], defaultObservation: null, available: false, source: {} };
  }
  let activeObservation = descriptor.defaultObservation;
  let activeMunicipality = "";

  const ensureManifest = async () => {
    if (manifest) return manifest;
    if (loadError) throw new Error(loadError);
    if (!manifestPromise) {
      manifestPromise = loadManifest(descriptor)
        .then((loaded) => { manifest = validateLandsatManifest(loaded); return manifest; })
        .catch((error) => { loadError = error.message; manifestPromise = null; throw error; });
    }
    return manifestPromise;
  };
  const current = () => observationFor(manifest, descriptor, activeObservation);
  const archiveUrl = () => current()?.pmtilesVariants?.[activeMunicipality || "all"]
    ?? current()?.pmtilesVariants?.all;
  const mapLayer = createTemporalPmtilesMap({
    layerId: "landsat-temperature-raster",
    sourceId: "landsat-temperature-source",
    opacity: descriptor.opacity ?? 0.76,
    getArchiveUrl: archiveUrl,
  });

  return defineLayer({
    id: DATASET_ID,
    categoryId: "heat",
    supportsMunicipalitySummary: true,
    supportsRegionSummary: true,
    isAvailable: () => Boolean(descriptor.available !== false && !loadError),
    getUnavailableReasonKey: () => loadError ? "landsat.loadError" : "landsat.unavailable",
    getLabel: () => t("layers.landsatTemperature"),
    getContext: () => ({
      meta: t("landsat.contextMeta", {
        date: localDateTime(current()?.acquiredAt),
        kind: kindLabel(current()?.kind),
      }),
      text: t("landsat.contextText"),
      note: t("landsat.missing2025"),
      sources: [authorityLink("landsat", manifest?.source?.productUrl ?? descriptor?.source?.productUrl)],
    }),
    getLegendModel: () => ({
      title: t("landsat.legendTitle", { date: localDateTime(current()?.acquiredAt) }),
      note: "15-50 °C",
      footnote: t("landsat.legendFootnote"),
      layout: "scale",
      groups: [{
        items: (manifest?.scale?.stops ?? [
          { position: 0, color: "#000004" }, { position: 0.29, color: "#4a0c6b" },
          { position: 0.57, color: "#a52c60" }, { position: 0.86, color: "#ed6925" },
          { position: 1, color: "#fcffa4" },
        ]).map(({ position, color }) => ({
          label: String(Math.round(15 + position * 35)), color, value: String(Math.round(15 + position * 35)),
        })),
      }, {
        items: [{ label: t("landsat.cloudLegend"), color: "repeating-linear-gradient(45deg,#7e878b 0 3px,#c2c9cb 3px 6px)" }],
      }],
    }),
    getPopupModel: (feature, record) => {
      const observation = current();
      const stats = scopedStats(observation, record);
      return {
        title: feature.properties.sectorName,
        subtitle: `${localDateTime(observation?.acquiredAt)} · ${kindLabel(observation?.kind)}`,
        lines: stats?.medianC == null ? [t("landsat.noClearData")] : [
          `${t("landsat.median")}: ${formatNumber(stats.medianC, 1)} °C`,
          `${t("landsat.clearCoverage")}: ${formatNumber(stats.clearPercentage, 1)}%`,
        ],
      };
    },
    getPanelModel: (record) => ({
      template: "landsat-temperature",
      record,
      manifest,
      observation: current(),
      stats: scopedStats(current(), record),
    }),
    getTemporalControl: () => {
      const items = timelineItems(manifest?.timelineItems ?? descriptor.timelineItems);
      const active = items.find(({ value }) => value === activeObservation);
      return {
        optionName: "observation",
        items,
        activeValue: activeObservation,
        label: t("landsat.timelineLabel"),
        note: t("landsat.timelineNote", { date: localDateTime(active?.acquiredAt), kind: kindLabel(active?.kind) }),
        auxiliaryNote: t("landsat.missing2025"),
        previousLabel: t("landsat.previousObservation"),
        nextLabel: t("landsat.nextObservation"),
      };
    },
    getAnalysisTargets: () => ["urban-atlas", "jaarbak"],
    getRuntimeData: () => ({ manifest, observation: current() }),
    async inspectPoint(point, { signal } = {}) {
      if (current()?.queryRaster) {
        return { ...(await queryStaticRaster(current(), point, signal)), acquiredAt: current()?.acquiredAt };
      }
      if (import.meta.env.MODE !== "local-data") throw new Error("The Landsat pixel-query derivative is unavailable.");
      const parameters = new URLSearchParams({
        observation: activeObservation,
        lng: String(point.lng),
        lat: String(point.lat),
      });
      const response = await fetch(`${import.meta.env.BASE_URL}__local-data-query__/landsat-temperature?${parameters}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`Landsat pixel query HTTP ${response.status}.`);
      return { ...(await response.json()), acquiredAt: current()?.acquiredAt };
    },
    getPointPopupModel(result) {
      const status = result?.status;
      const value = status === "clear" && Number.isFinite(result.temperatureC)
        ? `${formatNumber(result.temperatureC, 1)} °C`
        : t(`landsat.pixelStatus.${["cloud", "missing", "outside"].includes(status) ? status : "missing"}`);
      return {
        title: t("landsat.pixelTitle"),
        subtitle: localDateTime(result?.acquiredAt ?? current()?.acquiredAt),
        lines: [value, t("landsat.pixelResolution")],
      };
    },
    async mount(map, context) {
      await ensureManifest();
      return mapLayer.mount(map, context);
    },
    setVisible(_map, visible) { mapLayer.setVisible(visible); },
    applyFilter(_map, _filter, context = {}) {
      activeMunicipality = context.municipality ?? "";
      mapLayer.refresh();
    },
    setOption(_map, name, value) {
      if (name !== "observation" || !(manifest?.timelineItems ?? descriptor.timelineItems).some((item) => item.value === value)) return false;
      activeObservation = value;
      return mapLayer.refresh();
    },
    getOption: (name) => name === "observation" ? activeObservation : null,
    getAttributions() {
      const source = manifest?.source ?? descriptor.source;
      const productUrl = safeExternalUrl(source?.productUrl);
      return productUrl ? [`<a href="${escapeHtml(productUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(authorityName("landsat"))}</a>`] : [];
    },
  });
}
