/** Copernicus Urban Atlas polygons and Greenwave's equal-area summaries. */
import { formatNumber, t } from "../i18n.js";
import { defineLayer } from "./layer-contract.js";
import { escapeHtml, safeExternalUrl } from "../security.js";

const MAP_LAYER_ID = "urban-atlas-fill";
const SOURCE_ID = "urban-atlas";

/** Create the detailed Copernicus Urban Atlas polygon layer. */
export function createUrbanAtlasLayer({ urbanAtlas }) {
  let loadPromise = null;
  let loadFailed = false;
  const year = () => urbanAtlas?.activeYear ?? 2021;

  return defineLayer({
    id: "urban-atlas",
    categoryId: "land-green",
    isAvailable: () => Boolean(!loadFailed && urbanAtlas?.available && urbanAtlas.geojsonUrl),
    getUnavailableReasonKey: () => loadFailed || urbanAtlas?.loadError
      ? "layers.urbanAtlasLoadError"
      : "layers.urbanAtlasUnavailable",
    getLabel: () => t("layers.urbanAtlas", { year: year() }),
    getDatasetStatus: () => t("dataset.readyUrbanAtlas", { year: year() }),
    getContext: () => ({
      meta: t("layers.context.urbanAtlasMeta", { year: year() }),
      text: t("layers.context.urbanAtlasText", { year: year() }),
    }),
    getLegendModel: () => {
      const groupOrder = ["artificialSurfaces", "greenUrbanAreas", "agricultureSemiNatural", "wetlands", "water", "noData"];
      const presentClasses = (urbanAtlas?.classes ?? []).filter((entry) => entry.present);
      return {
        title: t("legend.urbanAtlasTitle", { year: year() }),
        note: `UA ${year()}`,
        layout: "groups",
        groups: groupOrder.map((groupKey) => ({
          title: t(`urbanAtlas.group.${groupKey}`),
          items: presentClasses
            .filter((entry) => entry.groupKey === groupKey)
            .map((entry) => ({ label: t(`urbanAtlas.class.${entry.code}`), color: entry.color })),
        })).filter((group) => group.items.length),
      };
    },
    getPopupModel: (feature) => {
      const stats = urbanAtlas?.sectorStats?.[feature.properties.sectorId];
      return {
        title: feature.properties.sectorName,
        subtitle: feature.properties.municipality,
        lines: [stats
          ? `${t("urbanAtlas.greenCoverage")}: ${t("unit.percentage", { value: formatNumber(stats.green.percentage) })} · ${t("urbanAtlas.artificialisation")}: ${t("unit.percentage", { value: formatNumber(stats.artificial.percentage) })}`
          : t("urbanAtlas.noData")],
      };
    },
    getPanelModel: (record, shared) => ({
      template: "urban-atlas",
      record,
      methodology: shared.methodology,
      landCover: shared.landCover,
      urbanAtlas,
      vegetation: shared.vegetation,
    }),
    async mount(map, { beforeLayerId }) {
      if (map.getLayer(MAP_LAYER_ID)) return true;
      if (loadPromise) return loadPromise;
      if (!urbanAtlas?.available || !urbanAtlas.geojsonUrl) return false;

      loadPromise = (async () => {
        performance.clearMarks("urban-atlas-load-start");
        performance.clearMarks("urban-atlas-load-ready");
        performance.mark("urban-atlas-load-start");
        const response = await fetch(urbanAtlas.geojsonUrl);
        if (!response.ok) throw new Error(`urban-atlas.geojson: HTTP ${response.status}`);
        const data = await response.json();
        if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) || !data.features.length) {
          throw new Error("urban-atlas.geojson is not a valid FeatureCollection.");
        }
        if (data.features.some((feature) => feature.geometry?.type !== "MultiPolygon"
          || !feature.properties?.sectorId || !feature.properties?.classCode)) {
          throw new Error("urban-atlas.geojson contains an invalid sector fragment.");
        }
        const matchColors = urbanAtlas.classes.flatMap((entry) => [String(entry.code), entry.color]);
        map.addSource(SOURCE_ID, { type: "geojson", data });
        map.addLayer({
          id: MAP_LAYER_ID,
          type: "fill",
          source: SOURCE_ID,
          layout: { visibility: "none" },
          paint: {
            "fill-color": ["match", ["to-string", ["get", "classCode"]], ...matchColors, "#000000"],
            "fill-opacity": urbanAtlas.opacity ?? 0.68,
          },
        }, beforeLayerId);
        await new Promise((resolve, reject) => {
          const deadline = performance.now() + 10_000;
          const poll = () => {
            if (map.getSource(SOURCE_ID)?.loaded?.()) return requestAnimationFrame(resolve);
            if (performance.now() >= deadline) return reject(new Error("Urban Atlas overlay did not render within ten seconds."));
            window.setTimeout(poll, 16);
          };
          poll();
        });
        performance.mark("urban-atlas-load-ready");
        performance.measure("urban-atlas-first-render", "urban-atlas-load-start", "urban-atlas-load-ready");
        return true;
      })().catch((error) => {
        if (map.getLayer(MAP_LAYER_ID)) map.removeLayer(MAP_LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        loadPromise = null;
        loadFailed = true;
        throw error;
      });
      return loadPromise;
    },
    setVisible(map, visible) {
      if (map.getLayer(MAP_LAYER_ID)) map.setLayoutProperty(MAP_LAYER_ID, "visibility", visible ? "visible" : "none");
    },
    applyFilter(map, filter) {
      if (map.getLayer(MAP_LAYER_ID)) map.setFilter(MAP_LAYER_ID, filter);
    },
    getAttributions() {
      if (!urbanAtlas?.available) return [];
      const links = [];
      if (urbanAtlas?.source?.doi) links.push(`<a href="${escapeHtml(safeExternalUrl(urbanAtlas.source.doi))}" target="_blank" rel="noopener noreferrer">Urban Atlas DOI</a>`);
      return links;
    },
  });
}
