import { formatNumber, t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import {
  comparisonAreaRecord, comparisonPixelOffset, GREEN_DENSITY_COLORS, greenClassSelector, hideIncomeSymbols, incomeLegend,
  loadImageData, mountIncomeSymbols, ordinaryLeastSquares, safeAsset,
  SEALED_URBAN_SOURCE_URLS, sectorPointLabel, selectedDensity,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "groenkaart-income-density";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-green";
const BEFORE_LAYER = "heat-sectors-hit-area";
const scopeId = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}` : `sector:${record.sectorId}`;

export function validateGroenkaartIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2 || manifest.comparisonId !== "groenkaart-income"
    || manifest.primaryLayerId !== "groenkaart" || manifest.secondaryLayerId !== "income"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.jaarbakYear !== 2021 || manifest.incomeYear !== 2023
    || manifest.analysisResolutionMeters !== 10
    || !manifest.scopeIndexUrl || !manifest.densityNonGreenUrl || !manifest.municipalityIndexes
    || !manifest.urbanFabricMaskUrl || manifest.statisticWeighting !== "exact-sealed-urban-area"
    || JSON.stringify(manifest.urbanFabricCodes) !== JSON.stringify(["11100", "11210", "11220", "11230", "11240"])) {
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
  let generation = 0;
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .91 });
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
    manifest.statisticsUrl = safeAsset(descriptor.assetRoot, manifest.statisticsUrl, ".json");
    manifest.urbanFabricMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanFabricMaskUrl, ".pmtiles");
    const [statsResponse, loadedGrid, loadedNonGreenGrid] = await Promise.all([
      fetch(manifest.statisticsUrl),
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
    ]);
    if (!statsResponse.ok) throw new Error(`Comparison statistics HTTP ${statsResponse.status}.`);
    statistics = await statsResponse.json();
    grid = loadedGrid;
    nonGreenGrid = loadedNonGreenGrid;
    selectedGreen = new Set(manifest.defaultGreenClasses);
  };

  const render = async () => {
    if (!active || !grid) return false;
    const request = ++generation;
    const jaarbakUrl = await jaarbakLayer.resolveArchive(2021, municipality);
    if (!jaarbakUrl) throw new Error("The exact JaarBAK archive is unavailable.");
    const shown = await exactRaster.show(map, {
      mode: "density", jaarbakUrl, urbanMaskUrl: manifest.urbanFabricMaskUrl,
      densityData: grid, nonGreenData: nonGreenGrid, selectedClasses: [...selectedGreen],
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  const points = () => Object.values(statistics?.sectorStats ?? {}).flatMap((record) => {
    const density = selectedDensity(record, selectedGreen);
    if (record.analysedAreaHa < manifest.minimumEligibleAreaHa || !Number.isFinite(record.income) || !Number.isFinite(density)
      || (municipality && record.municipality !== municipality)) return [];
    return [{ ...record, density }];
  }).sort((left, right) => left.income - right.income || left.sectorId.localeCompare(right.sectorId));

  return {
    id: "groenkaart-income",
    primaryLayerId: "groenkaart",
    secondaryLayerId: "income",
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
    getLabel: () => t("greenIncome.title"),
    getActiveNote: () => t("greenIncome.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("greenIncome.contextMeta"), text: t("greenIncome.contextText"), note: t("greenIncome.contextNote"),
      sources: [
        authorityLink("natureForests", SEALED_URBAN_SOURCE_URLS.greenMap),
        authorityLink("departmentEnvironment", SEALED_URBAN_SOURCE_URLS.jaarbak),
        authorityLink("copernicusClms", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        authorityLink("statbel", SEALED_URBAN_SOURCE_URLS.income),
      ],
    }),
    getLegendModel: () => ({
      title: t("greenIncome.legendTitle"), layout: "scale",
      groups: [{ items: GREEN_DENSITY_COLORS.map((color, index) => ({ label: String(index * 25), color })) }],
      densitySelector: greenClassSelector(manifest, selectedGreen),
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
        lines: [t("greenIncome.pixelDensity", { value: formatNumber(result.density, 1) })],
      };
    },
    getPanelModel(record) {
      const current = points();
      const combination = [...selectedGreen].sort((a, b) => a - b).join("+");
      const areaRecord = comparisonAreaRecord(record, municipality);
      return {
        template: "sealed-urban-scatter", comparisonId: "groenkaart-income", record: areaRecord,
        title: t("greenIncome.chartTitle"), definition: t("greenIncome.definition"),
        xLabel: t("sealedUrban.axisIncome"), yLabel: t("sealedUrban.axisGreenDensity"),
        xKey: "income", yKey: "density", points: current,
        regression: statistics.regressions?.[combination]?.[scopeId(areaRecord)]
          ?? ordinaryLeastSquares(current, "income", "density"),
        slopeScale: 10_000, slopeUnit: t("greenIncome.slopeUnit"),
        highlightedSectorId, selectedClasses: [...selectedGreen],
        selectedClassLabels: greenClassSelector(manifest, selectedGreen).items.filter((item) => item.selected).map((item) => item.label),
        methodology: t("greenIncome.methodology"), caveat: t("sealedUrban.regressionCaveat"),
      };
    },
  };
}
