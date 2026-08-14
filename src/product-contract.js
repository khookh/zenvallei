/**
 * The application is intentionally a small, explicit product rather than a
 * plugin host. These identifiers are the release contract exercised by Pages
 * smoke tests and distribution validation.
 */
export const PUBLIC_LAYER_IDS = Object.freeze([
  "heat",
  "landsat-temperature",
  "urban-atlas",
  "jaarbak",
  "groenkaart",
  "landgebruik",
  "population",
  "income",
]);

export const LOCAL_ONLY_LAYER_IDS = Object.freeze([
  "land-cover-scenario",
]);

export const PUBLIC_COMPARISON_IDS = Object.freeze([
  "heat-income",
  "heat-population",
  "landsat-urban-atlas",
  "landsat-jaarbak",
  "landsat-groenkaart",
  "groenkaart-income",
  "groenkaart-population",
  "landsat-income",
  "landsat-population",
]);

export const LAYER_ACTIONS = Object.freeze({
  heat: "compare",
  "landsat-temperature": "compare",
  jaarbak: "density",
  groenkaart: "density",
});

export function validateProductContract(registry, comparisons, { playground = false, localData = false } = {}) {
  const expectedLayers = playground
    ? [...PUBLIC_LAYER_IDS, "notebook-test"]
    : localData ? [...PUBLIC_LAYER_IDS, ...LOCAL_ONLY_LAYER_IDS] : PUBLIC_LAYER_IDS;
  const observedLayers = [...registry.keys()];
  const missingLayers = expectedLayers.filter((id) => !observedLayers.includes(id));
  const unexpectedLayers = observedLayers.filter((id) => !expectedLayers.includes(id));
  if (missingLayers.length || unexpectedLayers.length) {
    throw new Error(`Layer contract mismatch. Missing: ${missingLayers.join(", ") || "none"}; unexpected: ${unexpectedLayers.join(", ") || "none"}.`);
  }
  const expectedComparisons = PUBLIC_COMPARISON_IDS;
  const observedComparisons = [...comparisons.keys()];
  const missingComparisons = expectedComparisons.filter((id) => !observedComparisons.includes(id));
  const unexpectedComparisons = observedComparisons.filter((id) => !expectedComparisons.includes(id));
  if (missingComparisons.length || unexpectedComparisons.length) {
    throw new Error(`Comparison contract mismatch. Missing: ${missingComparisons.join(", ") || "none"}; unexpected: ${unexpectedComparisons.join(", ") || "none"}.`);
  }
  return true;
}
