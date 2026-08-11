import { formatNumber, t } from "../i18n.js";
import { authorityLink } from "../source-authorities.js";
import { comparisonHeatGradient, comparisonLegendItems } from "./thermal-palette.js";
import { fetchJsonAsset } from "./compressed-json.js";
import { boundsFromCoordinates, createExactSealedRaster } from "./exact-sealed-raster.js";
import { hideComparisonVeil, showComparisonVeil } from "./map-veil.js";
import {
  comparisonPixelOffset, GREEN_DENSITY_GRADIENT, GREEN_DENSITY_STOPS,
  greenClassSelector, hasUrbanSurfaceContract, loadImageData, ordinaryLeastSquares, safeAsset, SEALED_URBAN_SOURCE_URLS,
  selectedUrbanClassIndexes, surroundingAreaHa, urbanSurfaceSelector,
} from "./sealed-urban-shared.js";

const RASTER_LAYER_ID = "landsat-groenkaart-temperature";
const BEFORE_LAYER = "heat-sectors-hit-area";

export function validateLandsatGroenkaartManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 6 || manifest.comparisonId !== "landsat-groenkaart"
    || manifest.primaryLayerId !== "landsat-temperature" || manifest.secondaryLayerId !== "groenkaart"
    || manifest.greenMapYear !== 2021 || manifest.urbanAtlasYear !== 2021
    || manifest.analysisResolutionMeters !== 30 || manifest.maskResolutionMeters !== 1
    || manifest.temperatureResolutionMeters !== 30 || manifest.aggregation !== "exact-masked-area"
    || manifest.minimumAnalysedAreaHa !== 0.1 || manifest.minimumPixelMaskedAreaM2 !== 1
    || !manifest.observations || !Object.values(manifest.observations).every((item) => item.displayDataUrl && item.pointDataUrl)
    || !Array.isArray(manifest.greenClasses) || !manifest.densityNonGreenUrl
    || !manifest.scopeIndexUrl || !manifest.municipalityIndexes || !manifest.urbanFabricMaskUrl
    || !manifest.urbanAtlasClassMaskUrl || !manifest.urbanAtlasClassIndexes
    || !hasUrbanSurfaceContract(manifest)) {
    throw new TypeError("Unsupported Landsat-Green Map comparison manifest.");
  }
  return manifest;
}

export function createLandsatGroenkaartComparison({ descriptor, landsatLayer, groenkaartLayer, jaarbakLayer }) {
  let manifest;
  let densityData;
  let densityNonGreenData;
  let pointData;
  let displayData;
  let loadedObservation = "";
  let map;
  let active = false;
  let municipality = "";
  let previousYear = 2021;
  let selectedGreen = new Set([1, 2]);
  let selectedUrban = new Set(["residential", "employmentInstitutional"]);
  let displayMode = "temperature";
  let generation = 0;
  const exactRaster = createExactSealedRaster({ id: RASTER_LAYER_ID, beforeLayerId: BEFORE_LAYER, opacity: .96 });
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const observationId = () => landsatLayer.getOption("observation");
  const observation = () => landsatLayer.getRuntimeData()?.observation;
  let sectorIdByIndex = new Map();

  const ensureManifest = async () => {
    if (manifest) return;
    const response = await fetch(descriptor.manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Comparison manifest HTTP ${response.status}.`);
    manifest = validateLandsatGroenkaartManifest(await response.json());
    manifest.densityGridUrl = safeAsset(descriptor.assetRoot, manifest.densityGridUrl, ".png");
    manifest.densityNonGreenUrl = safeAsset(descriptor.assetRoot, manifest.densityNonGreenUrl, ".png");
    manifest.scopeIndexUrl = safeAsset(descriptor.assetRoot, manifest.scopeIndexUrl, ".png");
    manifest.urbanFabricMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanFabricMaskUrl, ".pmtiles");
    manifest.urbanAtlasClassMaskUrl = safeAsset(descriptor.assetRoot, manifest.urbanAtlasClassMaskUrl, ".pmtiles");
    Object.values(manifest.observations).forEach((item) => {
      item.displayDataUrl = safeAsset(descriptor.assetRoot, item.displayDataUrl, ".png");
      item.pointDataUrl = safeAsset(descriptor.assetRoot, item.pointDataUrl, ".json.gz");
      item.statisticsUrl = safeAsset(descriptor.assetRoot, item.statisticsUrl, ".json");
    });
    [densityData, densityNonGreenData] = await Promise.all([
      loadImageData(manifest.densityGridUrl, manifest.imageSize),
      loadImageData(manifest.densityNonGreenUrl, manifest.imageSize),
    ]);
    selectedGreen = new Set(manifest.defaultGreenClasses);
    selectedUrban = new Set(manifest.defaultUrbanSurfaceGroups);
    sectorIdByIndex = new Map(Object.entries(manifest.sectorIndexes).map(([id, index]) => [Number(index), id]));
  };

  const loadObservation = async () => {
    await ensureManifest();
    const id = observationId();
    if (loadedObservation === id) return;
    const item = manifest.observations[id];
    const [display, points] = await Promise.all([
      loadImageData(item.displayDataUrl, manifest.imageSize),
      fetchJsonAsset(item.pointDataUrl, "Exact comparison points"),
    ]);
    displayData = display;
    pointData = points;
    loadedObservation = id;
  };

  const allowedIndex = (index, record = null) => {
    const sectorId = sectorIdByIndex.get(index);
    if (!sectorId) return false;
    // Sector records come directly from scores.json and intentionally have no
    // synthetic `scope` field. A record with a sectorId is therefore the most
    // specific scope, unless it explicitly identifies an aggregate.
    if (record?.sectorId && record.scope !== "municipality" && record.scope !== "region") {
      return sectorId === record.sectorId;
    }
    const selectedMunicipality = record?.scope === "municipality" ? record.municipality : municipality;
    return !selectedMunicipality || manifest.sectorMunicipalities[sectorId] === selectedMunicipality;
  };

  const temperatureAt = (data, offset) => {
    const code = data.data[offset] * 256 + data.data[offset + 1];
    return code ? code / 100 - 100 : null;
  };

  const render = async () => {
    if (!active || !pointData) return false;
    const request = ++generation;
    const item = manifest.observations[observationId()];
    const jaarbakUrl = await jaarbakLayer.resolveArchive(item.jaarbakYear, municipality);
    const selectedUrbanIndexes = selectedUrbanClassIndexes(manifest, selectedUrban);
    const shown = await exactRaster.show(map, {
      mode: displayMode === "temperature" ? "temperature" : "density-with-status",
      jaarbakUrl, urbanClassUrl: manifest.urbanAtlasClassMaskUrl, selectedUrbanIndexes,
      temperatureData: displayData, dataBounds: boundsFromCoordinates(manifest.coordinates), dataSize: manifest.imageSize,
      densityData, nonGreenData: densityNonGreenData, selectedClasses: [...selectedGreen],
    });
    return active && request === generation && shown;
  };

  const pixelPoints = (record) => {
    const byObservation = new Map();
    (pointData?.records ?? []).forEach((item) => {
      const [sectorIndex, landsatIndex, groupIndex, maskedAreaM2, ...rest] = item;
      const group = manifest.urbanSurfaceGroups[groupIndex - 1];
      if (!group || !selectedUrban.has(group.id) || !allowedIndex(sectorIndex, record)) return;
      const greenSums = rest.slice(0, 4);
      const temperature = rest[4];
      const combined = byObservation.get(landsatIndex)
        ?? { maskedAreaM2: 0, greenSums: [0, 0, 0, 0], temperature };
      combined.maskedAreaM2 += maskedAreaM2;
      greenSums.forEach((value, index) => { combined.greenSums[index] += value; });
      byObservation.set(landsatIndex, combined);
    });
    const points = [...byObservation.values()].flatMap((item) => {
      if (!item.maskedAreaM2) return [];
      const density = [...selectedGreen].reduce((sum, code) => sum + item.greenSums[code - 1], 0)
        / item.maskedAreaM2;
      return [[density, item.temperature, item.maskedAreaM2]];
    });
    return points.reduce((sum, point) => sum + point[2], 0) >= manifest.minimumAnalysedAreaHa * 10_000
      ? points : [];
  };

  const refresh = async () => {
    const request = ++generation;
    await loadObservation();
    if (!active || request !== generation) return;
    await render();
    notify();
  };

  return {
    id: "landsat-groenkaart",
    primaryLayerId: "landsat-temperature",
    secondaryLayerId: "groenkaart",
    panelScope: "area",
    isActive: () => active,
    hasLoadError: () => false,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async activate(activeMap) {
      map = activeMap;
      await ensureManifest();
      previousYear = Number(groenkaartLayer.getOption("year") ?? 2021);
      groenkaartLayer.setOption(map, "year", 2021);
      groenkaartLayer.setVisible(map, false);
      landsatLayer.setVisible(map, false);
      showComparisonVeil(map, BEFORE_LAYER);
      active = true;
      await refresh();
      return true;
    },
    deactivate() {
      active = false;
      generation += 1;
      exactRaster.remove();
      hideComparisonVeil(map);
      groenkaartLayer.setOption(map, "year", previousYear);
      groenkaartLayer.setVisible(map, false);
      landsatLayer.setVisible(map, true);
      notify();
    },
    async refreshObservation() { if (active) await refresh(); },
    setMunicipality(value = "") { municipality = value; if (active) { render().then(notify).catch(console.error); } return true; },
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
    getMapModeAction: () => ({
      active: displayMode === "vegetation",
      label: t(displayMode === "temperature" ? "landsatGreen.showVegetation" : "landsatGreen.showTemperature"),
    }),
    async toggleMapMode() {
      displayMode = displayMode === "temperature" ? "vegetation" : "temperature";
      await render();
      notify();
      return true;
    },
    getLabel: () => t("landsatGreen.title"),
    getActiveNote: () => t("landsatGreen.activeNote"),
    getContext: () => ({
      meta: t("landsatGreen.contextMeta"), text: t("landsatGreen.contextText"), note: t("landsatGreen.contextNote"),
      sources: [
        authorityLink("landsat", SEALED_URBAN_SOURCE_URLS.landsat),
        authorityLink("natureForests", SEALED_URBAN_SOURCE_URLS.greenMap),
        authorityLink("departmentEnvironment", SEALED_URBAN_SOURCE_URLS.jaarbak),
        authorityLink("copernicusClms", SEALED_URBAN_SOURCE_URLS.urbanAtlas),
      ],
    }),
    getLegendModel: () => {
      const vegetation = displayMode === "vegetation";
      return {
        title: t(vegetation ? "landsatGreen.vegetationLegendTitle" : "landsatGreen.legendTitle"),
        layout: "scale",
        groups: [
          { items: vegetation ? [] : comparisonLegendItems() },
          { items: [{ label: t("landsat.cloudLegend"), color: "repeating-linear-gradient(45deg,#7e878b 0 3px,#c2c9cb 3px 6px)" }] },
        ],
        gradient: vegetation ? null : comparisonHeatGradient(),
        continuousScale: vegetation ? {
          gradient: GREEN_DENSITY_GRADIENT,
          ticks: GREEN_DENSITY_STOPS.map(({ value }) => value), unit: "%",
          accessibleLabel: t("landsatGreen.vegetationScaleLabel"),
        } : null,
        observation: observation(),
        densitySelector: greenClassSelector(manifest, selectedGreen),
        surfaceSelector: { ...urbanSurfaceSelector(manifest, selectedUrban), maximum: 2 },
        note: t(vegetation ? "landsatGreen.vegetationLegendNote" : "landsatGreen.legendNote"),
      };
    },
    getPopupModel(_feature, record) {
      const points = pixelPoints(record);
      const density = points.length ? points.reduce((sum, point) => sum + point[0], 0) / points.length : null;
      const temperature = points.length ? points.reduce((sum, point) => sum + point[1], 0) / points.length : null;
      return { title: record.sectorName, subtitle: t("landsatGreen.popupSubtitle"), lines: points.length
        ? [t("landsatGreen.popupValues", {
          density: formatNumber(density, 1), area: formatNumber(surroundingAreaHa(density), 2),
          temperature: formatNumber(temperature, 1),
        })]
        : [t("sealedUrban.noComparableValue")] };
    },
    async inspectPoint(point) {
      if (!(await exactRaster.contains(point))) return { unavailable: true };
      const offset = comparisonPixelOffset(manifest, point);
      if (offset < 0 || displayData?.data[offset + 3] !== 255) {
        return { unavailable: true };
      }
      const landsatIndex = Math.floor(offset / 4) + 1;
      const comparablePoints = (pointData?.records ?? []).filter((item) => {
        const group = manifest.urbanSurfaceGroups[item[2] - 1];
        return item[1] === landsatIndex && group && selectedUrban.has(group.id) && allowedIndex(item[0]);
      });
      const maskedAreaM2 = comparablePoints.reduce((sum, item) => sum + item[3], 0);
      const densitySum = comparablePoints.reduce((sum, item) => sum
        + [...selectedGreen].reduce((subtotal, code) => subtotal + item[3 + code], 0), 0);
      return {
        density: maskedAreaM2 ? densitySum / maskedAreaM2 : null,
        maskedAreaM2,
        temperature: temperatureAt(displayData, offset),
        acquiredAt: observation()?.acquiredAt,
      };
    },
    getPointPopupModel(result) {
      return result?.unavailable ? {
        title: t("landsatGreen.popupSubtitle"), lines: [t("sealedUrban.noComparableValue")],
      } : {
        title: t("landsatGreen.popupSubtitle"),
        subtitle: landsatLayer.getPointPopupModel?.({ acquiredAt: result.acquiredAt, status: "clear", temperatureC: result.temperature })?.subtitle,
        lines: [Number.isFinite(result.density)
          ? `${t("landsatGreen.popupValues", {
            density: formatNumber(result.density, 1),
            area: formatNumber(surroundingAreaHa(result.density), 2),
            temperature: formatNumber(result.temperature, 1),
          })} ${t("landsatGreen.maskedArea", { area: formatNumber(result.maskedAreaM2 / 10_000, 4) })}`
          : t("landsatGreen.popupTemperatureOnly", { temperature: formatNumber(result.temperature, 1) })],
      };
    },
    getPanelModel(record) {
      const selector = greenClassSelector(manifest, selectedGreen);
      const points = pixelPoints(record);
      const regression = ordinaryLeastSquares(
        points.map(([density, temperature]) => ({ density, temperature })), "density", "temperature",
      );
      if (regression) regression.analysedAreaHa = points.reduce((sum, point) => sum + point[2], 0) / 10_000;
      return {
        template: "sealed-urban-scatter", comparisonId: "landsat-groenkaart", record,
        title: t("landsatGreen.chartTitle"), definition: t("landsatGreen.definition"),
        xLabel: t("sealedUrban.axisVegetationCover100m"), yLabel: t("sealedUrban.axisTemperature"),
        xKey: "density", yKey: "temperature", pixelPoints: points,
        regression,
        areaLabelKey: "sealedUrban.exactArea",
        slopeScale: 10, slopeUnit: t("landsatGreen.slopeUnit"), observation: observation(),
        selectedClasses: [...selectedGreen],
        selectedClassLabels: selector.items.filter((item) => item.selected).map((item) => item.label),
        selectedSurfaceLabels: manifest.urbanSurfaceGroups.filter(({ id }) => selectedUrban.has(id))
          .map(({ id }) => t(`sealedUrban.surface.${id}`)),
        methodology: t("landsatGreen.methodology"), caveat: t("sealedUrban.pixelRegressionCaveat"),
      };
    },
  };
}
