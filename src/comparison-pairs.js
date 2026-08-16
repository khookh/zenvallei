/**
 * The application has eleven deliberate analyses, not an open-ended plugin
 * system. This table is the single authority for discovery from either layer
 * and for the canonical map presentation used by each analysis.
 */
export const COMPARISON_PAIRS = Object.freeze([
  Object.freeze({ id: "heat-income", layers: ["heat", "income"], canonicalLayerId: "heat" }),
  Object.freeze({ id: "heat-population", layers: ["heat", "population"], canonicalLayerId: "heat" }),
  Object.freeze({ id: "landsat-urban-atlas", layers: ["landsat-temperature", "urban-atlas"], canonicalLayerId: "landsat-temperature" }),
  Object.freeze({ id: "landsat-jaarbak", layers: ["landsat-temperature", "jaarbak"], canonicalLayerId: "landsat-temperature" }),
  Object.freeze({ id: "landsat-groenkaart", layers: ["landsat-temperature", "groenkaart"], canonicalLayerId: "landsat-temperature" }),
  Object.freeze({ id: "groenkaart-income", layers: ["groenkaart", "income"], canonicalLayerId: "groenkaart" }),
  Object.freeze({ id: "groenkaart-population", layers: ["groenkaart", "population"], canonicalLayerId: "groenkaart" }),
  Object.freeze({ id: "landsat-income", layers: ["landsat-temperature", "income"], canonicalLayerId: "landsat-temperature" }),
  Object.freeze({ id: "landsat-population", layers: ["landsat-temperature", "population"], canonicalLayerId: "landsat-temperature" }),
  Object.freeze({ id: "jaarbak-population", layers: ["jaarbak", "population"], canonicalLayerId: "jaarbak" }),
  Object.freeze({ id: "jaarbak-income", layers: ["jaarbak", "income"], canonicalLayerId: "jaarbak" }),
]);

export function comparisonPair(id) {
  return COMPARISON_PAIRS.find((pair) => pair.id === id) ?? null;
}

export function comparisonForLayers(firstLayerId, secondLayerId) {
  return COMPARISON_PAIRS.find(({ layers }) => (
    layers.includes(firstLayerId) && layers.includes(secondLayerId) && firstLayerId !== secondLayerId
  )) ?? null;
}

export function comparisonTargets(layerId, availableComparisonIds = COMPARISON_PAIRS.map(({ id }) => id)) {
  const available = new Set(availableComparisonIds);
  return COMPARISON_PAIRS.flatMap((pair) => {
    if (!available.has(pair.id) || !pair.layers.includes(layerId)) return [];
    return pair.layers.filter((candidate) => candidate !== layerId);
  });
}

export function comparisonContains(pairOrId, layerId) {
  const pair = typeof pairOrId === "string" ? comparisonPair(pairOrId) : pairOrId;
  return Boolean(pair?.layers.includes(layerId));
}
