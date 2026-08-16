import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import {
  comparisonAreaRecord, comparisonPixelOffset, hasUrbanSurfaceContract, hideIncomeSymbols,
  incomeLegend, loadImageData, mountIncomeSymbols, ordinaryLeastSquares, safeAsset,
  SEALED_URBAN_SOURCE_URLS, sectorPointLabel, selectedUrbanClassIndexes,
  SOIL_DENSITY_GRADIENT, SOIL_DENSITY_STOPS, surroundingAreaHa, summarizeIncomeCategories,
  urbanSurfaceSelector, validateSpatialInference,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "jaarbak-income-density";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-soil";
const BEFORE_LAYER = "heat-sectors-hit-area";

export function validateJaarbakIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "jaarbak-income"
    || manifest.primaryLayerId !== "jaarbak" || manifest.secondaryLayerId !== "income"
    || manifest.soilSealingYear !== 2024 || manifest.urbanAtlasYear !== 2021
    || manifest.incomeYear !== 2023 || manifest.densityRadiusMeters !== 100
    || manifest.densityAnalysisResolutionMeters !== 10 || manifest.minimumDensityCoverage !== 95
    || manifest.minimumAnalysedAreaHa !== .1 || manifest.maskResolutionMeters !== 1
    || manifest.aggregation !== "exact-masked-area" || !manifest.statisticsUrl
    || !manifest.densityGridUrl || !manifest.urbanAtlasClassMaskUrl
    || !manifest.urbanAtlasClassIndexes || !hasUrbanSurfaceContract(manifest)) {
    throw new TypeError("Unsupported Soil sealing-income comparison manifest.");
  }
  return manifest;
}

export function combineJaarbakIncomeRecord(record, selectedUrban) {
  const groups = [...selectedUrban].map((id) => record.urbanSurfaceGroups?.[id]).filter(Boolean);
  const analysedAreaHa = groups.reduce((sum, group) => sum + Number(group.analysedAreaHa ?? 0), 0);
  const densityAreaSum = groups.reduce((sum, group) => sum + Number(group.densityAreaSum ?? 0), 0);
  return {
    ...record,
    analysedAreaHa,
    density: analysedAreaHa > 0 ? densityAreaSum / (analysedAreaHa * 10_000) : null,
  };
}

export function createJaarbakIncomeComparison({ descriptor, jaarbakLayer, incomeLayer }) {
  let manifest;
  let statistics;
  let grid;
  let map;
  let active = false;
  let municipality = "";
  let highlightedSectorId = "";
  let previousSoilYear = 2024;
  let previousIncomeYear = 2023;
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  let generation = 0;
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureData = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateJaarbakIncomeManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.statisticsUrl = safeAsset(descriptor.assetRoot, manifest.statisticsUrl, ".json.gz");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    [statistics, grid] = await Promise.all([
      fetchJsonAsset(manifest.statisticsUrl, "Soil sealing-income statistics"),
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
    ]);
    if (statistics.schemaVersion !== 1 || !statistics.regressionsBySurface || !statistics.sectorStats) {
      throw new TypeError("Unsupported Soil sealing-income statistics.");
    }
    Object.values(statistics.regressionsBySurface).forEach((byScope) => Object.values(byScope)
      .filter(Boolean).forEach((regression) => validateSpatialInference(regression.inference)));
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
  };

  const points = () => Object.values(statistics?.sectorStats ?? {})
    .map((record) => combineJaarbakIncomeRecord(record, selectedUrban))
    .flatMap((record) => {
      if (record.analysedAreaHa < manifest.minimumAnalysedAreaHa
        || !Number.isFinite(record.income) || !Number.isFinite(record.density)
        || (municipality && record.municipality !== municipality)) return [];
      return [record];
    })
    .sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));

  const render = async () => {
    if (!active || !grid) return false;
    const request = ++generation;
    const jaarbakUrl = await jaarbakLayer.resolveArchive(2024, municipality);
    const shown = await exactRaster.show(map, {
      mode: "soil-density", jaarbakUrl, urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedUrbanClassIndexes(manifest, selectedUrban),
      densityData: grid, nonGreenData: grid, selectedClasses: [1],
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  return {
    id: "jaarbak-income", primaryLayerId: "jaarbak", secondaryLayerId: "income",
    suppressSecondaryControl: true, isPanelPersistent: true, panelScope: "area",
    isActive: () => active, hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureData();
      previousSoilYear = Number(jaarbakLayer.getOption("year") ?? 2024);
      previousIncomeYear = Number(incomeLayer.getOption?.("year") ?? 2023);
      jaarbakLayer.setOption(map, "year", 2024);
      jaarbakLayer.setVisible(map, false);
      incomeLayer.setOption?.(map, "year", 2023);
      incomeLayer.setVisible(map, false);
      showComparisonVeil(map, BEFORE_LAYER);
      active = true;
      await render();
      mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
      notify();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      highlightedSectorId = "";
      exactRaster.remove();
      hideComparisonVeil(map);
      hideIncomeSymbols(map, SYMBOL_LAYER_ID);
      incomeLayer.setOption?.(map, "year", previousIncomeYear);
      incomeLayer.setVisible(map, false);
      jaarbakLayer.setOption(map, "year", previousSoilYear);
      jaarbakLayer.setVisible(map, true);
      notify();
    },
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
    getLabel: () => t("soilIncome.title"),
    getActiveNote: () => t("soilIncome.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("soilIncome.contextMeta"), text: t("soilIncome.contextText"),
      sources: [
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("income", SEALED_URBAN_SOURCE_URLS.income),
      ],
    }),
    getLegendModel: () => ({
      title: t("soilIncome.legendTitle"), layout: "scale", groups: [{ items: [] }],
      continuousScale: {
        gradient: SOIL_DENSITY_GRADIENT, ticks: SOIL_DENSITY_STOPS.map(({ value }) => value), unit: "%",
        accessibleLabel: t("soilIncome.continuousLegendLabel"),
      },
      surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
      comparisonLegend: incomeLegend(),
      footnote: t("soilIncome.legendFootnote"),
    }),
    getPopupModel(_feature, record) {
      const point = points().find(({ sectorId }) => sectorId === record.sectorId);
      return {
        title: record.sectorName, subtitle: t("soilIncome.popupSubtitle"),
        lines: point ? [sectorPointLabel(point, { x: "income", y: "density" })]
          : [t("sealedUrban.noComparableValue")],
      };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const offset = comparisonPixelOffset(manifest, point);
      if (offset < 0 || grid.data[offset + 3] === 0) return { unavailable: true };
      return { density: grid.data[offset] / 2.55 };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("soilIncome.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("soilIncome.popupSubtitle"),
        lines: [t("soilIncome.pixelDensity", {
          value: formatNumber(result.density, 1), area: formatNumber(surroundingAreaHa(result.density), 2),
        })],
      };
    },
    getPanelModel(record) {
      const current = points();
      const areaRecord = comparisonAreaRecord(record, municipality);
      const surfaceKey = manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
        .map(({ id }) => id).join("+");
      const regression = statistics.regressionsBySurface?.[surfaceKey]?.[
        areaRecord.scope === "municipality" ? `municipality:${areaRecord.municipality}` : "region:zennevallei"
      ] ?? ordinaryLeastSquares(current, "income", "density");
      return {
        template: "sealed-urban-scatter", comparisonId: "jaarbak-income", record: areaRecord,
        title: t("soilIncome.chartTitle"), definition: t("soilIncome.definition"),
        xLabel: t("sealedUrban.axisIncome"), yLabel: t("soilIncome.axisDensity"),
        xKey: "income", yKey: "density", points: current, regression,
        incomeCategories: { sectors: summarizeIncomeCategories(current, "density") },
        incomeBoxKind: "soil", slopeScale: 10_000, slopeUnit: t("soilIncome.slopeUnit"),
        highlightedSectorId,
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
        methodology: t("soilIncome.methodology"), caveat: t("sealedUrban.regressionCaveat"),
      };
    },
  };
}
