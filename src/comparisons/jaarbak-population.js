import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import { summarizePopulationPercentage } from "./population-profile.js";
import {
  comparisonPixelOffset, hasUrbanSurfaceContract, loadImageData, safeAsset,
  SEALED_URBAN_SOURCE_URLS, selectedUrbanClassIndexes, SOIL_DENSITY_GRADIENT,
  SOIL_DENSITY_STOPS, surroundingAreaHa, urbanSurfaceSelector,
} from "./sealed-urban-shared.js";

const BEFORE_LAYER = "heat-sectors-hit-area";
const RASTER_LAYER_ID = "jaarbak-population-density";
const POPULATION_DATASET = "flanders-2019";

export function validateJaarbakPopulationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.comparisonId !== "jaarbak-population"
    || manifest.primaryLayerId !== "jaarbak" || manifest.secondaryLayerId !== "population"
    || manifest.soilSealingYear !== 2024 || manifest.populationYear !== 2019
    || manifest.populationDatasetId !== POPULATION_DATASET || manifest.populationResolutionMeters !== 100
    || manifest.densityRadiusMeters !== 100 || manifest.minimumDensityCoverage !== 95
    || manifest.minimumAnalysedAreaHa !== .1 || manifest.maskResolutionMeters !== 1
    || manifest.aggregation !== "exact-masked-area" || !manifest.statisticsUrl
    || !manifest.densityGridUrl || !manifest.urbanAtlasClassMaskUrl
    || !manifest.urbanAtlasClassIndexes || !hasUrbanSurfaceContract(manifest)) {
    throw new TypeError("Unsupported Soil sealing-population comparison manifest.");
  }
  return manifest;
}

export function summarizeSoilByPopulation(cells) {
  return summarizePopulationPercentage(cells, {
    valueKey: "density", binWidth: 5, direction: "descending",
  });
}

export function combineJaarbakPopulationCell(cell, selectedUrban, minimumAreaHa = .1) {
  const groups = [...selectedUrban].map((id) => cell.urbanSurfaceGroups[id]);
  const pixelCount = groups.reduce((sum, group) => sum + Number(group?.pixelCount ?? 0), 0);
  const analysedAreaHa = pixelCount * .0001;
  if (analysedAreaHa < minimumAreaHa) return null;
  const weightedDensitySum = groups.reduce(
    (sum, group) => sum + Number(group?.weightedDensitySum ?? 0), 0,
  );
  return { ...cell, analysedAreaHa, density: weightedDensitySum / pixelCount };
}

export function createJaarbakPopulationComparison({
  descriptor, jaarbakLayer, populationLayer,
}) {
  let manifest;
  let cells = [];
  let grid;
  let map;
  let active = false;
  let municipality = "";
  let previousSoilYear = 2024;
  let previousPopulationDataset = "statbel-2025";
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  let generation = 0;
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());

  const ensureData = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateJaarbakPopulationManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.statisticsUrl = safeAsset(descriptor.assetRoot, manifest.statisticsUrl, ".json");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    const [loadedGrid, statisticsResponse] = await Promise.all([
      loadImageData(manifest.densityGridUrl, manifest.imageSize), fetch(manifest.statisticsUrl),
    ]);
    if (!statisticsResponse.ok) throw new Error(`Comparison statistics HTTP ${statisticsResponse.status}.`);
    const statistics = await statisticsResponse.json();
    if (statistics.schemaVersion !== 1 || !Array.isArray(statistics.cells)) {
      throw new TypeError("Unsupported Soil sealing-population statistics.");
    }
    grid = loadedGrid;
    cells = statistics.cells.map((cell) => ({
      cellId: `${cell.r}:${cell.c}`, row: cell.r, column: cell.c, sectorId: cell.s,
      municipality: manifest.sectorMunicipalities[cell.s], populationDensityPerHa: cell.p,
      analysedAreaHa: cell.a, density: cell.d,
      urbanSurfaceGroups: Object.fromEntries(manifest.urbanSurfaceGroups.map((group, index) => {
        const values = cell.u?.[index] ?? [0, 0];
        return [group.id, { pixelCount: values[0], weightedDensitySum: values[1] }];
      })),
    }));
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
  };

  const selectedCells = () => cells.flatMap((cell) => {
    const combined = combineJaarbakPopulationCell(cell, selectedUrban, manifest.minimumAnalysedAreaHa);
    return combined ? [combined] : [];
  });

  const cellsForRecord = (record) => selectedCells().filter((cell) => {
    if (record?.sectorId && !record.scope) return cell.sectorId === record.sectorId;
    const scopedMunicipality = record?.scope === "municipality" ? record.municipality : municipality;
    return !scopedMunicipality || cell.municipality === scopedMunicipality;
  });

  const render = async () => {
    if (!active || !grid) return false;
    const request = ++generation;
    const archive = await jaarbakLayer.resolveArchive(2024, municipality);
    const shown = await exactRaster.show(map, {
      mode: "soil-density", jaarbakUrl: archive, urbanClassUrl: manifest.urbanAtlasClassMaskUrl,
      selectedUrbanIndexes: selectedUrbanClassIndexes(manifest, selectedUrban),
      densityData: grid, nonGreenData: grid, selectedClasses: [1],
      dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
    });
    return active && request === generation && shown;
  };

  return {
    id: "jaarbak-population", primaryLayerId: "jaarbak", secondaryLayerId: "population",
    suppressSecondaryControl: true, isPanelPersistent: true, panelScope: "area",
    isActive: () => active, hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureData();
      previousSoilYear = Number(jaarbakLayer.getOption("year") ?? 2024);
      previousPopulationDataset = populationLayer.getOption("dataset") ?? "statbel-2025";
      jaarbakLayer.setOption(map, "year", 2024);
      jaarbakLayer.setVisible(map, false);
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
      jaarbakLayer.setOption(map, "year", previousSoilYear);
      jaarbakLayer.setVisible(map, true);
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
    getLabel: () => t("soilPopulation.title"),
    getActiveNote: () => t("soilPopulation.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("soilPopulation.contextMeta"), text: t("soilPopulation.contextText"),
      sources: [
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("populationModel", populationLayer.getDataset(POPULATION_DATASET)?.source?.pageUrl),
      ],
    }),
    getLegendModel() {
      const populationLegend = populationLayer.getLegendModel();
      return {
        title: t("soilPopulation.legendTitle"), layout: "scale", groups: [{ items: [] }],
        continuousScale: {
          gradient: SOIL_DENSITY_GRADIENT, ticks: SOIL_DENSITY_STOPS.map(({ value }) => value), unit: "%",
          accessibleLabel: t("soilPopulation.soilScaleLabel"),
        },
        surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
        comparisonLegend: { title: t("soilPopulation.populationLegendTitle"), items: populationLegend.groups[0].items },
        note: t("soilPopulation.legendNote"),
      };
    },
    getPopupModel(_feature, record) {
      const summary = summarizeSoilByPopulation(cellsForRecord(record));
      return { title: record.sectorName, subtitle: t("soilPopulation.popupSubtitle"),
        lines: Number.isFinite(summary.weightedMean) ? [t("soilPopulation.popupMean", {
          density: formatNumber(summary.weightedMean, 1), count: summary.points.length,
        })] : [t("sealedUrban.noComparableValue")] };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const [population, offset] = await Promise.all([
        populationLayer.inspectDatasetPoint(POPULATION_DATASET, point),
        Promise.resolve(comparisonPixelOffset(manifest, point)),
      ]);
      if (population.unavailable || offset < 0 || grid.data[offset + 3] === 0) return { unavailable: true };
      return { density: grid.data[offset] / 2.55, populationDensityPerHa: population.densityPerHa };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? { title: t("soilPopulation.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")] }
        : { title: t("soilPopulation.popupSubtitle"), lines: [
          t("soilPopulation.pointPopulation", { value: formatNumber(result.populationDensityPerHa, 1) }),
          t("soilPopulation.pointSoil", { density: formatNumber(result.density, 1),
            area: formatNumber(surroundingAreaHa(result.density), 2) }),
        ] };
    },
    getPanelModel(record) {
      const summary = summarizeSoilByPopulation(cellsForRecord(record));
      return {
        template: "jaarbak-population-comparison", comparisonId: "jaarbak-population",
        copyPrefix: "soilPopulation", record: record?.scope || record?.sectorId ? record : null,
        populationYear: 2019, soilSealingYear: 2024,
        points: summary.points, curve: summary.curve, bins: summary.bins,
        direction: summary.direction, totalResidents: summary.totalResidents,
        zeroPopulationCount: summary.zeroPopulationCount, weightedMean: summary.weightedMean,
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
      };
    },
  };
}
