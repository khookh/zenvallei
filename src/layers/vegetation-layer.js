import { formatNumber, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { defineLayer } from "./layer-contract.js";

const MAP_LAYER_ID = "likely-vegetation-raster";
const SOURCE_ID = "likely-vegetation-image";

/** Create the Sentinel-2 NDVI-based likely-vegetation layer. */
export function createVegetationLayer({ vegetation }) {
  const year = () => vegetation?.activeYear ?? 2023;
  const yearData = () => vegetation?.years?.[year()];

  return defineLayer({
    id: "vegetation",
    isAvailable: () => Boolean(vegetation?.available && yearData()?.imageUrl),
    getUnavailableReasonKey: () => vegetation?.loadError
      ? "layers.vegetationLoadError"
      : "layers.vegetationUnavailable",
    getLabel: () => t("layers.vegetation", { year: year() }),
    getDatasetStatus: () => t("dataset.readyVegetation", { year: year() }),
    getContext: () => ({
      meta: t("layers.context.vegetationMeta", { year: year() }),
      text: t("layers.context.vegetationText", { year: year() }),
    }),
    getLegendModel: () => ({
      title: t("legend.vegetationTitle", { year: year() }),
      note: `NDVI ≥ ${formatNumber(yearData()?.threshold, 3)}`,
      layout: "groups",
      groups: [{
        items: [
          { label: t("vegetation.likelyVegetated"), color: vegetation?.palette?.likelyVegetated ?? "#238B45" },
          { label: t("vegetation.belowThreshold"), color: vegetation?.palette?.belowThreshold ?? "#D9DEDA" },
          {
            label: t("vegetation.excludedNoObservation"),
            color: "repeating-linear-gradient(135deg, #fff 0 3px, #d9deda 3px 6px)",
          },
        ],
      }],
    }),
    getPopupModel: (feature) => {
      const stats = yearData()?.sectorStats?.[feature.properties.sectorId];
      return {
        title: feature.properties.sectorName,
        subtitle: feature.properties.municipality,
        lines: [stats
          ? `${t("vegetation.likelyVegetated")}: ${t("unit.percentage", { value: formatNumber(stats.likelyVegetatedPercentage) })} · ${t("vegetation.medianNdvi")}: ${formatNumber(stats.medianNdvi, 3)}`
          : t("vegetation.noData")],
      };
    },
    getPanelModel: (record, shared) => ({
      template: "vegetation",
      record,
      methodology: shared.methodology,
      landCover: shared.landCover,
      urbanAtlas: shared.urbanAtlas,
      vegetation,
    }),
    mount(map, { beforeLayerId }) {
      if (map.getLayer(MAP_LAYER_ID)) return true;
      if (!yearData()?.imageUrl) return false;
      map.addSource(SOURCE_ID, {
        type: "image",
        url: yearData().imageUrl,
        coordinates: yearData().coordinates,
      });
      map.addLayer({
        id: MAP_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": vegetation.opacity ?? 0.68,
          "raster-resampling": "nearest",
        },
      }, beforeLayerId);
      return true;
    },
    setVisible(map, visible) {
      if (map.getLayer(MAP_LAYER_ID)) map.setLayoutProperty(MAP_LAYER_ID, "visibility", visible ? "visible" : "none");
    },
    applyFilter() {},
    getAttributions() {
      if (!vegetation?.available || !vegetation?.source?.productUrl) return [];
      return [
        `<a href="${escapeHtml(safeExternalUrl(vegetation.source.productUrl))}" target="_blank" rel="noopener noreferrer">Derived using European Union Copernicus Sentinel-2 information</a>`,
      ];
    },
  });
}
