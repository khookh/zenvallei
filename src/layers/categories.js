import { t } from "../i18n.js";

/**
 * The navigation hierarchy is deliberately shallow. Tabs reveal peer map
 * choices without activating them, while each layer retains its own secondary
 * controls and session state.
 */
export const LAYER_CATEGORIES = Object.freeze([
  Object.freeze({ id: "heat", labelKey: "layerCategory.heat" }),
  Object.freeze({ id: "land-green", labelKey: "layerCategory.landGreen" }),
  Object.freeze({ id: "demography", labelKey: "layerCategory.demography" }),
]);

export const THEMATIC_LAYER_IDS = Object.freeze({
  heat: Object.freeze(["landsat-temperature", "heat"]),
  "land-green": Object.freeze(["urban-atlas", "jaarbak", "groenkaart"]),
  demography: Object.freeze(["population", "income"]),
});

export const SCENARIO_TOOL_ID = "land-cover-scenario";

export function categoryLabel(category) {
  return t(category.labelKey);
}

export function validateLayerCategories(registry) {
  const known = new Set(LAYER_CATEGORIES.map(({ id }) => id));
  registry.forEach((layer) => {
    if (!known.has(layer.categoryId)) {
      throw new TypeError(`Layer '${layer.id}' uses unknown category '${layer.categoryId}'.`);
    }
  });
  return registry;
}
