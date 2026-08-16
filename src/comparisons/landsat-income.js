import { t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { comparisonHeatGradient, comparisonLegendItems } from "./thermal-palette.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import {
  comparisonAreaRecord, comparisonPixelOffset, hideIncomeSymbols, incomeLegend, loadImageData, mountIncomeSymbols,
  combineUrbanGroupStats, hasUrbanSurfaceContract, ordinaryLeastSquares, safeAsset, SEALED_URBAN_SOURCE_URLS,
  sectorPointLabel, selectedUrbanClassIndexes, summarizeIncomeCategories, urbanSurfaceSelector,
  validateSpatialInference,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "landsat-income-temperature";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-landsat";
const BEFORE_LAYER = "heat-sectors-hit-area";
const scopeId = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}` : `sector:${record.sectorId}`;

export function validateLandsatIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 5 || manifest.comparisonId !== "landsat-income"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "income"
    || manifest.incomeYear !== 2023 || manifest.analysisResolutionMeters !== 30
    || manifest.maskResolutionMeters !== 1 || manifest.temperatureResolutionMeters !== 30
    || manifest.aggregation !== "exact-masked-area" || manifest.minimumAnalysedAreaHa !== 0.1
    || !manifest.observations
    || !Object.values(manifest.observations).every((item) => item.displayDataUrl)
    || !manifest.scopeIndexUrl || !manifest.municipalityIndexes || !manifest.urbanAtlasClassMaskUrl
    || !manifest.urbanAtlasClassIndexes || !hasUrbanSurfaceContract(manifest)
    || manifest.displayResolutionMeters !== 1) {
    throw new TypeError("Unsupported Landsat-income comparison manifest.");
  }
  return manifest;
}

export function createLandsatIncomeComparison({ descriptor, landsatLayer, incomeLayer, jaarbakLayer }) {
  let manifest;
  let map;
  let active = false;
  let municipality = "";
  let highlightedSectorId = "";
  let displayData;
  let statistics;
  let loadedObservation = "";
  let generation = 0;
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .95 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const observationId = () => landsatLayer.getOption("observation");
  const observation = () => landsatLayer.getRuntimeData()?.observation;

  const ensureManifest = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateLandsatIncomeManifest(await response.json());
    manifest.scopeIndexUrl = safeAsset(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
    Object.values(manifest.observations).forEach((item) => {
      item.displayDataUrl = safeAsset(descriptor.assetRoot, item.displayDataUrl, ".png");
      item.statisticsUrl = safeAsset(descriptor.assetRoot, item.statisticsUrl, ".json.gz");
    });
  };

  const loadObservation = async () => {
    await ensureManifest();
    const id = observationId();
    if (loadedObservation === id) return;
    const item = manifest.observations[id];
    if (!item) throw new Error(`No sealed-urban comparison data for ${id}.`);
    const [display, loadedStatistics] = await Promise.all([
      loadImageData(item.displayDataUrl, manifest.imageSize),
      fetchJsonAsset(item.statisticsUrl, "Landsat-income statistics"),
    ]);
    displayData = display;
    statistics = loadedStatistics;
    if (statistics.schemaVersion !== 4 || statistics.observationId !== id || !statistics.regressionsBySurface) {
      throw new TypeError("Unsupported Landsat-income statistics.");
    }
    Object.values(statistics.regressionsBySurface).forEach((byScope) => Object.values(byScope)
      .filter(Boolean).forEach((regression) => validateSpatialInference(regression.inference)));
    loadedObservation = id;
  };

  const render = async () => {
    if (!active || !displayData) return false;
    const request = ++generation;
    const item = manifest.observations[observationId()];
    const jaarbakUrl = await jaarbakLayer.resolveArchive(item.jaarbakYear, municipality);
    const shown = await exactRaster.show(map, {
      mode: "temperature", jaarbakUrl, urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedUrbanClassIndexes(manifest, selectedUrban),
      temperatureData: displayData,
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  const points = () => Object.values(statistics?.sectorStats ?? {}).flatMap((record) => {
    const combined = combineUrbanGroupStats(record, selectedUrban, { valueKeys: ["meanTemperatureC"] });
    if (combined.analysedAreaHa < manifest.minimumAnalysedAreaHa || !Number.isFinite(record.income)
      || !Number.isFinite(combined.meanTemperatureC) || (municipality && record.municipality !== municipality)) return [];
    return [{ ...record, ...combined, temperature: combined.meanTemperatureC }];
  }).sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return;
    mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
    await render();
    notify();
  };

  return {
    id: "landsat-income",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "income",
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
      landsatLayer.setVisible(map, false);
      incomeLayer.setVisible(map, false);
      active = true;
      await refresh();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      highlightedSectorId = "";
      exactRaster.remove();
      hideIncomeSymbols(map, SYMBOL_LAYER_ID);
      incomeLayer.setVisible(map, false);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
    setMunicipality(value = "") {
      municipality = value;
      if (active) {
        mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
        render().then(notify).catch(console.error);
      }
      return true;
    },
    setHighlightedSector(value = "") { highlightedSectorId = value; if (active) notify(); },
    toggleSeries(key) {
      if (!manifest?.urbanSurfaceGroups.some(({ id }) => id === key)) return { changed: false };
      if (selectedUrban.has(key)) {
        if (selectedUrban.size === 1) return { changed: false, minimum: true };
        selectedUrban.delete(key);
      } else selectedUrban.add(key);
      render().then(notify).catch(console.error);
      notify();
      return { changed: true };
    },
    getLabel: () => t("landsatIncome.title"),
    getActiveNote: () => t("landsatIncome.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("landsatIncome.contextMeta"), text: t("landsatIncome.contextText"),
      sources: [
        productLink("landsat", SEALED_URBAN_SOURCE_URLS.landsat),
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("income", SEALED_URBAN_SOURCE_URLS.income),
      ],
    }),
    getLegendModel: () => ({
      title: t("landsatIncome.legendTitle"), layout: "scale", groups: [{ items: comparisonLegendItems() }],
      gradient: comparisonHeatGradient(), comparisonLegend: incomeLegend(),
      surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
      note: t("landsatIncome.legendNote"), observation: observation(),
    }),
    getPopupModel(_feature, record) {
      const point = points().find(({ sectorId }) => sectorId === record.sectorId);
      return { title: record.sectorName, subtitle: t("landsatIncome.popupSubtitle"),
        lines: point ? [sectorPointLabel(point, { x: "income", y: "temperature", observation: observation()?.acquiredAt })]
          : [t("sealedUrban.noComparableValue")] };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const offset = comparisonPixelOffset(manifest, point);
      if (offset < 0 || displayData?.data[offset + 3] !== 255) return { unavailable: true };
      const code = displayData.data[offset] * 256 + displayData.data[offset + 1];
      return { temperature: code / 100 - 100, acquiredAt: observation()?.acquiredAt };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("landsatIncome.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("landsatIncome.popupSubtitle"),
        subtitle: landsatLayer.getPointPopupModel?.({ acquiredAt: result.acquiredAt, status: "clear", temperatureC: result.temperature })?.subtitle,
        lines: [t("landsatIncome.pointTemperature", { temperature: result.temperature.toFixed(1) })],
      };
    },
    getPanelModel(record) {
      const current = points();
      const areaRecord = comparisonAreaRecord(record, municipality);
      const surfaceKey = manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
        .map(({ id }) => id).join("+");
      const regression = statistics.regressionsBySurface?.[surfaceKey]?.[scopeId(areaRecord)]
        ?? ordinaryLeastSquares(current, "income", "temperature");
      if (regression) {
        regression.analysedAreaHa = current.reduce((sum, item) => sum + item.analysedAreaHa, 0);
        regression.contributingLandsatCount = current.reduce(
          (sum, item) => sum + item.contributingLandsatCount, 0,
        );
      }
      return {
        template: "sealed-urban-scatter", comparisonId: "landsat-income", record: areaRecord,
        title: t("landsatIncome.chartTitle"), definition: t("landsatIncome.definition"),
        xLabel: t("sealedUrban.axisIncome"), yLabel: t("sealedUrban.axisTemperature"),
        xKey: "income", yKey: "temperature", points: current,
        regression,
        incomeCategories: statistics.incomeCategoriesBySurface?.[surfaceKey]?.[scopeId(areaRecord)]
          ?? statistics.incomeCategories?.[scopeId(areaRecord)]
          ?? { sectors: summarizeIncomeCategories(current, "temperature") },
        incomeBoxKind: "temperature",
        slopeScale: 10_000, slopeUnit: t("landsatIncome.slopeUnit"),
        highlightedSectorId, observation: observation(),
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
        methodology: t("landsatIncome.methodology"), caveat: t("sealedUrban.regressionCaveat"),
      };
    },
  };
}
