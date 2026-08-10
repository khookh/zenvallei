// @ts-check

/**
 * A map layer owns the meaning and visualisation of one dataset. The app shell
 * only coordinates these methods; it does not need to understand the dataset.
 *
 * @typedef {Object} LayerDefinition
 * @property {string} id Stable identifier used by controls and application state.
 * @property {string} categoryId Stable navigation category identifier.
 * @property {boolean} [supportsMunicipalitySummary] Whether the panel can aggregate selected sectors.
 * @property {boolean} [supportsRegionSummary] Whether the panel has a meaningful complete-region aggregate.
 * @property {() => boolean} isAvailable Whether the prepared browser asset can be used.
 * @property {() => string} getLabel Current translated layer label.
 * @property {(context: object) => {meta: string, text: string, note?: string, sources?: Array<{label:string,url:string}>}} getContext First-glance explanation.
 * @property {() => LegendModel} getLegendModel Plain data consumed by the legend UI.
 * @property {(feature: object, record: object) => PopupModel} getPopupModel Plain popup content.
 * @property {(record: object, shared: object) => SectorPanelModel} getPanelModel Plain panel content.
 * @property {(map: object, context: MapLayerContext) => Promise<boolean>|boolean} mount Add sources and layers lazily.
 * @property {(map: object, visible: boolean) => void} setVisible Toggle MapLibre visibility.
 * @property {(map: object, filter: object|null) => void} applyFilter Apply the shared municipality filter.
 * @property {() => string[]} [getAttributions] Safe attribution HTML fragments.
 * @property {() => string} [getUnavailableReasonKey] Translation key for unavailable assets.
 * @property {() => SecondaryControlModel|null} [getSecondaryControl] Optional nested control.
 * @property {() => TemporalControlModel|null} [getTemporalControl] Optional discrete temporal control.
 * @property {() => object} [getRuntimeData] Read-only, already-loaded data for a comparison module.
 * @property {(map: object, name: string, value: string) => boolean} [setOption] Update a layer-specific option.
 * @property {(name: string) => string|null} [getOption] Read a layer-specific option.
 * @property {(point: {lng:number,lat:number}, context?: {signal?:AbortSignal}) => Promise<object>} [inspectPoint] Optional local pixel or feature inspection.
 * @property {(result: object) => PopupModel} [getPointPopupModel] Format an inspected point without exposing HTML.
 * @property {() => {active:boolean,label:string}|null} [getMapModeAction] Optional classification/density action shown by the app shell.
 * @property {(map: object) => Promise<boolean>} [toggleMapMode] Toggle an optional map presentation without changing the layer.
 * @property {() => boolean} [isPointInspectionActive] Whether map hover/tap should query layer-specific point values.
 * @property {() => number} [getInspectionRadiusMeters] Radius used for the optional point-inspection circle.
 * @property {(listener: () => void) => (() => void)} [subscribeMapMode] Observe map-mode state changes.
 * @property {() => Promise<void>} [waitUntilReady] Resolve when the currently requested temporal map source is ready.
 */

/** @typedef {{title: string, note?: string, footnote?: string, layout: "scale"|"groups", groups: Array<{title?: string, items: Array<{label: string, color: string, value?: string, symbol?: string}>}>}} LegendModel */
/** @typedef {{title: string, subtitle?: string, lines: string[]}} PopupModel */
/** @typedef {{template: string, [key: string]: unknown}} SectorPanelModel */
/** @typedef {{id: string, optionName: string, prompt?: string, ariaLabel: string, options: Array<{id: string, label: string, active: boolean, disabled?: boolean, disabledReason?: string}>}} SecondaryControlModel */
/** @typedef {{optionName: string, values?: Array<string|number>, items?: Array<{value:string|number,label:string,ariaLabel?:string,kind?:string}>, activeValue: string|number, label: string, note?: string, auxiliaryNote?: string, previousLabel: string, nextLabel: string}} TemporalControlModel */
/** @typedef {{sectorSourceId: string, beforeLayerId?: string}} MapLayerContext */

const REQUIRED_METHODS = Object.freeze([
  "isAvailable",
  "getLabel",
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
  if (!definition.categoryId || typeof definition.categoryId !== "string") {
    throw new TypeError(`Layer '${definition.id}' requires a string categoryId.`);
  }
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
