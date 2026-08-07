import { t } from "../i18n.js";

/**
 * The navigation hierarchy is deliberately shallow. Categories group peer map
 * views without hiding them, while each layer retains its own secondary
 * controls and session state.
 */
export const LAYER_CATEGORIES = Object.freeze([
  Object.freeze({ id: "heat", labelKey: "layerCategory.heat" }),
  Object.freeze({ id: "land-green", labelKey: "layerCategory.landGreen" }),
  Object.freeze({ id: "demography", labelKey: "layerCategory.demography" }),
]);

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
