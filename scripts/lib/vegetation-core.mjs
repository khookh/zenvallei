const NDVI_MIN = -1;
const NDVI_MAX = 1;
const DEFAULT_BIN_SIZE = 0.001;

export const VEGETATION_POSITIVE_CODES = Object.freeze([
  "14110", "14120", "14130", "23000", "31000", "32000",
]);
export const VEGETATION_NEGATIVE_CODES = Object.freeze(["11100", "12210"]);
export const VEGETATION_EXCLUDED_LAND_COVER_CODES = Object.freeze([40]);
export const VEGETATION_EXCLUDED_URBAN_ATLAS_CODES = Object.freeze(["50000"]);
export const VEGETATION_MASKED_SCL_CODES = Object.freeze([0, 1, 3, 7, 8, 9, 10, 11]);
export const VEGETATION_PALETTE = Object.freeze({
  likelyVegetated: "#238B45",
  belowThreshold: "#D9DEDA",
});

export function calculateNdvi(red, nearInfrared) {
  if (!Number.isFinite(red) || !Number.isFinite(nearInfrared)) return null;
  const denominator = nearInfrared + red;
  if (Math.abs(denominator) <= Number.EPSILON) return null;
  const value = (nearInfrared - red) / denominator;
  return Number.isFinite(value) && value >= NDVI_MIN && value <= NDVI_MAX ? value : null;
}

export function isValidScenePixel(dataMask, sceneClass) {
  return Number(dataMask) === 1 && !VEGETATION_MASKED_SCL_CODES.includes(Number(sceneClass));
}

function assertValues(values, name) {
  if (!values?.length) throw new Error(`${name} bevat geen geldige NDVI-pixels.`);
  for (const value of values) {
    if (!Number.isFinite(value) || value < NDVI_MIN || value > NDVI_MAX) {
      throw new Error(`${name} bevat een ongeldige NDVI-waarde: ${value}.`);
    }
  }
}

function createHistogram(values, binSize) {
  const binCount = Math.round((NDVI_MAX - NDVI_MIN) / binSize) + 1;
  const histogram = new Uint32Array(binCount);
  for (const value of values) {
    const index = Math.max(0, Math.min(binCount - 1, Math.round((value - NDVI_MIN) / binSize)));
    histogram[index] += 1;
  }
  return histogram;
}

function quantileFromHistogram(histogram, count, probability, binSize) {
  const target = Math.max(1, Math.ceil(count * probability));
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative >= target) return Number((NDVI_MIN + index * binSize).toFixed(3));
  }
  return NDVI_MAX;
}

function distributionSummary(histogram, count, binSize) {
  return {
    count,
    p05: quantileFromHistogram(histogram, count, 0.05, binSize),
    p25: quantileFromHistogram(histogram, count, 0.25, binSize),
    median: quantileFromHistogram(histogram, count, 0.5, binSize),
    p75: quantileFromHistogram(histogram, count, 0.75, binSize),
    p95: quantileFromHistogram(histogram, count, 0.95, binSize),
  };
}

function aucFromHistograms(positive, negative, positiveCount, negativeCount) {
  let lowerNegativeCount = 0;
  let favourablePairs = 0;
  for (let index = 0; index < positive.length; index += 1) {
    const positiveAtIndex = positive[index];
    const negativeAtIndex = negative[index];
    favourablePairs += positiveAtIndex * (lowerNegativeCount + negativeAtIndex * 0.5);
    lowerNegativeCount += negativeAtIndex;
  }
  return favourablePairs / (positiveCount * negativeCount);
}

export function calibrateNdviThreshold(positiveValues, negativeValues, { binSize = DEFAULT_BIN_SIZE } = {}) {
  assertValues(positiveValues, "De positieve kalibratieverdeling");
  assertValues(negativeValues, "De negatieve kalibratieverdeling");
  if (!(binSize > 0) || Math.abs((NDVI_MAX - NDVI_MIN) / binSize % 1) > 1e-9) {
    throw new Error("De NDVI-binbreedte moet het bereik -1 tot 1 exact verdelen.");
  }

  const positive = createHistogram(positiveValues, binSize);
  const negative = createHistogram(negativeValues, binSize);
  const positiveCount = positiveValues.length;
  const negativeCount = negativeValues.length;
  let positivesBelow = 0;
  let negativesBelow = 0;
  let bestJ = -Infinity;
  const bestIndices = [];

  for (let thresholdIndex = 0; thresholdIndex < positive.length; thresholdIndex += 1) {
    const sensitivity = (positiveCount - positivesBelow) / positiveCount;
    const specificity = negativesBelow / negativeCount;
    const youdenJ = sensitivity + specificity - 1;
    if (youdenJ > bestJ + 1e-12) {
      bestJ = youdenJ;
      bestIndices.length = 0;
      bestIndices.push(thresholdIndex);
    } else if (Math.abs(youdenJ - bestJ) <= 1e-12) {
      bestIndices.push(thresholdIndex);
    }
    positivesBelow += positive[thresholdIndex];
    negativesBelow += negative[thresholdIndex];
  }

  const thresholdIndex = bestIndices[Math.floor((bestIndices.length - 1) / 2)];
  let positiveBelowThreshold = 0;
  let negativeBelowThreshold = 0;
  for (let index = 0; index < thresholdIndex; index += 1) {
    positiveBelowThreshold += positive[index];
    negativeBelowThreshold += negative[index];
  }
  const sensitivity = (positiveCount - positiveBelowThreshold) / positiveCount;
  const specificity = negativeBelowThreshold / negativeCount;
  const threshold = Number((NDVI_MIN + thresholdIndex * binSize).toFixed(3));
  const auc = aucFromHistograms(positive, negative, positiveCount, negativeCount);

  return {
    method: "youden-j",
    binSize,
    threshold,
    youdenJ: Number(bestJ.toFixed(6)),
    sensitivity: Number(sensitivity.toFixed(6)),
    specificity: Number(specificity.toFixed(6)),
    balancedAccuracy: Number(((sensitivity + specificity) / 2).toFixed(6)),
    falsePositiveRate: Number((1 - specificity).toFixed(6)),
    auc: Number(auc.toFixed(6)),
    overlapWarning: auc < 0.7,
    positive: distributionSummary(positive, positiveCount, binSize),
    negative: distributionSummary(negative, negativeCount, binSize),
  };
}

export function classifyVegetationPixel(ndvi, valid, classifications, threshold) {
  if (!valid || !Number.isFinite(ndvi)) return "no-data";
  if (VEGETATION_EXCLUDED_LAND_COVER_CODES.includes(Number(classifications?.landCoverCode))
    || VEGETATION_EXCLUDED_URBAN_ATLAS_CODES.includes(String(classifications?.urbanAtlasCode))) return "excluded";
  return ndvi >= threshold ? "likely-vegetated" : "below-threshold";
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInMultiPolygon(point, multiPolygon) {
  return multiPolygon.some((polygon) => pointInRing(point, polygon[0])
    && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

function polygonScanlineIntersections(rings, scanY) {
  const intersections = [];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 1) {
      const [x1, y1] = ring[index];
      const [x2, y2] = ring[(index + 1) % ring.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        intersections.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1));
      }
    }
  }
  return intersections.sort((left, right) => left - right);
}

function projectedCoordinateToSubpixel([x, y], grid, scale) {
  return [
    (x - grid.minX) / grid.resolution * scale,
    (grid.maxY - y) / grid.resolution * scale,
  ];
}

/** Rasterize non-overlapping projected polygons onto a subpixel grid. */
export function rasterizeProjectedFeatures(features, grid, valueForFeature, { scale = 3, ArrayType = Uint16Array } = {}) {
  const width = grid.width * scale;
  const height = grid.height * scale;
  const output = new ArrayType(width * height);
  for (const feature of features) {
    const value = valueForFeature(feature);
    if (!value) continue;
    const polygons = feature.geometry.type === "MultiPolygon"
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map((coordinate) => projectedCoordinateToSubpixel(coordinate, grid, scale)));
      const yValues = rings.flatMap((ring) => ring.map((coordinate) => coordinate[1]));
      const firstRow = Math.max(0, Math.ceil(Math.min(...yValues) - 0.5));
      const lastRow = Math.min(height - 1, Math.floor(Math.max(...yValues) - 0.5));
      for (let row = firstRow; row <= lastRow; row += 1) {
        const intersections = polygonScanlineIntersections(rings, row + 0.5);
        for (let pair = 0; pair + 1 < intersections.length; pair += 2) {
          const firstColumn = Math.max(0, Math.ceil(intersections[pair] - 0.5));
          const lastColumn = Math.min(width - 1, Math.floor(intersections[pair + 1] - 0.5));
          const rowOffset = row * width;
          for (let column = firstColumn; column <= lastColumn; column += 1) output[rowOffset + column] = value;
        }
      }
    }
  }
  return { data: output, width, height, scale };
}

export function subpixelVotes(raster, column, row) {
  const counts = new Map();
  const startX = column * raster.scale;
  const startY = row * raster.scale;
  for (let yOffset = 0; yOffset < raster.scale; yOffset += 1) {
    const offset = (startY + yOffset) * raster.width + startX;
    for (let xOffset = 0; xOffset < raster.scale; xOffset += 1) {
      const value = raster.data[offset + xOffset];
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
}

export function roundMetric(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}
