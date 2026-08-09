/** Official raster layers prepared from validated native source grids. */
import { formatNumber, getLanguage, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { authorityLink, authorityName } from "../source-authorities.js";
import { defineLayer } from "./layer-contract.js";
import { createTemporalPmtilesMap } from "./temporal-pmtiles-layer.js";
import { createDensityMode } from "./density-mode.js";

const DATASET_CONFIG = Object.freeze({
  jaarbak: {
    id: "jaarbak",
    labelKey: "layers.jaarbak",
    contextKey: "jaarbak",
    authorityIds: ["departmentEnvironment"],
  },
  groenkaart: {
    id: "groenkaart",
    labelKey: "layers.groenkaart",
    contextKey: "groenkaart",
    authorityIds: ["natureForests", "digitalFlanders"],
  },
});
const MUNICIPALITIES = Object.freeze([
  "Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen", "Sint-Genesius-Rode", "Sint-Pieters-Leeuw",
]);
const EXPECTED_YEARS = Object.freeze({
  jaarbak: [2018, 2019, 2020, 2021, 2022, 2023, 2024],
  groenkaart: [2018, 2021],
});

const localized = (value, fallback = "") => typeof value === "string"
  ? value
  : value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;

export function validateLocalTemporalManifest(manifest, expectedId) {
  if (!manifest || ![1, 2, 3].includes(manifest.schemaVersion)) throw new TypeError(`${expectedId}: unsupported manifest schema.`);
  if (manifest.datasetId !== expectedId) throw new TypeError(`${expectedId}: dataset identifier does not match.`);
  if (!["categorical", "continuous"].includes(manifest.kind)) throw new TypeError(`${expectedId}: invalid raster kind.`);
  if (!Array.isArray(manifest.availableYears) || !manifest.availableYears.length) throw new TypeError(`${expectedId}: no years are available.`);
  if (JSON.stringify(manifest.availableYears) !== JSON.stringify(EXPECTED_YEARS[expectedId])) {
    throw new TypeError(`${expectedId}: the prepared year sequence is incomplete.`);
  }
  if (!manifest.availableYears.includes(manifest.defaultYear)) throw new TypeError(`${expectedId}: default year is unavailable.`);
  for (const year of manifest.availableYears) {
    const entry = manifest.years?.[year];
    if (!entry?.pmtilesVariants?.all || !entry.sectorStats || !entry.municipalityStats
      || Object.keys(entry.sectorStats).length !== 154
      || MUNICIPALITIES.some((name) => !entry.pmtilesVariants[name] || !entry.municipalityStats[name])) {
      throw new TypeError(`${expectedId}: year ${year} is incomplete.`);
    }
  }
  if (manifest.density) {
    if (manifest.density.schemaVersion !== 1 || manifest.density.radiusMeters !== 100
      || !manifest.density.scopeIndexUrl || !manifest.availableYears.every((year) => manifest.density.years?.[year]?.dataUrl)) {
      throw new TypeError(`${expectedId}: density metadata is incomplete.`);
    }
  }
  return manifest;
}

export function validateLocalDatasetDescriptor(descriptor, expectedId) {
  if (!descriptor || descriptor.datasetId !== expectedId) throw new TypeError(`${expectedId}: invalid local catalogue entry.`);
  if (!Array.isArray(descriptor.availableYears)
    || JSON.stringify(descriptor.availableYears) !== JSON.stringify(EXPECTED_YEARS[expectedId])) {
    throw new TypeError(`${expectedId}: the catalogue year sequence is incomplete.`);
  }
  if (!descriptor.availableYears.includes(descriptor.defaultYear)) throw new TypeError(`${expectedId}: catalogue default year is unavailable.`);
  if (!descriptor.manifestUrl || typeof descriptor.manifestUrl !== "string") throw new TypeError(`${expectedId}: manifest URL is missing.`);
  return descriptor;
}

async function fetchLocalManifest(descriptor, datasetId) {
  const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`${datasetId}: manifest HTTP ${response.status}.`);
  const manifest = validateLocalTemporalManifest(await response.json(), datasetId);
  Object.values(manifest.years ?? {}).forEach((year) => {
    Object.entries(year.pmtilesVariants ?? {}).forEach(([key, value]) => {
      if (/^[a-z0-9/_-]+\.pmtiles$/i.test(value)) year.pmtilesVariants[key] = `${descriptor.assetRoot}${value}`;
    });
  });
  if (manifest.density) {
    if (/^[a-z0-9/_-]+\.png$/i.test(manifest.density.scopeIndexUrl)) {
      manifest.density.scopeIndexUrl = `${descriptor.assetRoot}${manifest.density.scopeIndexUrl}`;
    }
    Object.values(manifest.density.years ?? {}).forEach((year) => {
      if (/^[a-z0-9/_-]+\.tif$/i.test(year.dataUrl)) year.dataUrl = `${descriptor.assetRoot}${year.dataUrl}`;
    });
  }
  return manifest;
}

function statsFor(manifest, year, record) {
  const data = manifest.years[year];
  return record.scope === "municipality"
    ? data.municipalityStats?.[record.municipality]
    : data.sectorStats?.[record.sectorId];
}

function temporalNote(manifest, year) {
  const yearData = manifest.years[year];
  if (yearData.status === "provisional") return t("officialData.provisionalYear");
  if (manifest.datasetId === "jaarbak" && year >= 2023) return t("jaarbak.methodChangeNote");
  if (yearData.note) return localized(yearData.note);
  return t("officialData.referenceYear", { year });
}

function legendModel(manifest, year, config) {
  const source = manifest.classesOrScale;
  const items = Array.isArray(source?.items) ? source.items : [];
  return {
    title: t(`${config.contextKey}.legend`, { year }),
    note: temporalNote(manifest, year),
    footnote: t("officialData.visualDerivative"),
    layout: "groups",
    groups: [{
      items: items.map((item) => ({
        label: localized(item.label, String(item.value ?? item.minimum ?? "")),
        color: item.color,
      })),
    }],
  };
}

function popupLines(config, stats, manifest) {
  if (!stats) return [t("officialData.noData")];
  if (config.id === "jaarbak") return [`${t("jaarbak.sealed")}: ${formatNumber(stats.sealedPercentage)}%`];
  const dominant = stats.classes?.reduce((best, item) => item.areaHa > (best?.areaHa ?? -1) ? item : best, null);
  const definition = manifest.classesOrScale?.items?.find((item) => String(item.value) === String(dominant?.code));
  return dominant
    ? [`${t("groenkaart.dominant")}: ${localized(definition?.label, dominant.code)} (${formatNumber(dominant.percentage)}%)`]
    : [t("officialData.noData")];
}

export function createLocalOfficialLayer({ descriptor: inputDescriptor, manifest: inputManifest, datasetId, loadManifest = fetchLocalManifest }) {
  const config = DATASET_CONFIG[datasetId];
  let descriptor;
  let manifest = null;
  let manifestPromise = null;
  let loadError = "";
  try {
    if (inputManifest) {
      manifest = validateLocalTemporalManifest(inputManifest, datasetId);
      descriptor = validateLocalDatasetDescriptor({
        datasetId,
        manifestUrl: "memory://manifest",
        assetRoot: "",
        availableYears: manifest.availableYears,
        defaultYear: manifest.defaultYear,
        kind: manifest.kind,
        opacity: manifest.opacity,
        source: manifest.source,
        density: manifest.density ? {
          available: true,
          radiusMeters: manifest.density.radiusMeters,
          availableYears: manifest.availableYears,
        } : null,
      }, datasetId);
    } else {
      descriptor = validateLocalDatasetDescriptor(inputDescriptor, datasetId);
    }
  } catch (error) {
    loadError = error.message;
    descriptor = { available: false, availableYears: [], defaultYear: null, source: {} };
  }
  const ensureManifest = async () => {
    if (manifest) return manifest;
    if (loadError) throw new Error(loadError);
    if (!manifestPromise) {
      manifestPromise = loadManifest(descriptor, datasetId)
        .then((loaded) => {
          manifest = validateLocalTemporalManifest(loaded, datasetId);
          return manifest;
        })
        .catch((error) => {
          loadError = error.message;
          manifestPromise = null;
          throw error;
        });
    }
    return manifestPromise;
  };
  let activeYear = descriptor?.defaultYear;
  let activeMunicipality = "";
  let layerVisible = false;
  const yearData = () => manifest?.years?.[activeYear];
  const archiveUrl = () => yearData()?.pmtilesVariants?.[activeMunicipality || "all"]
    ?? yearData()?.pmtilesVariants?.all;
  const mapLayer = createTemporalPmtilesMap({
    layerId: `${datasetId}-local-raster`,
    sourceId: `${datasetId}-local-source`,
    opacity: descriptor?.opacity ?? 0.68,
    getArchiveUrl: archiveUrl,
  });
  let densityMode = null;
  const ensureDensityMode = () => {
    if (!manifest?.density) return null;
    densityMode ??= createDensityMode({
      datasetId,
      getManifest: () => manifest,
      getYear: () => activeYear,
      getMunicipality: () => activeMunicipality,
      setClassificationVisible: (visible) => mapLayer.setVisible(Boolean(visible && layerVisible)),
    });
    return densityMode;
  };

  return defineLayer({
    id: config.id,
    categoryId: "land-green",
    supportsMunicipalitySummary: true,
    isAvailable: () => Boolean(descriptor?.available !== false && !loadError),
    getUnavailableReasonKey: () => loadError ? "officialData.loadError" : "officialData.unavailable",
    getLabel: () => t(config.labelKey, { year: activeYear }),
    getDatasetStatus: () => t("dataset.readyLocalRaster", { year: activeYear, resolution: descriptor?.source?.resolutionLabel ?? "" }),
    getContext: () => ({
      meta: t(`${config.contextKey}.contextMeta`, { year: activeYear }),
      text: t(`${config.contextKey}.contextText`),
      note: densityMode?.isActive()
        ? t(`${config.contextKey}.densityContext`, { year: activeYear, radius: 100 })
        : manifest ? temporalNote(manifest, activeYear) : "",
      sources: descriptor?.source?.url
        ? config.authorityIds.map((authorityId) => authorityLink(authorityId, descriptor.source.url))
        : [],
    }),
    getLegendModel: () => densityMode?.isActive()
      ? densityMode.getLegendModel()
      : legendModel(manifest, activeYear, config),
    getPopupModel: (feature, record) => ({
      title: feature.properties.sectorName,
      subtitle: feature.properties.municipality,
      lines: popupLines(config, statsFor(manifest, activeYear, record), manifest),
    }),
    getPanelModel: (record) => ({
      template: "local-official-raster",
      datasetId,
      record,
      manifest,
      year: activeYear,
      stats: statsFor(manifest, activeYear, record),
    }),
    getTemporalControl: () => ({
      optionName: "year",
      values: manifest?.availableYears ?? descriptor.availableYears,
      activeValue: activeYear,
      label: t("officialData.year"),
      note: manifest ? temporalNote(manifest, activeYear) : t("officialData.referenceYear", { year: activeYear }),
      previousLabel: t("officialData.previousYear"),
      nextLabel: t("officialData.nextYear"),
    }),
    async mount(map, context) {
      await ensureManifest();
      return mapLayer.mount(map, context);
    },
    setVisible(_map, visible) {
      layerVisible = visible;
      if (densityMode?.isActive()) densityMode.setVisible(visible);
      else mapLayer.setVisible(visible);
    },
    applyFilter(_map, _filter, context = {}) {
      activeMunicipality = context.municipality ?? "";
      if (densityMode?.isActive()) densityMode.refresh();
      else mapLayer.refresh();
    },
    setOption(_map, name, value) {
      if (name !== "year") return false;
      const year = Number(value);
      if (!descriptor?.availableYears?.includes(year)) return false;
      activeYear = year;
      if (densityMode?.isActive()) {
        densityMode.refresh();
        return true;
      }
      return mapLayer.refresh();
    },
    getOption: (name) => name === "year" ? activeYear : null,
    ensureManifest,
    getRuntimeData: () => ({ manifest, descriptor, year: activeYear, municipality: activeMunicipality }),
    getMapModeAction: () => descriptor?.density?.available && !loadError ? ({
      active: Boolean(densityMode?.isActive()),
      label: t(densityMode?.isActive() ? "density.showClassification" : "density.showDensity"),
    }) : null,
    async toggleMapMode(map) {
      await ensureManifest();
      const mode = ensureDensityMode();
      if (!mode) return false;
      await mode.toggle(map);
      return true;
    },
    toggleDensityClass(code) { return densityMode?.toggleClass(code) ?? { changed: false }; },
    isPointInspectionActive: () => Boolean(densityMode?.isActive()),
    inspectPoint: (point, context) => densityMode?.inspectPoint(point, context),
    getPointPopupModel: (result) => densityMode?.getPointPopupModel(result),
    getInspectionRadiusMeters: () => densityMode?.getInspectionRadiusMeters() ?? 0,
    subscribeMapMode(listener) {
      return ensureDensityMode()?.subscribe(listener) ?? (() => {});
    },
    setOpacity: (value) => mapLayer.setOpacity(value),
    getOpacity: () => mapLayer.getOpacity(),
    waitUntilReady: () => mapLayer.whenReady(),
    getAttributions() {
      const url = safeExternalUrl(descriptor?.source?.url);
      if (!url) return [];
      return config.authorityIds.map((authorityId) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(authorityName(authorityId))}</a>`);
    },
  });
}

export function createOfficialRasterLayers(officialLayers = {}) {
  return Object.keys(DATASET_CONFIG)
    .filter((datasetId) => officialLayers[datasetId])
    .map((datasetId) => createLocalOfficialLayer({ descriptor: officialLayers[datasetId], datasetId }));
}
