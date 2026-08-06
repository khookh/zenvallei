/** Prepared Sentinel-2 NDVI indication using an observation-specific Greenwave calibration. */
import { formatDate, formatNumber, t } from "../i18n.js";
import { escapeHtml, safeExternalUrl } from "../security.js";
import { defineLayer } from "./layer-contract.js";

const MAP_LAYER_ID = "likely-vegetation-raster";
const SOURCE_ID = "likely-vegetation-image";

/** Create the Sentinel-2 NDVI-based likely-vegetation layer. */
export function createVegetationLayer({ vegetation }) {
  let activeYear = vegetation?.activeYear ?? 2020;
  let activeMunicipality = "";
  let displayedImageUrl = "";
  const year = () => activeYear;
  const yearData = () => vegetation?.years?.[year()];
  const imageUrl = () => yearData()?.rasterVariants?.[activeMunicipality || "all"] ?? yearData()?.imageUrl;
  const updateImage = (map) => {
    const source = map.getSource(SOURCE_ID);
    const nextUrl = imageUrl();
    if (!source?.updateImage || !nextUrl || nextUrl === displayedImageUrl) return;
    displayedImageUrl = nextUrl;
    source.updateImage({ url: nextUrl, coordinates: yearData().coordinates });
  };

  return defineLayer({
    id: "vegetation",
    categoryId: "land-green",
    supportsMunicipalitySummary: true,
    isAvailable: () => Boolean(vegetation?.available && imageUrl()),
    getUnavailableReasonKey: () => vegetation?.loadError
      ? "layers.vegetationLoadError"
      : "layers.vegetationUnavailable",
    getLabel: () => t("layers.vegetation", { year: year() }),
    getDatasetStatus: () => t("dataset.readyVegetation", { year: year() }),
    getContext: () => ({
      meta: t("layers.context.vegetationMeta", { date: formatDate(yearData()?.acquisitionDate) }),
      text: t("layers.context.vegetationText", { year: year() }),
    }),
    getLegendModel: () => ({
      title: t("legend.vegetationTitle", { year: year() }),
      note: `NDVI ≥ ${formatNumber(yearData()?.threshold, 3)}`,
      footnote: t("legend.vegetationFootnote"),
      layout: "groups",
      groups: [{
        items: [
          { label: t("vegetation.likelyVegetated"), color: vegetation?.palette?.likelyVegetated ?? "#238B45" },
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
      if (!imageUrl()) return false;
      map.addSource(SOURCE_ID, {
        type: "image",
        url: imageUrl(),
        coordinates: yearData().coordinates,
      });
      displayedImageUrl = imageUrl();
      map.addLayer({
        id: MAP_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": vegetation.opacity ?? 0.68,
          "raster-resampling": "nearest",
          "raster-fade-duration": 0,
        },
      }, beforeLayerId);
      return true;
    },
    setVisible(map, visible) {
      if (map.getLayer(MAP_LAYER_ID)) map.setLayoutProperty(MAP_LAYER_ID, "visibility", visible ? "visible" : "none");
    },
    applyFilter(map, _filter, context = {}) {
      activeMunicipality = context.municipality ?? "";
      updateImage(map);
    },
    setOption(map, name, value) {
      if (name !== "year") return false;
      const nextYear = Number(value);
      if (!vegetation?.availableYears?.includes(nextYear) || !vegetation.years?.[nextYear]) return false;
      activeYear = nextYear;
      vegetation.activeYear = nextYear;
      updateImage(map);
      return true;
    },
    getOption(name) {
      return name === "year" ? activeYear : null;
    },
    getAttributions() {
      if (!vegetation?.available || !vegetation?.source?.productUrl) return [];
      return [
        `<a href="${escapeHtml(safeExternalUrl(vegetation.source.productUrl))}" target="_blank" rel="noopener noreferrer">Derived using European Union Copernicus Sentinel-2 information</a>`,
      ];
    },
  });
}
