import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import {
  comparisonAreaRecord, comparisonPixelOffset, GREEN_DENSITY_COLORS, GREEN_DENSITY_GRADIENT,
  GREEN_DENSITY_STOPS, greenClassSelector, hasUrbanSurfaceContract, hideIncomeSymbols, incomeLegend,
  loadImageData, mountIncomeSymbols, ordinaryLeastSquares, safeAsset,
  SEALED_URBAN_SOURCE_URLS, sectorPointLabel, selectedUrbanClassIndexes, surroundingAreaHa,
  summarizeIncomeCategories, urbanSurfaceSelector, validateSpatialInference,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "groenkaart-income-density";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-green";
const BEFORE_LAYER = "heat-sectors-hit-area";
export function validateGroenkaartIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 5 || manifest.comparisonId !== "groenkaart-income"
    || manifest.primaryLayerId !== "groenkaart" || manifest.secondaryLayerId !== "income"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.jaarbakYear !== 2021 || manifest.incomeYear !== 2023
    || manifest.analysisResolutionMeters !== 10
    || !manifest.scopeIndexUrl || !manifest.densityNonGreenUrl || !manifest.municipalityIndexes
    || !manifest.urbanAtlasClassMaskUrl || !manifest.urbanAtlasClassIndexes
    || !hasUrbanSurfaceContract(manifest)
    || manifest.statisticWeighting !== "exact-sealed-urban-area"
    || manifest.maskResolutionMeters !== 1 || manifest.aggregation !== "exact-masked-area"
    || manifest.minimumAnalysedAreaHa !== .1) {
    throw new TypeError("Unsupported Green Map-income comparison manifest.");
  }
  return manifest;
}

export function createGroenkaartIncomeComparison({ descriptor, groenkaartLayer, incomeLayer, jaarbakLayer }) {
  let manifest;
  let statistics;
  let grid;
  let nonGreenGrid;
  let map;
  let active = false;
  let municipality = "";
  let highlightedSectorId = "";
  let previousYear = 2021;
  let selectedGreen = new Set([1, 2]);
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  let generation = 0;
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureData = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateGroenkaartIncomeManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.densityNonGreenUrl = safeAsset(descriptor.assetRoot, manifest.densityNonGreenUrl, ".png");
    manifest.scopeIndexUrl = safeAsset(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    manifest.statisticsUrl = safeAsset(descriptor.assetRoot, manifest.statisticsUrl, ".json.gz");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    const [loadedStatistics, loadedGrid, loadedNonGreenGrid] = await Promise.all([
      fetchJsonAsset(manifest.statisticsUrl, "Green Map-income statistics"),
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
    ]);
    statistics = loadedStatistics;
    if (statistics.schemaVersion !== 4 || !statistics.regressionsBySurface) {
      throw new TypeError("Unsupported Green Map-income statistics.");
    }
    Object.values(statistics.regressionsBySurface).forEach((byGreen) => Object.values(byGreen)
      .forEach((byScope) => Object.values(byScope).filter(Boolean)
        .forEach((regression) => validateSpatialInference(regression.inference))));
    grid = loadedGrid;
    nonGreenGrid = loadedNonGreenGrid;
    selectedGreen = new Set(manifest.defaultGreenClasses);
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
  };

  const render = async () => {
    if (!active || !grid) return false;
    const request = ++generation;
    const jaarbakUrl = await jaarbakLayer.resolveArchive(2021, municipality);
    if (!jaarbakUrl) throw new Error("The exact JaarBAK archive is unavailable.");
    const shown = await exactRaster.show(map, {
      mode: "density", jaarbakUrl, urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedUrbanClassIndexes(manifest, selectedUrban),
      densityData: grid, nonGreenData: nonGreenGrid, selectedClasses: [...selectedGreen],
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  const combinedRecord = (record) => {
    const groups = [...selectedUrban].map((id) => record.urbanSurfaceGroups?.[id]).filter(Boolean);
    const analysedAreaHa = groups.reduce((sum, group) => sum + Number(group.analysedAreaHa ?? 0), 0);
    const meanDensityByGreenClass = {};
    manifest.greenClasses.forEach(({ value }) => {
      const key = String(value);
      const weighted = groups.reduce((sum, group) => Number.isFinite(group.meanDensityByGreenClass?.[key])
        ? sum + group.meanDensityByGreenClass[key] * group.analysedAreaHa : sum, 0);
      meanDensityByGreenClass[key] = analysedAreaHa > 0 ? weighted / analysedAreaHa : null;
    });
    const density = [...selectedGreen].reduce((sum, code) => sum + Number(meanDensityByGreenClass[String(code)] ?? 0), 0);
    return { ...record, analysedAreaHa, meanDensityByGreenClass, density };
  };
  const points = () => Object.values(statistics?.sectorStats ?? {}).map(combinedRecord).flatMap((record) => {
    if (record.analysedAreaHa < manifest.minimumEligibleAreaHa || !Number.isFinite(record.income) || !Number.isFinite(record.density)
      || (municipality && record.municipality !== municipality)) return [];
    return [record];
  }).sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));

  return {
    id: "groenkaart-income",
    primaryLayerId: "groenkaart",
    secondaryLayerId: "income",
    suppressSecondaryControl: true,
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureData();
      previousYear = Number(groenkaartLayer.getOption("year") ?? 2021);
      groenkaartLayer.setOption(map, "year", 2021);
      groenkaartLayer.setVisible(map, false);
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
      incomeLayer.setVisible(map, false);
      groenkaartLayer.setOption(map, "year", previousYear);
      groenkaartLayer.setVisible(map, true);
      notify();
    },
    setMunicipality(value = "") {
      municipality = value;
      if (active) {
        mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
        render().catch(console.error);
        notify();
      }
      return true;
    },
    setHighlightedSector(value = "") { highlightedSectorId = value; if (active) notify(); },
    toggleGreenClass(code) {
      const value = Number(code);
      if (selectedGreen.has(value)) {
        if (selectedGreen.size === 1) return { changed: false, minimum: true };
        selectedGreen.delete(value);
      } else selectedGreen.add(value);
      render().catch(console.error);
      notify();
      return { changed: true };
    },
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
    getLabel: () => t("greenIncome.title"),
    getActiveNote: () => t("greenIncome.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("greenIncome.contextMeta"), text: t("greenIncome.contextText"),
      sources: [
        productLink("greenMap", SEALED_URBAN_SOURCE_URLS.greenMap),
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("income", SEALED_URBAN_SOURCE_URLS.income),
      ],
    }),
    getLegendModel: () => ({
      title: t("greenIncome.legendTitle"), layout: "scale",
      groups: [{ items: GREEN_DENSITY_COLORS.map((color, index) => ({ label: String(index * 25), color })) }],
      continuousScale: {
        gradient: GREEN_DENSITY_GRADIENT,
        ticks: GREEN_DENSITY_STOPS.map(({ value }) => value), unit: "%",
        accessibleLabel: t("greenIncome.continuousLegendLabel"),
      },
      densitySelector: greenClassSelector(manifest, selectedGreen),
      surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
      comparisonLegend: incomeLegend(),
      footnote: t("greenIncome.legendFootnote"),
    }),
    getPopupModel(_feature, record) {
      const point = points().find(({ sectorId }) => sectorId === record.sectorId);
      return { title: record.sectorName, subtitle: t("greenIncome.popupSubtitle"),
        lines: point ? [sectorPointLabel(point, { x: "income", y: "density" })] : [t("sealedUrban.noComparableValue")] };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const offset = comparisonPixelOffset(manifest, point);
      if (offset < 0 || grid.data[offset + 3] === 0) return { unavailable: true };
      let density = 0;
      selectedGreen.forEach((code) => {
        density += (code === 4 ? nonGreenGrid.data[offset] : grid.data[offset + code - 1]) / 2.55;
      });
      return { density: Math.max(0, Math.min(100, density)) };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("greenIncome.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("greenIncome.popupSubtitle"),
        lines: [t("greenIncome.pixelDensity", {
          value: formatNumber(result.density, 1),
          area: formatNumber(surroundingAreaHa(result.density), 2),
        })],
      };
    },
    getPanelModel(record) {
      const current = points();
      const areaRecord = comparisonAreaRecord(record, municipality);
      const surfaceKey = manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
        .map(({ id }) => id).join("+");
      const greenKey = [...selectedGreen].sort((left, right) => left - right).join("+");
      const regression = statistics.regressionsBySurface?.[surfaceKey]?.[greenKey]?.[
        areaRecord.scope === "municipality" ? `municipality:${areaRecord.municipality}` : "region:zennevallei"
      ] ?? ordinaryLeastSquares(current, "income", "density");
      return {
        template: "sealed-urban-scatter", comparisonId: "groenkaart-income", record: areaRecord,
        title: t("greenIncome.chartTitle"), definition: t("greenIncome.definition"),
        xLabel: t("sealedUrban.axisIncome"), yLabel: t("sealedUrban.axisGreenDensity"),
        xKey: "income", yKey: "density", points: current,
        regression,
        incomeCategories: { sectors: summarizeIncomeCategories(current, "density") },
        incomeBoxKind: "green",
        slopeScale: 10_000, slopeUnit: t("greenIncome.slopeUnit"),
        highlightedSectorId, selectedClasses: [...selectedGreen],
        selectedClassLabels: greenClassSelector(manifest, selectedGreen).items.filter((item) => item.selected).map((item) => item.label),
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
        methodology: t("greenIncome.methodology"), caveat: t("sealedUrban.regressionCaveat"),
      };
    },
  };
}
