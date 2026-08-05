// @ts-check

/**
 * A map layer owns the meaning and visualisation of one dataset. The app shell
 * only coordinates these methods; it does not need to understand the dataset.
 *
 * @typedef {Object} LayerDefinition
 * @property {string} id Stable identifier used by controls and application state.
 * @property {() => boolean} isAvailable Whether the prepared browser asset can be used.
 * @property {() => string} getLabel Current translated layer label.
 * @property {(context: object) => string} getDatasetStatus Current translated status text.
 * @property {(context: object) => {meta: string, text: string}} getContext First-glance explanation.
 * @property {() => LegendModel} getLegendModel Plain data consumed by the legend UI.
 * @property {(feature: object, record: object) => PopupModel} getPopupModel Plain popup content.
 * @property {(record: object, shared: object) => SectorPanelModel} getPanelModel Plain panel content.
 * @property {(map: object, context: MapLayerContext) => Promise<boolean>|boolean} mount Add sources and layers lazily.
 * @property {(map: object, visible: boolean) => void} setVisible Toggle MapLibre visibility.
 * @property {(map: object, filter: object|null) => void} applyFilter Apply the shared municipality filter.
 * @property {() => string[]} [getAttributions] Safe attribution HTML fragments.
 * @property {() => string} [getUnavailableReasonKey] Translation key for unavailable assets.
 * @property {() => SecondaryControlModel|null} [getSecondaryControl] Optional nested control.
 * @property {(map: object, name: string, value: string) => boolean} [setOption] Update a layer-specific option.
 * @property {(name: string) => string|null} [getOption] Read a layer-specific option.
 */

/** @typedef {{title: string, note?: string, layout: "scale"|"groups", groups: Array<{title?: string, items: Array<{label: string, color: string, value?: string}>}>}} LegendModel */
/** @typedef {{title: string, subtitle?: string, lines: string[]}} PopupModel */
/** @typedef {{template: string, [key: string]: unknown}} SectorPanelModel */
/** @typedef {{id: string, ariaLabel: string, options: Array<{id: string, label: string, active: boolean}>}} SecondaryControlModel */
/** @typedef {{sectorSourceId: string, beforeLayerId?: string}} MapLayerContext */

const REQUIRED_METHODS = Object.freeze([
  "isAvailable",
  "getLabel",
  "getDatasetStatus",
  "getContext",
  "getLegendModel",
  "getPopupModel",
  "getPanelModel",
  "mount",
  "setVisible",
  "applyFilter",
]);

/**
 * Validate layer modules at startup so extension mistakes fail with a useful
 * message instead of surfacing later as an obscure MapLibre error.
 *
 * @param {LayerDefinition} definition
 * @returns {LayerDefinition}
 */
export function defineLayer(definition) {
  if (!definition || typeof definition !== "object") throw new TypeError("Layer definition must be an object.");
  if (!definition.id || typeof definition.id !== "string") throw new TypeError("Layer definition requires a string id.");
  REQUIRED_METHODS.forEach((method) => {
    if (typeof definition[method] !== "function") {
      throw new TypeError(`Layer '${definition.id}' is missing ${method}().`);
    }
  });
  return Object.freeze(definition);
}

/**
 * @param {LayerDefinition[]} layers
 * @returns {Map<string, LayerDefinition>}
 */
export function createLayerRegistry(layers) {
  const registry = new Map();
  layers.forEach((layer) => {
    const validLayer = defineLayer(layer);
    if (registry.has(validLayer.id)) throw new Error(`Duplicate layer id '${validLayer.id}'.`);
    registry.set(validLayer.id, validLayer);
  });
  return registry;
}
