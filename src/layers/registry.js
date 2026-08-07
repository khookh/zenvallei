import { createLayerRegistry } from "./layer-contract.js";
import { createHeatLayer } from "./heat-layer.js";
import { createUrbanAtlasLayer } from "./urban-atlas-layer.js";
import { createNotebookTestLayer } from "./notebook-test-layer.js";
import { createIncomeLayer } from "./income-layer.js";
import { validateLayerCategories } from "./categories.js";

/**
 * This is the only registration point for map datasets. A new layer should not
 * require changes to the application or MapLibre controller.
 */
export function buildLayerRegistry(data, options = {}) {
  const layers = [
    createHeatLayer({
      scores: data.scores,
      methodology: data.methodology,
      initialMetric: options.initialHeatMetric,
    }),
    createUrbanAtlasLayer({ urbanAtlas: data.urbanAtlas }),
    createIncomeLayer({ income: data.income }),
  ];
  if (options.playground) layers.push(createNotebookTestLayer({ notebookTest: data.notebookTest }));
  if (options.extraLayers) layers.push(...options.extraLayers);
  return validateLayerCategories(createLayerRegistry(layers));
}
