import { formatNumber, t } from "../i18n.js";
import { defineLayer } from "./layer-contract.js";
import { escapeHtml, safeExternalUrl } from "../security.js";

const MAP_LAYER_ID = "land-cover-raster";
const SOURCE_ID = "land-cover-image";

function classDefinition(landCover, code) {
  return landCover?.classes?.find((entry) => entry.code === code);
}

/** Create the Copernicus LCM-10 image layer. */
export function createLandCoverLayer({ landCover }) {
  const year = () => landCover?.activeYear ?? 2020;

  return defineLayer({
    id: "land-cover",
    isAvailable: () => Boolean(landCover?.raster?.available && landCover.raster.imageUrl),
    getUnavailableReasonKey: () => "layers.landCoverUnavailable",
    getLabel: () => t("layers.landCover", { year: year() }),
    getDatasetStatus: () => t("dataset.readyLandCover", { year: year() }),
    getContext: () => ({
      meta: t("layers.context.landCoverMeta", { year: year() }),
      text: t("layers.context.landCoverText", { year: year() }),
    }),
    getLegendModel: () => ({
      title: t("legend.landCoverTitle", { year: year() }),
      note: "LCM-10",
      layout: "groups",
      groups: [{
        items: (landCover?.classes ?? [])
          .filter((entry) => entry.present)
          .map((entry) => ({ label: t(`class.${entry.key}`), color: entry.color })),
      }],
    }),
    getPopupModel: (feature) => {
      const stats = landCover?.sectorStats?.[feature.properties.sectorId];
      const dominant = classDefinition(landCover, stats?.dominantClassCode);
      return {
        title: feature.properties.sectorName,
        subtitle: feature.properties.municipality,
        lines: [dominant
          ? `${t(`class.${dominant.key}`)} · ${t("landCover.vegetation")}: ${t("unit.percentage", { value: formatNumber(stats.vegetationPercentage) })}`
          : t("landCover.noData")],
      };
    },
    getPanelModel: (record, shared) => ({
      template: "land-cover",
      record,
      methodology: shared.methodology,
      landCover,
      urbanAtlas: shared.urbanAtlas,
    }),
    mount(map, { beforeLayerId }) {
      if (map.getLayer(MAP_LAYER_ID)) return true;
      if (!landCover?.raster?.available) return false;
      map.addSource(SOURCE_ID, {
        type: "image",
        url: landCover.raster.imageUrl,
        coordinates: landCover.raster.coordinates,
      });
      map.addLayer({
        id: MAP_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": landCover.opacity ?? 0.68,
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
      if (!landCover?.raster?.available) return [];
      const links = [
        '<a href="https://land.copernicus.eu/en/data-policy" target="_blank" rel="noopener noreferrer">Generated using European Union\'s Copernicus Land Monitoring Service information</a>',
      ];
      if (landCover?.source?.doi) links.push(`<a href="${escapeHtml(safeExternalUrl(landCover.source.doi))}" target="_blank" rel="noopener noreferrer">DOI</a>`);
      return links;
    },
  });
}
