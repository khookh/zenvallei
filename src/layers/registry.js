import { createLayerRegistry } from "./layer-contract.js";
import { createHeatLayer } from "./heat-layer.js";
import { createLandCoverLayer } from "./land-cover-layer.js";
import { createUrbanAtlasLayer } from "./urban-atlas-layer.js";
import { createVegetationLayer } from "./vegetation-layer.js";

/**
 * This is the only registration point for map datasets. A new layer should not
 * require changes to the application or MapLibre controller.
 */
export function buildLayerRegistry(data, options = {}) {
  return createLayerRegistry([
    createHeatLayer({
      scores: data.scores,
      methodology: data.methodology,
      initialMetric: options.initialHeatMetric,
    }),
    createLandCoverLayer({ landCover: data.landCover }),
    createUrbanAtlasLayer({ urbanAtlas: data.urbanAtlas }),
    createVegetationLayer({ vegetation: data.vegetation }),
  ]);
}
