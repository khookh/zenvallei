/** Population density from a current Statbel grid and a separate 2019 model. */
import { formatNumber, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { authorityLink, authorityName } from "../source-authorities.js";
import { defineLayer } from "./layer-contract.js";

const DATASETS = Object.freeze(["statbel-2025", "flanders-2019"]);
const GRID_SOURCE_ID = "population-grid-2025-source";
const GRID_LAYER_ID = "population-grid-2025-fill";
const RASTER_SOURCE_ID = "population-density-2019-source";
const RASTER_LAYER_ID = "population-density-2019-raster";

export function validatePopulationManifest(population) {
  if (!population || population.schemaVersion !== 1 || population.datasetId !== "population-density"
    || population.kind !== "dataset-switch" || population.defaultDataset !== DATASETS[0]
    || JSON.stringify(population.availableDatasets) !== JSON.stringify(DATASETS)
    || !Array.isArray(population.bands) || population.bands.length !== 8) {
    throw new TypeError("Unsupported population-density manifest.");
  }
  DATASETS.forEach((datasetId) => {
    const dataset = population.datasets?.[datasetId];
    if (!dataset || Object.keys(dataset.sectorStats ?? {}).length !== 154
      || !dataset.municipalityStats || !dataset.regionStats) {
      throw new TypeError(`Population dataset '${datasetId}' is incomplete.`);
    }
  });
  return population;
}

export function populationDensityExpression(population) {
  const colors = Object.fromEntries(population.bands.map((band) => [band.id, band.color]));
  return [
    "step", ["to-number", ["get", "densityPerHa"]],
    colors.zero,
    0.000001, colors["under-5"],
    5, colors["5-15"],
    15, colors["15-30"],
    30, colors["30-60"],
    60, colors["60-100"],
    100, colors["100-200"],
    200, colors["200-plus"],
  ];
}

function bandLabel(band) {
  if (band.id === "zero") return t("population.bandZero");
  if (band.maximum === null) return t("population.bandOver", { value: formatNumber(band.minimum, 0) });
  if (band.id === "under-5") return t("population.bandUnder", { value: formatNumber(band.maximum, 0) });
  return t("population.bandRange", {
    minimum: formatNumber(band.minimum, 0), maximum: formatNumber(band.maximum, 0),
  });
}

function statsFor(dataset, record) {
  if (record.scope === "region") return dataset.regionStats;
  if (record.scope === "municipality") return dataset.municipalityStats?.[record.municipality] ?? null;
  return dataset.sectorStats?.[record.sectorId] ?? null;
}

function imageVariant(dataset, municipality) {
  return dataset.imageVariants?.[municipality || "all"] ?? dataset.imageVariants?.all;
}

/** Create the Demography layer while keeping its two source methods explicit. */
export function createPopulationLayer({ population: input }) {
  const population = validatePopulationManifest(input);
  let activeDatasetId = population.defaultDataset;
  let activeMunicipality = "";
  let visible = false;
  let mapInstance = null;
  let beforeLayer = null;
  let rasterAnalysisPromise = null;

  const activeDataset = () => population.datasets[activeDatasetId];
  const syncVisibility = (map) => {
    if (map.getLayer(GRID_LAYER_ID)) {
      map.setLayoutProperty(GRID_LAYER_ID, "visibility", visible && activeDatasetId === DATASETS[0] ? "visible" : "none");
    }
    if (map.getLayer(RASTER_LAYER_ID)) {
      map.setLayoutProperty(RASTER_LAYER_ID, "visibility", visible && activeDatasetId === DATASETS[1] ? "visible" : "none");
    }
    map.triggerRepaint();
  };
  const ensureRasterLayer = (map, beforeLayerId) => {
    if (map.getLayer(RASTER_LAYER_ID)) return;
    const dataset = population.datasets[DATASETS[1]];
    map.addSource(RASTER_SOURCE_ID, {
      type: "image",
      url: imageVariant(dataset, activeMunicipality),
      coordinates: dataset.corners,
    });
    map.addLayer({
      id: RASTER_LAYER_ID,
      type: "raster",
      source: RASTER_SOURCE_ID,
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.78, "raster-resampling": "nearest" },
    }, beforeLayerId);
  };
  const updateRasterVariant = (map) => {
    if (!map.getSource(RASTER_SOURCE_ID)) return;
    const dataset = population.datasets[DATASETS[1]];
    map.getSource(RASTER_SOURCE_ID).updateImage({
      url: imageVariant(dataset, activeMunicipality),
      coordinates: dataset.corners,
    });
  };
  const openRasterAnalysis = () => {
    if (!rasterAnalysisPromise) {
      const url = population.datasets[DATASETS[1]].analyticalUrl;
      rasterAnalysisPromise = Promise.all([import("geotiff"), import("proj4")]).then(async ([geotiff, proj4Module]) => {
        const tiff = await geotiff.fromUrl(url);
        const image = await tiff.getImage();
        return { image, proj4: proj4Module.default ?? proj4Module };
      });
    }
    return rasterAnalysisPromise;
  };

  return defineLayer({
    id: "population",
    categoryId: "demography",
    supportsMunicipalitySummary: true,
    supportsRegionSummary: true,
    isAvailable: () => true,
    getLabel: () => t("layers.population"),
    getContext: () => activeDatasetId === DATASETS[0] ? {
      meta: t("population.currentContextMeta"),
      text: t("population.currentContextText"),
      note: t("population.currentContextNote"),
      sources: [authorityLink("statbel", activeDataset().source.pageUrl)],
    } : {
      meta: t("population.modelContextMeta"),
      text: t("population.modelContextText"),
      note: t("population.modelContextNote"),
      sources: [authorityLink("departmentEnvironment", activeDataset().source.pageUrl)],
    },
    getLegendModel: () => ({
      title: t("population.legendTitle"),
      note: t(activeDatasetId === DATASETS[0] ? "population.legendCurrentNote" : "population.legendModelNote"),
      footnote: t(activeDatasetId === DATASETS[0] ? "population.legendCurrentFootnote" : "population.legendModelFootnote"),
      layout: "groups",
      groups: [{
        items: [
          ...population.bands.map((band) => ({ label: bandLabel(band), color: band.color })),
          { label: t("population.noData"), color: population.noDataColor },
        ],
      }],
    }),
    getPopupModel: (feature, record) => {
      const stats = statsFor(activeDataset(), record);
      return {
        title: feature.properties.sectorName,
        subtitle: t(activeDatasetId === DATASETS[0] ? "population.currentDataset" : "population.modelDataset"),
        lines: stats?.sourceStatus === "available" ? [
          t("population.popupPopulation", { value: formatNumber(stats.population, 0) }),
          t("population.popupDensity", { value: formatNumber(stats.densityPerHa, 1) }),
        ] : [t("population.noData")],
      };
    },
    getPanelModel: (record) => ({
      template: "population",
      record,
      population,
      datasetId: activeDatasetId,
      dataset: activeDataset(),
      stats: statsFor(activeDataset(), record),
    }),
    getSecondaryControl: () => ({
      id: "population-dataset",
      optionName: "dataset",
      prompt: t("population.datasetPrompt"),
      ariaLabel: t("population.datasetAriaLabel"),
      options: DATASETS.map((datasetId) => ({
        id: datasetId,
        label: t(datasetId === DATASETS[0] ? "population.currentDataset" : "population.modelDataset"),
        active: datasetId === activeDatasetId,
      })),
    }),
    async mount(map, { beforeLayerId }) {
      mapInstance = map;
      beforeLayer = beforeLayerId;
      if (!map.getSource(GRID_SOURCE_ID)) {
        map.addSource(GRID_SOURCE_ID, {
          type: "geojson",
          data: population.datasets[DATASETS[0]].mapUrl,
          promoteId: "cellId",
        });
      }
      if (!map.getLayer(GRID_LAYER_ID)) {
        map.addLayer({
          id: GRID_LAYER_ID,
          type: "fill",
          source: GRID_SOURCE_ID,
          layout: { visibility: "none" },
          paint: {
            "fill-color": populationDensityExpression(population),
            "fill-opacity": 0.78,
            "fill-outline-color": "rgba(67, 55, 111, 0.28)",
          },
        }, beforeLayerId);
      }
      syncVisibility(map);
      return true;
    },
    setVisible(map, nextVisible) {
      visible = nextVisible;
      syncVisibility(map);
    },
    applyFilter(map, filter) {
      activeMunicipality = filter?.[2] ?? "";
      if (map.getLayer(GRID_LAYER_ID)) map.setFilter(GRID_LAYER_ID, filter);
      updateRasterVariant(map);
    },
    setOption(map, name, value) {
      if (name !== "dataset" || !DATASETS.includes(value)) return false;
      if (value === DATASETS[1]) ensureRasterLayer(map, beforeLayer);
      activeDatasetId = value;
      updateRasterVariant(map);
      syncVisibility(map);
      return true;
    },
    getOption: (name) => name === "dataset" ? activeDatasetId : null,
    isPointInspectionActive: () => true,
    async inspectPoint(point) {
      if (activeDatasetId === DATASETS[0]) {
        const rendered = mapInstance?.queryRenderedFeatures(mapInstance.project([point.lng, point.lat]), { layers: [GRID_LAYER_ID] }) ?? [];
        const properties = rendered[0]?.properties;
        return properties ? {
          datasetId: activeDatasetId,
          population: Number(properties.population),
          densityPerHa: Number(properties.densityPerHa),
          sideM: Number(properties.sideM),
        } : { datasetId: activeDatasetId, unavailable: true };
      }
      const { image, proj4 } = await openRasterAnalysis();
      const [x, y] = proj4("EPSG:4326", "+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs", [point.lng, point.lat]);
      const [minX, minY, maxX, maxY] = image.getBoundingBox();
      if (x < minX || x >= maxX || y < minY || y >= maxY) return { datasetId: activeDatasetId, unavailable: true };
      const [resolutionX, resolutionYRaw] = image.getResolution();
      const column = Math.floor((x - minX) / resolutionX);
      const row = Math.floor((maxY - y) / Math.abs(resolutionYRaw));
      const [values] = await image.readRasters({ window: [column, row, column + 1, row + 1] });
      const value = Number(values[0]);
      return value >= 0
        ? { datasetId: activeDatasetId, population: value, densityPerHa: value, sideM: 100 }
        : { datasetId: activeDatasetId, unavailable: true };
    },
    getPointPopupModel(result) {
      if (!result || result.unavailable) {
        return { title: t("layers.population"), lines: [t("population.noData")] };
      }
      return result.datasetId === DATASETS[0] ? {
        title: t("population.currentCellTitle"),
        subtitle: t("population.currentDataset"),
        lines: [
          t("population.cellPopulation", { value: formatNumber(result.population, 0) }),
          t("population.cellDensity", { value: formatNumber(result.densityPerHa, 1) }),
          t("population.cellSize", { value: formatNumber(result.sideM, 0) }),
        ],
      } : {
        title: t("population.modelCellTitle"),
        subtitle: t("population.modelDataset"),
        lines: [
          t("population.cellEstimatedPopulation", { value: formatNumber(result.population, 1) }),
          t("population.cellDensity", { value: formatNumber(result.densityPerHa, 1) }),
        ],
      };
    },
    getAttributions() {
      return DATASETS.flatMap((datasetId) => {
        const source = population.datasets[datasetId].source;
        const url = safeExternalUrl(source.pageUrl);
        const authorityId = datasetId === DATASETS[0] ? "statbel" : "departmentEnvironment";
        return url ? [`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(authorityName(authorityId))}</a>`] : [];
      });
    },
  });
}
