import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import {
  comparisonPixelOffset, GREEN_DENSITY_GRADIENT, GREEN_DENSITY_STOPS,
  greenClassSelector, hasUrbanSurfaceContract, loadImageData, safeAsset, SEALED_URBAN_SOURCE_URLS,
  selectedDensity, selectedUrbanClassIndexes, surroundingAreaHa, urbanSurfaceSelector,
} from "./sealed-urban-shared.js";
import { summarizeResidentProfile } from "./population-profile.js";

const BEFORE_LAYER = "heat-sectors-hit-area";
const RASTER_LAYER_ID = "groenkaart-population-density";
const POPULATION_DATASET = "flanders-2019";
export function summarizeGreenByPopulation(cells, selectedClasses) {
  const records = cells.map((cell) => ({ ...cell, density: selectedDensity(cell, selectedClasses) }));
  return summarizeResidentProfile(records, { valueKey: "density" });
}

export function validateGroenkaartPopulationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 3 || manifest.comparisonId !== "groenkaart-population"
    || manifest.primaryLayerId !== "groenkaart" || manifest.secondaryLayerId !== "population"
    || manifest.greenMapYear !== 2021 || manifest.populationDatasetId !== POPULATION_DATASET
    || manifest.populationResolutionMeters !== 100 || manifest.densityRadiusMeters !== 100
    || manifest.minimumEligibleAreaHa !== .1 || manifest.minimumAnalysedAreaHa !== .1
    || manifest.maskResolutionMeters !== 1 || manifest.aggregation !== "exact-masked-area"
    || !manifest.statisticsUrl || !manifest.urbanAtlasClassMaskUrl
    || !manifest.urbanAtlasClassIndexes || !hasUrbanSurfaceContract(manifest)
    || !manifest.cellEncoding || !manifest.sectorMunicipalities) {
    throw new TypeError("Unsupported Green Map-population comparison manifest.");
  }
  return manifest;
}

export function createGroenkaartPopulationComparison({
  descriptor, groenkaartLayer, populationLayer, jaarbakLayer,
}) {
  let manifest;
  let cells = [];
  let grid;
  let nonGreenGrid;
  let map;
  let active = false;
  let municipality = "";
  let previousGreenYear = 2021;
  let previousPopulationDataset = "statbel-2025";
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
    manifest = validateGroenkaartPopulationManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.densityNonGreenUrl = safeAsset(descriptor.assetRoot, manifest.densityNonGreenUrl, ".png");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    manifest.statisticsUrl = safeAsset(descriptor.assetRoot, manifest.statisticsUrl, ".json");
    const [loadedGrid, loadedNonGreen, statisticsResponse] = await Promise.all([
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
      fetch(manifest.statisticsUrl),
    ]);
    if (!statisticsResponse.ok) throw new Error(`Comparison statistics HTTP ${statisticsResponse.status}.`);
    const statistics = await statisticsResponse.json();
    grid = loadedGrid;
    nonGreenGrid = loadedNonGreen;
    cells = (statistics.cells ?? []).map((cell) => ({
      cellId: `${cell.r}:${cell.c}`,
      row: cell.r,
      column: cell.c,
      sectorId: cell.s,
      municipality: manifest.sectorMunicipalities[cell.s],
      populationDensityPerHa: cell.p,
      analysedAreaHa: cell.a,
      meanDensityByGreenClass: Object.fromEntries((cell.g ?? []).map((value, index) => [index + 1, value])),
      urbanSurfaceGroups: Object.fromEntries(manifest.urbanSurfaceGroups.map((group, index) => {
        const values = cell.u?.[index] ?? [0, 0, 0, 0, 0];
        return [group.id, { pixelCount: values[0], weightedDensityByGreenClass: values.slice(1) }];
      })),
    }));
    selectedGreen = new Set(manifest.defaultGreenClasses);
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
  };

  const selectedCells = () => cells.flatMap((cell) => {
    const groups = [...selectedUrban].map((id) => cell.urbanSurfaceGroups[id]);
    const pixelCount = groups.reduce((sum, group) => sum + Number(group?.pixelCount ?? 0), 0);
    const analysedAreaHa = pixelCount * .0001;
    if (analysedAreaHa < manifest.minimumEligibleAreaHa) return [];
    const meanDensityByGreenClass = Object.fromEntries([1, 2, 3, 4].map((code, band) => [code,
      groups.reduce((sum, group) => sum + Number(group?.weightedDensityByGreenClass?.[band] ?? 0), 0) / pixelCount,
    ]));
    return [{ ...cell, analysedAreaHa, meanDensityByGreenClass }];
  });

  const render = async () => {
    if (!active || !grid) return false;
    const request = ++generation;
    const jaarbakUrl = await jaarbakLayer.resolveArchive(2021, municipality);
    const shown = await exactRaster.show(map, {
      mode: "density", jaarbakUrl, urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedUrbanClassIndexes(manifest, selectedUrban),
      densityData: grid, nonGreenData: nonGreenGrid, selectedClasses: [...selectedGreen],
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  const cellsForRecord = (record) => selectedCells().filter((cell) => {
    if (record?.sectorId && !record.scope) return cell.sectorId === record.sectorId;
    const scopedMunicipality = record?.scope === "municipality" ? record.municipality : municipality;
    return !scopedMunicipality || cell.municipality === scopedMunicipality;
  });

  return {
    id: "groenkaart-population",
    primaryLayerId: "groenkaart",
    secondaryLayerId: "population",
    // Both source years are fixed by the comparison. Showing either layer's
    // standalone dataset/year switch would imply that it changes the analysis.
    suppressSecondaryControl: true,
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureData();
      previousGreenYear = Number(groenkaartLayer.getOption("year") ?? 2021);
      previousPopulationDataset = populationLayer.getOption("dataset") ?? "statbel-2025";
      groenkaartLayer.setOption(map, "year", 2021);
      groenkaartLayer.setVisible(map, false);
      await populationLayer.mount(map, { beforeLayerId: BEFORE_LAYER });
      populationLayer.setOption(map, "dataset", POPULATION_DATASET);
      showComparisonVeil(map, BEFORE_LAYER);
      populationLayer.setVisible(map, true);
      populationLayer.setComparisonOpacity(map, .28, BEFORE_LAYER);
      active = true;
      await render();
      notify();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      exactRaster.remove();
      hideComparisonVeil(map);
      populationLayer.setVisible(map, false);
      populationLayer.setComparisonOpacity(map, .78, BEFORE_LAYER);
      populationLayer.setOption(map, "dataset", previousPopulationDataset);
      groenkaartLayer.setOption(map, "year", previousGreenYear);
      groenkaartLayer.setVisible(map, true);
      notify();
    },
    setMunicipality(value = "") {
      municipality = value;
      if (active) {
        populationLayer.applyFilter(map, value ? ["==", ["get", "municipality"], value] : null);
        render().then(notify).catch(console.error);
      }
      return true;
    },
    toggleGreenClass(code) {
      const value = Number(code);
      if (selectedGreen.has(value)) {
        if (selectedGreen.size === 1) return { changed: false, minimum: true };
        selectedGreen.delete(value);
      } else selectedGreen.add(value);
      render().then(notify).catch(console.error);
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
    getLabel: () => t("greenPopulation.title"),
    getActiveNote: () => t("greenPopulation.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("greenPopulation.contextMeta"), text: t("greenPopulation.contextText"),
      sources: [
        productLink("greenMap", SEALED_URBAN_SOURCE_URLS.greenMap),
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("populationModel", populationLayer.getDataset(POPULATION_DATASET)?.source?.pageUrl),
      ],
    }),
    getLegendModel() {
      const populationLegend = populationLayer.getLegendModel();
      return {
        title: t("greenPopulation.legendTitle"), layout: "scale", groups: [{ items: [] }],
        continuousScale: {
          gradient: GREEN_DENSITY_GRADIENT,
          ticks: GREEN_DENSITY_STOPS.map(({ value }) => value), unit: "%",
          accessibleLabel: t("greenPopulation.greenScaleLabel"),
        },
        densitySelector: greenClassSelector(manifest, selectedGreen),
        surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
        comparisonLegend: {
          title: t("greenPopulation.populationLegendTitle"),
          items: populationLegend.groups[0].items,
        },
        note: t("greenPopulation.legendNote"),
      };
    },
    getPopupModel(_feature, record) {
      const summary = summarizeGreenByPopulation(cellsForRecord(record), selectedGreen);
      const mean = summary.weightedMean;
      return {
        title: record.sectorName,
        subtitle: t("greenPopulation.popupSubtitle"),
        lines: Number.isFinite(mean) ? [t("greenPopulation.popupMean", {
          density: formatNumber(mean, 1), count: summary.points.length,
        })] : [t("sealedUrban.noComparableValue")],
      };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const [population, offset] = await Promise.all([
        populationLayer.inspectDatasetPoint(POPULATION_DATASET, point),
        Promise.resolve(comparisonPixelOffset(manifest, point)),
      ]);
      if (population.unavailable || offset < 0 || grid.data[offset + 3] === 0) return { unavailable: true };
      let density = 0;
      selectedGreen.forEach((code) => {
        density += (code === 4 ? nonGreenGrid.data[offset] : grid.data[offset + code - 1]) / 2.55;
      });
      return {
        density: Math.max(0, Math.min(100, density)),
        populationDensityPerHa: population.densityPerHa,
      };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("greenPopulation.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("greenPopulation.popupSubtitle"),
        lines: [
          t("greenPopulation.pointPopulation", { value: formatNumber(result.populationDensityPerHa, 1) }),
          t("greenPopulation.pointGreen", {
            density: formatNumber(result.density, 1), area: formatNumber(surroundingAreaHa(result.density), 2),
          }),
        ],
      };
    },
    getPanelModel(record) {
      const selector = greenClassSelector(manifest, selectedGreen);
      const summary = summarizeGreenByPopulation(cellsForRecord(record), selectedGreen);
      return {
        template: "groenkaart-population-comparison",
        record: record?.scope || record?.sectorId ? record : null,
        populationYear: 2019, greenMapYear: 2021,
        points: summary.points, bands: summary.bands, groups: summary.bands, sufficient: summary.sufficient,
        totalResidents: summary.totalResidents, zeroPopulationCount: summary.zeroPopulationCount,
        weightedMean: summary.weightedMean,
        selectedClasses: [...selectedGreen],
        selectedClassLabels: selector.items.filter((item) => item.selected).map((item) => item.label),
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
      };
    },
  };
}
