import { formatNumber, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { defineLayer } from "./layer-contract.js";
import { authorityLink, authorityName } from "../source-authorities.js";
import { createTemporalPmtilesMap } from "./temporal-pmtiles-layer.js";

const DATASET_ID = "landgebruik";
const YEARS = Object.freeze([2019, 2022, 2025]);
const PARCEL_SOURCE = "landgebruik-agpa-source";
const PARCEL_FILL = "landgebruik-agpa-fill";
const PARCEL_OUTLINE = "landgebruik-agpa-outline";

function validParcelStatistic(value) {
  return value && Number.isFinite(value.completeAreaHa) && value.completeAreaHa > 0
    && Number.isFinite(value.parcelAreaHa) && value.parcelAreaHa >= 0
    && Number.isFinite(value.parcelPercentage) && value.parcelPercentage >= 0 && value.parcelPercentage <= 100
    && Number.isInteger(value.parcelCount) && value.parcelCount >= 0
    && Array.isArray(value.cropGroups);
}

export function validateAgriculturalParcelGeojson(data) {
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
    throw new TypeError("The agricultural parcel asset is not a valid GeoJSON FeatureCollection.");
  }
  if (data.features.some((feature) => !feature?.properties?.sectorId
    || !feature?.properties?.municipality || !feature?.properties?.cropGroup
    || !["Polygon", "MultiPolygon"].includes(feature?.geometry?.type)
    || Object.values(feature.properties).some((value) => typeof value === "number" && !Number.isFinite(value)))) {
    throw new TypeError("The agricultural parcel asset contains an invalid feature.");
  }
  return data;
}

export function validateLandgebruikManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.datasetId !== DATASET_ID
    || manifest.kind !== "compound-temporal") throw new TypeError("Unsupported Landgebruik manifest.");
  if (JSON.stringify(manifest.availableYears) !== JSON.stringify(YEARS) || manifest.defaultYear !== 2025) {
    throw new TypeError("Landgebruik must contain the official 2019, 2022 and 2025 sequence.");
  }
  if (!Array.isArray(manifest.classesOrScale?.items) || manifest.classesOrScale.items.length !== 19) {
    throw new TypeError("Landgebruik must contain all 19 official classes.");
  }
  YEARS.forEach((year) => {
    const entry = manifest.years?.[year];
    if (!entry?.pmtilesVariants?.all || Object.keys(entry.sectorStats ?? {}).length !== 154
      || Object.keys(entry.municipalityStats ?? {}).length !== 7) {
      throw new TypeError(`Landgebruik ${year} is incomplete.`);
    }
  });
  if (manifest.agriculturalDetail?.availableYear !== 2025 || !manifest.agriculturalDetail.geojsonUrl
    || Object.keys(manifest.agriculturalDetail.sectorStats ?? {}).length !== 154
    || Object.keys(manifest.agriculturalDetail.municipalityStats ?? {}).length !== 7) {
    throw new TypeError("The 2025 agricultural parcel detail is incomplete.");
  }
  if (![...Object.values(manifest.agriculturalDetail.sectorStats),
    ...Object.values(manifest.agriculturalDetail.municipalityStats)].every(validParcelStatistic)) {
    throw new TypeError("The 2025 agricultural parcel statistics are invalid.");
  }
  return manifest;
}

async function fetchManifest(descriptor) {
  const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`landgebruik: manifest HTTP ${response.status}.`);
  const manifest = validateLandgebruikManifest(await response.json());
  Object.values(manifest.years).forEach((year) => {
    Object.entries(year.pmtilesVariants).forEach(([key, value]) => {
      if (/^[a-z0-9/_-]+\.pmtiles$/i.test(value)) year.pmtilesVariants[key] = `${descriptor.assetRoot}${value}`;
    });
  });
  if (/^[a-z0-9/_-]+\.geojson$/i.test(manifest.agriculturalDetail.geojsonUrl)) {
    manifest.agriculturalDetail.geojsonUrl = `${descriptor.assetRoot}${manifest.agriculturalDetail.geojsonUrl}`;
  }
  return manifest;
}

function areaStats(manifest, year, record) {
  const entry = manifest?.years?.[year];
  return record.scope === "municipality"
    ? entry?.municipalityStats?.[record.municipality]
    : entry?.sectorStats?.[record.sectorId];
}

function parcelStats(manifest, record) {
  const detail = manifest?.agriculturalDetail;
  return record.scope === "municipality"
    ? detail?.municipalityStats?.[record.municipality]
    : detail?.sectorStats?.[record.sectorId];
}

function classDefinition(manifest, code) {
  return manifest?.classesOrScale?.items?.find((item) => Number(item.value) === Number(code));
}

function dominantClass(stats) {
  return stats?.classes?.reduce((best, item) => item.areaHa > (best?.areaHa ?? -1) ? item : best, null);
}

function dominantCrop(stats) {
  return stats?.cropGroups?.reduce((best, item) => item.areaHa > (best?.areaHa ?? -1) ? item : best, null);
}

export function createLandgebruikLayer({ descriptor, loadManifest = fetchManifest }) {
  let manifest = null;
  let loadPromise = null;
  let loadError = "";
  let activeYear = descriptor?.defaultYear ?? 2025;
  let activeMode = "landuse";
  let activeMunicipality = "";
  let mapReference = null;
  let mapVisible = false;
  let parcelDataPromise = null;
  let parcelDataLoaded = false;
  const mapLayer = createTemporalPmtilesMap({
    layerId: "landgebruik-raster",
    sourceId: "landgebruik-raster-source",
    opacity: descriptor?.opacity ?? 0.68,
    getArchiveUrl: () => manifest?.years?.[activeYear]?.pmtilesVariants?.[activeMunicipality || "all"]
      ?? manifest?.years?.[activeYear]?.pmtilesVariants?.all,
  });

  const ensureManifest = async () => {
    if (manifest) return manifest;
    if (!loadPromise) loadPromise = loadManifest(descriptor).then((value) => {
      manifest = validateLandgebruikManifest(value);
      return manifest;
    }).catch((error) => {
      loadError = error.message;
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  };

  const parcelVisibility = () => mapVisible && activeMode === "agriculture" && activeYear === 2025;
  const ensureParcelData = () => {
    if (parcelDataLoaded) return Promise.resolve(true);
    if (parcelDataPromise) return parcelDataPromise;
    parcelDataPromise = fetch(manifest.agriculturalDetail.geojsonUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`agpa-2025.geojson: HTTP ${response.status}`);
        const data = validateAgriculturalParcelGeojson(await response.json());
        mapReference?.getSource(PARCEL_SOURCE)?.setData(data);
        parcelDataLoaded = true;
        return true;
      })
      .catch((error) => {
        loadError = error.message;
        parcelDataPromise = null;
        throw error;
      });
    return parcelDataPromise;
  };
  const updateVisibility = () => {
    mapLayer.setVisible(mapVisible && activeMode === "landuse");
    [PARCEL_FILL, PARCEL_OUTLINE].forEach((id) => {
      if (mapReference?.getLayer(id)) mapReference.setLayoutProperty(id, "visibility", parcelVisibility() ? "visible" : "none");
    });
  };

  return defineLayer({
    id: DATASET_ID,
    categoryId: "land-green",
    supportsMunicipalitySummary: true,
    isAvailable: () => Boolean(descriptor?.available !== false && !loadError),
    getUnavailableReasonKey: () => loadError ? "landgebruik.loadError" : "landgebruik.unavailable",
    getLabel: () => t("layers.landgebruik"),
    getDatasetStatus: () => t("dataset.readyLandgebruik", { year: activeYear }),
    getContext: () => ({
      meta: t("landgebruik.contextMeta", { year: activeYear }),
      text: t(activeMode === "agriculture" ? "landgebruik.agricultureContext" : "landgebruik.contextText"),
      note: activeMode === "landuse" ? t("landgebruik.temporalNote") : "",
      sources: [authorityLink(
        activeMode === "agriculture" ? "agricultureFisheries" : "departmentEnvironment",
        activeMode === "agriculture"
          ? manifest?.agriculturalDetail?.source?.url
          : manifest?.source?.url ?? descriptor?.source?.url,
      )],
    }),
    getLegendModel: () => activeMode === "agriculture" ? {
      title: t("landgebruik.agricultureLegend", { year: 2025 }),
      note: t("landgebruik.parcelScale"),
      footnote: t("landgebruik.cropDetailHint"),
      layout: "groups",
      groups: [{ items: (manifest?.agriculturalDetail?.cropGroups ?? []).map((item) => ({
        label: t(`landgebruik.cropGroup.${item.sourceLabel}`),
        color: item.color,
      })) }],
    } : {
      title: t("landgebruik.legend", { year: activeYear }),
      note: "10 m",
      footnote: t("landgebruik.legendFootnote"),
      layout: "groups",
      groups: [{ items: (manifest?.classesOrScale?.items ?? []).filter((item) => item.present !== false).map((item) => ({
        label: t(`landgebruik.class.${item.value}`), color: item.color,
      })) }],
    },
    getPopupModel: (feature, record) => {
      if (activeMode === "agriculture") {
        const stats = parcelStats(manifest, record);
        const crop = dominantCrop(stats);
        return {
          title: feature.properties.sectorName,
          subtitle: t("landgebruik.agriculture2025"),
          lines: crop ? [
            `${t("landgebruik.parcelShareHeadline")}: ${formatNumber(stats.parcelPercentage, 1)}%`,
            `${t("landgebruik.dominantCropGroup")}: ${t(`landgebruik.cropGroup.${crop.sourceLabel}`)}`,
            `${formatNumber(crop.percentage, 1)}% ${t("landgebruik.ofParcelArea")}`,
          ] : [t("landgebruik.noParcels")],
        };
      }
      const stats = areaStats(manifest, activeYear, record);
      const dominant = dominantClass(stats);
      const definition = classDefinition(manifest, dominant?.code);
      return {
        title: feature.properties.sectorName,
        subtitle: t("landgebruik.referenceYear", { year: activeYear }),
        lines: dominant ? [
          `${t("landgebruik.dominantClass")}: ${t(`landgebruik.class.${definition?.value}`)}`,
          `${formatNumber(dominant.percentage, 1)}%`,
        ] : [t("officialData.noData")],
      };
    },
    getPanelModel: (record) => ({
      template: "landgebruik",
      record,
      manifest,
      year: activeYear,
      mode: activeMode,
      stats: areaStats(manifest, activeYear, record),
      parcelStats: parcelStats(manifest, record),
    }),
    getTemporalControl: () => ({
      optionName: "year",
      values: YEARS,
      activeValue: activeYear,
      label: t("officialData.referenceYearLabel"),
      note: t("landgebruik.temporalNote"),
      previousLabel: t("officialData.previousYear"),
      nextLabel: t("officialData.nextYear"),
    }),
    getSecondaryControl: () => ({
      id: "landgebruik-mode",
      optionName: "landgebruik-mode",
      ariaLabel: t("landgebruik.modeLabel"),
      prompt: t("landgebruik.modePrompt"),
      options: [
        { id: "landuse", label: t("landgebruik.modeLanduse"), active: activeMode === "landuse" },
        {
          id: "agriculture", label: t("landgebruik.modeAgriculture"), active: activeMode === "agriculture",
          disabled: activeYear !== 2025, disabledReason: t("landgebruik.agricultureOnly2025"),
        },
      ],
    }),
    async mount(map, context) {
      mapReference = map;
      await ensureManifest();
      await mapLayer.mount(map, context);
      if (!map.getSource(PARCEL_SOURCE)) {
        map.addSource(PARCEL_SOURCE, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: PARCEL_FILL, type: "fill", source: PARCEL_SOURCE,
          paint: { "fill-color": ["coalesce", ["get", "color"], "#8f8f8f"], "fill-opacity": 0.72 },
          layout: { visibility: "none" },
        }, context.beforeLayerId);
        map.addLayer({
          id: PARCEL_OUTLINE, type: "line", source: PARCEL_SOURCE,
          paint: {
            "line-color": "rgba(8,47,54,0.62)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.3, 15, 1],
          },
          layout: { visibility: "none" },
        }, context.beforeLayerId);
      }
      updateVisibility();
      return true;
    },
    setVisible(_map, visible) { mapVisible = visible; updateVisibility(); },
    applyFilter(map, _filter, context = {}) {
      activeMunicipality = context.municipality ?? "";
      mapLayer.refresh();
      const parcelFilter = activeMunicipality ? ["==", ["get", "municipality"], activeMunicipality] : null;
      [PARCEL_FILL, PARCEL_OUTLINE].forEach((id) => { if (map.getLayer(id)) map.setFilter(id, parcelFilter); });
    },
    setOption(_map, name, value) {
      if (name === "year") {
        const year = Number(value);
        if (!YEARS.includes(year)) return false;
        activeYear = year;
        if (year !== 2025 && activeMode === "agriculture") activeMode = "landuse";
        mapLayer.refresh();
        updateVisibility();
        return true;
      }
      if (name === "landgebruik-mode") {
        if (!["landuse", "agriculture"].includes(value) || (value === "agriculture" && activeYear !== 2025)) return false;
        activeMode = value;
        if (activeMode === "agriculture") void ensureParcelData().catch(() => {});
        updateVisibility();
        return true;
      }
      return false;
    },
    getOption(name) {
      if (name === "year") return activeYear;
      if (name === "landgebruik-mode") return activeMode;
      return null;
    },
    inspectFeature(map, event) {
      if (!parcelVisibility() || !map.getLayer(PARCEL_FILL)) return null;
      const parcel = map.queryRenderedFeatures(event.point, { layers: [PARCEL_FILL] })[0];
      if (!parcel) return null;
      const properties = parcel.properties;
      const cropGroup = properties.cropGroup
        ? t(`landgebruik.cropGroup.${properties.cropGroup}`)
        : t("landgebruik.unknownCrop");
      return {
        title: properties.maincrop_title || t("landgebruik.unknownCrop"),
        subtitle: t("landgebruik.parcelPopupSubtitle", { group: cropGroup }),
        lines: [
          `${t("landgebruik.parcelArea")}: ${formatNumber(Number(properties.area_ha), 2)} ha`,
          properties.productionmethod_title ? `${t("landgebruik.productionMethod")}: ${properties.productionmethod_title}` : t("landgebruik.noAdditionalParcelInfo"),
        ],
      };
    },
    getAttributions() {
      const urls = [
        [manifest?.source?.url ?? descriptor?.source?.url, authorityName("departmentEnvironment")],
        [manifest?.agriculturalDetail?.source?.url, authorityName("agricultureFisheries")],
      ];
      return urls.flatMap(([url, label]) => safeExternalUrl(url)
        ? [`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`]
        : []);
    },
  });
}
