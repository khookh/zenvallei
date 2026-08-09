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
  "income",
]);

export const LANDSAT_COMPARISON_IDS = Object.freeze([
  "landsat-urban-atlas",
  "landsat-jaarbak",
]);

export const LAYER_ACTIONS = Object.freeze({
  heat: "comparison-preview",
  "landsat-temperature": "compare",
  jaarbak: "density",
  groenkaart: "density",
});

export function validateProductContract(registry, comparisons, { playground = false } = {}) {
  const expectedLayers = playground ? [...PUBLIC_LAYER_IDS, "notebook-test"] : PUBLIC_LAYER_IDS;
  const observedLayers = [...registry.keys()];
  const missingLayers = expectedLayers.filter((id) => !observedLayers.includes(id));
  const unexpectedLayers = observedLayers.filter((id) => !expectedLayers.includes(id));
  if (missingLayers.length || unexpectedLayers.length) {
    throw new Error(`Layer contract mismatch. Missing: ${missingLayers.join(", ") || "none"}; unexpected: ${unexpectedLayers.join(", ") || "none"}.`);
  }
  const observedComparisons = [...comparisons.keys()];
  const missingComparisons = LANDSAT_COMPARISON_IDS.filter((id) => !observedComparisons.includes(id));
  const unexpectedComparisons = observedComparisons.filter((id) => !LANDSAT_COMPARISON_IDS.includes(id));
  if (missingComparisons.length || unexpectedComparisons.length) {
    throw new Error(`Comparison contract mismatch. Missing: ${missingComparisons.join(", ") || "none"}; unexpected: ${unexpectedComparisons.join(", ") || "none"}.`);
  }
  return true;
}
