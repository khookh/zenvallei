/** Local-only raster exported by the standalone Python notebook playground. */
import { formatNumber, getLanguage, t } from "../i18n.js";
import { defineLayer } from "./layer-contract.js";

const MAP_LAYER_ID = "notebook-test-raster";
const SOURCE_ID = "notebook-test-image";

const translated = (value, fallback = "") => {
  if (typeof value === "string") return value;
  return value?.[getLanguage()] ?? value?.en ?? value?.nl ?? fallback;
};

function validateManifest(manifest) {
  if (!manifest?.available) return manifest;
  if (manifest.schemaVersion !== 1) throw new TypeError("Notebook Test manifest uses an unsupported schema version.");
  if (!['continuous', 'categorical'].includes(manifest.kind)) throw new TypeError("Notebook Test manifest has an invalid kind.");
  if (!manifest.imageUrl || !Array.isArray(manifest.coordinates) || manifest.coordinates.length !== 4) {
    throw new TypeError("Notebook Test manifest is missing its image or coordinates.");
  }
  if (!Array.isArray(manifest.legend?.items) || !manifest.legend.items.length) {
    throw new TypeError("Notebook Test manifest requires a non-empty legend.");
  }
  return manifest;
}

export function createNotebookTestLayer({ notebookTest }) {
  let manifest;
  try {
    manifest = validateManifest(notebookTest);
  } catch (error) {
    manifest = { available: false, loadError: error.message };
  }
  let activeMunicipality = "";
  let displayedImageUrl = "";
  const imageUrl = () => manifest?.rasterVariants?.[activeMunicipality || "all"] ?? manifest?.imageUrl;
  const statsFor = (record) => record.scope === "municipality"
    ? manifest?.municipalityStats?.[record.municipality]
    : manifest?.sectorStats?.[record.sectorId];
  const updateImage = (map) => {
    const source = map.getSource(SOURCE_ID);
    const nextUrl = imageUrl();
    if (!source?.updateImage || !nextUrl || nextUrl === displayedImageUrl) return;
    displayedImageUrl = nextUrl;
    source.updateImage({ url: nextUrl, coordinates: manifest.coordinates });
  };

  return defineLayer({
    id: "notebook-test",
    categoryId: "land-green",
    supportsMunicipalitySummary: true,
    isAvailable: () => Boolean(manifest?.available && imageUrl()),
    getUnavailableReasonKey: () => manifest?.missing
      ? "layers.notebookTestMissing"
      : "layers.notebookTestLoadError",
    getLabel: () => t("layers.notebookTest"),
    getContext: () => ({
      meta: t("layers.context.notebookTestMeta"),
      text: translated(manifest?.description, t("layers.context.notebookTestText")),
    }),
    getLegendModel: () => ({
      title: translated(manifest?.title, t("layers.notebookTest")),
      note: manifest?.units ?? "",
      footnote: t("legend.notebookTestFootnote"),
      layout: "groups",
      groups: [{
        items: (manifest?.legend?.items ?? []).map((item) => ({
          label: translated(item.label, String(item.value ?? "")),
          color: item.color,
        })),
      }],
    }),
    getPopupModel: (feature, record) => {
      const stats = statsFor(record ?? { sectorId: feature.properties.sectorId });
      return {
        title: feature.properties.sectorName,
        subtitle: feature.properties.municipality,
        lines: [stats
          ? manifest.kind === "continuous"
            ? `${t("notebookTest.median")}: ${formatNumber(stats.median, 4)} ${manifest.units ?? ""}`.trim()
            : t("notebookTest.classifiedArea", { value: formatNumber(stats.validAreaHa) })
          : t("notebookTest.noData")],
      };
    },
    getPanelModel: (record) => ({ template: "notebook-test", record, manifest, stats: statsFor(record) }),
    mount(map, { beforeLayerId }) {
      if (map.getLayer(MAP_LAYER_ID)) return true;
      if (!imageUrl()) return false;
      map.addSource(SOURCE_ID, { type: "image", url: imageUrl(), coordinates: manifest.coordinates });
      displayedImageUrl = imageUrl();
      map.addLayer({
        id: MAP_LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "raster-opacity": manifest.opacity ?? 0.68,
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
  });
}
