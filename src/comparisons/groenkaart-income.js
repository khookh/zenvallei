import { t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import {
  comparisonAreaRecord, GREEN_DENSITY_COLORS, greenClassSelector, hideIncomeSymbols, incomeLegend,
  loadImageData, mountIncomeSymbols, ordinaryLeastSquares, safeAsset,
  SEALED_URBAN_SOURCE_URLS, sectorPointLabel, selectedDensity,
} from "./sealed-urban-shared.js";

const SOURCE_ID = "groenkaart-income-canvas";
const RASTER_LAYER_ID = "groenkaart-income-density";
const SYMBOL_LAYER_ID = "sealed-urban-income-symbols-green";
const BEFORE_LAYER = "heat-sectors-hit-area";
const scopeId = (record) => record.scope === "region" ? "region:zennevallei"
  : record.scope === "municipality" ? `municipality:${record.municipality}` : `sector:${record.sectorId}`;

function densityColor(value) {
  const index = Math.max(0, Math.min(GREEN_DENSITY_COLORS.length - 1, Math.floor(value / 25)));
  const hex = GREEN_DENSITY_COLORS[index];
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

export function validateGroenkaartIncomeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "groenkaart-income"
    || manifest.primaryLayerId !== "groenkaart" || manifest.secondaryLayerId !== "income"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.jaarbakYear !== 2021 || manifest.incomeYear !== 2023
    || manifest.analysisResolutionMeters !== 10
    || !manifest.scopeIndexUrl || !manifest.densityNonGreenUrl || !manifest.municipalityIndexes
    || JSON.stringify(manifest.urbanFabricCodes) !== JSON.stringify(["11100", "11210", "11220", "11230", "11240"])) {
    throw new TypeError("Unsupported Green Map-income comparison manifest.");
  }
  return manifest;
}

export function createGroenkaartIncomeComparison({ descriptor, groenkaartLayer, incomeLayer }) {
  let manifest;
  let statistics;
  let grid;
  let nonGreenGrid;
  let scope;
  let map;
  let canvas;
  let context;
  let active = false;
  let municipality = "";
  let highlightedSectorId = "";
  let previousYear = 2021;
  let selectedGreen = new Set([1, 2]);
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
    const [statsResponse, loadedGrid, loadedNonGreenGrid, loadedScope] = await Promise.all([
      fetch(manifest.statisticsUrl),
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
      loadImageData(manifest.scopeIndexUrl, manifest.imageSize),
    ]);
    if (!statsResponse.ok) throw new Error(`Comparison statistics HTTP ${statsResponse.status}.`);
    statistics = await statsResponse.json();
    grid = loadedGrid;
    nonGreenGrid = loadedNonGreenGrid;
    scope = loadedScope;
    selectedGreen = new Set(manifest.defaultGreenClasses);
  };

  const render = () => {
    if (!active || !context || !grid || !scope) return;
    const output = context.createImageData(canvas.width, canvas.height);
    const municipalityIndex = municipality ? manifest.municipalityIndexes[municipality] : 0;
    for (let offset = 0; offset < grid.data.length; offset += 4) {
      const inScope = municipalityIndex ? scope.data[offset + 1] === municipalityIndex : scope.data[offset] === 1;
      if (!inScope) continue;
      let density = 0;
      selectedGreen.forEach((code) => {
        density += (code === 4 ? nonGreenGrid.data[offset] : grid.data[offset + code - 1]) / 2.55;
      });
      if (density <= 0) continue;
      const color = densityColor(density);
      output.data[offset] = color[0];
      output.data[offset + 1] = color[1];
      output.data[offset + 2] = color[2];
      output.data[offset + 3] = 224;
    }
    context.putImageData(output, 0, 0);
    const source = map.getSource(SOURCE_ID);
    source?.setCoordinates(manifest.coordinates);
    source?.play?.();
    map.triggerRepaint();
    requestAnimationFrame(() => source?.pause?.());
  };

  const points = () => Object.values(statistics?.sectorStats ?? {}).flatMap((record) => {
    const density = selectedDensity(record, selectedGreen);
    if (record.validCellCount < 10 || !Number.isFinite(record.income) || !Number.isFinite(density)
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
      if (!map.getSource(SOURCE_ID)) {
        canvas = document.createElement("canvas");
        canvas.width = manifest.imageSize[0];
        canvas.height = manifest.imageSize[1];
        canvas.className = "comparison-render-canvas";
        canvas.setAttribute("aria-hidden", "true");
        document.body.append(canvas);
        context = canvas.getContext("2d", { alpha: true });
        map.addSource(SOURCE_ID, { type: "canvas", canvas, coordinates: manifest.coordinates, animate: false });
        map.addLayer({ id: RASTER_LAYER_ID, type: "raster", source: SOURCE_ID,
          paint: { "raster-opacity": .9, "raster-resampling": "linear", "raster-fade-duration": 0 } }, BEFORE_LAYER);
      }
      active = true;
      mountIncomeSymbols(map, { id: SYMBOL_LAYER_ID, sectorStats: statistics.sectorStats, municipality });
      render();
      notify();
      return true;
    },
    deactivate() {
      active = false;
      highlightedSectorId = "";
      if (map?.getLayer(RASTER_LAYER_ID)) map.removeLayer(RASTER_LAYER_ID);
      if (map?.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      canvas?.remove();
      canvas = null;
      context = null;
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
        render();
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
      render();
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
