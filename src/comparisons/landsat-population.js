import { formatNumber, t } from "../i18n.js";
import { productLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems } from "./thermal-palette.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import { summarizePopulationTemperature } from "./population-profile.js";
import {
  comparisonAreaRecord, comparisonPixelOffset, hasUrbanSurfaceContract, loadImageData, safeAsset, SEALED_URBAN_SOURCE_URLS,
  selectedUrbanClassIndexes, urbanSurfaceSelector,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "landsat-population-temperature";
const BEFORE_LAYER = "heat-sectors-hit-area";
const POPULATION_DATASET = "flanders-2019";

export function validateLandsatPopulationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 3 || manifest.comparisonId !== "landsat-population"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "population"
    || manifest.populationDatasetId !== POPULATION_DATASET || manifest.populationYear !== 2019
    || manifest.populationResolutionMeters !== 100 || manifest.analysisResolutionMeters !== 30
    || manifest.maskResolutionMeters !== 1 || manifest.temperatureResolutionMeters !== 30
    || manifest.aggregation !== "exact-masked-area" || manifest.minimumAnalysedAreaHa !== 0.1
    || manifest.cellEncoding?.length !== 6
    || !manifest.urbanAtlasClassMaskUrl || !manifest.urbanAtlasClassIndexes
    || !hasUrbanSurfaceContract(manifest) || !manifest.observations
    || !Object.values(manifest.observations).every((item) => item.displayDataUrl && item.statisticsUrl)) {
    throw new TypeError("Unsupported Landsat-population comparison manifest.");
  }
  return manifest;
}

export function createLandsatPopulationComparison({
  descriptor, landsatLayer, populationLayer, jaarbakLayer,
}) {
  let manifest;
  let cells = [];
  let cellLookup = new Map();
  let displayData;
  let loadedObservation = "";
  let map;
  let active = false;
  let municipality = "";
  let previousPopulationDataset = "statbel-2025";
  let generation = 0;
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const observationId = () => landsatLayer.getOption("observation");
  const observation = () => landsatLayer.getRuntimeData()?.observation;

  const ensureManifest = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateLandsatPopulationManifest(await response.json());
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
    if (!item) throw new Error(`No Landsat-population data for ${id}.`);
    const [display, payload] = await Promise.all([
      loadImageData(item.displayDataUrl, manifest.imageSize),
      fetchJsonAsset(item.statisticsUrl, "Landsat-population statistics"),
    ]);
    displayData = display;
    cells = (payload.cells ?? []).map(([sectorId, row, column, population, ...groups]) => ({
      cellId: `${row}:${column}`, row, column, sectorId,
      municipality: manifest.sectorMunicipalities[sectorId], populationDensityPerHa: population,
      urbanSurfaceGroups: Object.fromEntries(manifest.urbanSurfaceGroups.map((group, index) => [group.id, {
        areaM2: Number(groups[index]?.[0] ?? 0), temperatureAreaSum: Number(groups[index]?.[1] ?? 0),
        landsatIndexes: groups[index]?.[2] ?? [],
      }])),
    }));
    cellLookup = new Map(cellsForRecord(null).map((cell) => [cell.cellId, cell]));
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

  const cellsForRecord = (record) => {
    const scoped = cells.filter((cell) => {
      if (record?.sectorId && !record.scope) return cell.sectorId === record.sectorId;
      const scopedMunicipality = record?.scope === "municipality" ? record.municipality : municipality;
      return !scopedMunicipality || cell.municipality === scopedMunicipality;
    });
    const combined = new Map();
    scoped.forEach((cell) => {
      const target = combined.get(cell.cellId) ?? {
        ...cell, analysedAreaM2: 0, temperatureAreaSum: 0, landsatIndexes: new Set(),
      };
      [...selectedUrban].map((id) => cell.urbanSurfaceGroups[id]).filter(Boolean).forEach((group) => {
        target.analysedAreaM2 += group.areaM2;
        target.temperatureAreaSum += group.temperatureAreaSum;
        group.landsatIndexes.forEach((id) => target.landsatIndexes.add(id));
      });
      combined.set(cell.cellId, target);
    });
    return [...combined.values()].flatMap((cell) => {
      if (cell.analysedAreaM2 < manifest.minimumAnalysedAreaHa * 10_000) return [];
      return [{ ...cell, contributingCount: cell.landsatIndexes.size,
        analysedAreaHa: cell.analysedAreaM2 / 10_000,
        temperature: cell.temperatureAreaSum / cell.analysedAreaM2 }];
    });
  };

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return;
    await render();
    notify();
  };

  return {
    id: "landsat-population",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "population",
    suppressSecondaryControl: true,
    isPanelPersistent: true,
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
      previousPopulationDataset = populationLayer.getOption("dataset") ?? "statbel-2025";
      landsatLayer.setVisible(map, false);
      await populationLayer.mount(map, { beforeLayerId: BEFORE_LAYER });
      populationLayer.setOption(map, "dataset", POPULATION_DATASET);
      showComparisonVeil(map, BEFORE_LAYER);
      populationLayer.setVisible(map, true);
      populationLayer.setComparisonOpacity(map, .28, BEFORE_LAYER);
      active = true;
      await refresh();
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
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
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
      cellLookup = new Map(cellsForRecord(null).map((cell) => [cell.cellId, cell]));
      render().then(notify).catch(console.error);
      notify();
      return { changed: true };
    },
    getLabel: () => t("landsatPopulation.title"),
    getActiveNote: () => t("landsatPopulation.activeNote", { area: municipality || t("controls.allMunicipalities") }),
    getContext: () => ({
      meta: t("landsatPopulation.contextMeta"), text: t("landsatPopulation.contextText"),
      sources: [
        productLink("landsat", SEALED_URBAN_SOURCE_URLS.landsat),
        productLink("jaarbak", SEALED_URBAN_SOURCE_URLS.jaarbak),
        productLink("urbanAtlas", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
        productLink("populationModel", populationLayer.getDataset(POPULATION_DATASET)?.source?.pageUrl),
      ],
    }),
    getLegendModel() {
      return {
        title: t("landsatPopulation.legendTitle"), layout: "scale",
        groups: [{ items: comparisonLegendItems() }], gradient: comparisonHeatGradient(),
        comparisonLegend: { title: t("landsatPopulation.populationLegendTitle"), items: populationLayer.getLegendModel().groups[0].items },
        surfaceSelector: urbanSurfaceSelector(manifest, selectedUrban),
        note: t("landsatPopulation.legendNote"), observation: observation(),
      };
    },
    getPopupModel(_feature, record) {
      const summary = summarizePopulationTemperature(cellsForRecord(record));
      return {
        title: record.sectorName, subtitle: t("landsatPopulation.popupSubtitle"),
        lines: summary.weightedMean == null ? [t("sealedUrban.noComparableValue")] : [
          t("landsatPopulation.popupMean", { temperature: formatNumber(summary.weightedMean, 1), count: summary.points.length }),
        ],
      };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const [population, offset] = await Promise.all([
        populationLayer.inspectDatasetPoint(POPULATION_DATASET, point),
        Promise.resolve(comparisonPixelOffset(manifest, point)),
      ]);
      if (population.unavailable || offset < 0 || displayData?.data[offset + 3] !== 255) return { unavailable: true };
      const cell = cellLookup.get(`${population.row}:${population.column}`);
      return cell ? { ...cell, acquiredAt: observation()?.acquiredAt } : { unavailable: true };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? { title: t("landsatPopulation.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")] } : {
        title: t("landsatPopulation.popupSubtitle"),
        lines: [
          t("landsatPopulation.pointPopulation", { value: formatNumber(result.populationDensityPerHa, 1) }),
          t("landsatPopulation.pointTemperature", { value: formatNumber(result.temperature, 1), count: result.contributingCount }),
        ],
      };
    },
    getPanelModel(record) {
      const areaRecord = comparisonAreaRecord(record, municipality);
      const summary = summarizePopulationTemperature(cellsForRecord(areaRecord));
      const contributingLandsat = new Set(summary.points.flatMap((point) => [...point.landsatIndexes]));
      return {
        template: "landsat-population-comparison", record: areaRecord, observation: observation(),
        points: summary.points, curve: summary.curve, bins: summary.bins,
        totalResidents: summary.totalResidents, zeroPopulationCount: summary.zeroPopulationCount,
        totalMeasurements: summary.totalMeasurements, weightedMean: summary.weightedMean, populationYear: 2019,
        analysedAreaHa: summary.points.reduce((sum, point) => sum + point.analysedAreaHa, 0),
        contributingLandsatCount: contributingLandsat.size,
        temperatureMinimum: summary.temperatureMinimum, temperatureMaximum: summary.temperatureMaximum,
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
      };
    },
  };
}
