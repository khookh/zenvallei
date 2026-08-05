const EARTH_RADIUS_METERS = 6_378_137;

export function detectRasterContainer(header) {
  const bytes = new Uint8Array(header.buffer, header.byteOffset, Math.min(header.byteLength, 4));
  if (bytes.length < 4) return "unknown";
  const littleEndianTiff = bytes[0] === 0x49 && bytes[1] === 0x49
    && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0x00;
  const bigEndianTiff = bytes[0] === 0x4d && bytes[1] === 0x4d
    && bytes[2] === 0x00 && (bytes[3] === 0x2a || bytes[3] === 0x2b);
  if (littleEndianTiff || bigEndianTiff) return "tiff";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  return "unknown";
}

export const LCM_CLASSES = Object.freeze([
  { code: 10, key: "treeCover", sourceLabel: "Tree cover", color: "#006400", vegetation: true },
  { code: 20, key: "shrubland", sourceLabel: "Shrubland", color: "#ffbb22", vegetation: false },
  { code: 30, key: "grassland", sourceLabel: "Grassland", color: "#ffff4c", vegetation: true },
  { code: 40, key: "cropland", sourceLabel: "Cropland", color: "#f096ff", vegetation: false },
  { code: 50, key: "herbaceousWetland", sourceLabel: "Herbaceous wetland", color: "#0096a0", vegetation: false },
  { code: 60, key: "mangroves", sourceLabel: "Mangroves", color: "#00cf75", vegetation: false },
  { code: 70, key: "mossLichen", sourceLabel: "Moss and lichen", color: "#fae6a0", vegetation: false },
  { code: 80, key: "bareSparse", sourceLabel: "Bare / sparse vegetation", color: "#b4b4b4", vegetation: false },
  { code: 90, key: "builtUp", sourceLabel: "Built-up", color: "#fa0000", vegetation: false },
  { code: 100, key: "water", sourceLabel: "Permanent water bodies", color: "#0064c8", vegetation: false },
  { code: 110, key: "snowIce", sourceLabel: "Snow and ice", color: "#f0f0f0", vegetation: false },
  { code: 254, key: "unclassifiable", sourceLabel: "Unclassifiable", color: "#0a0a0a", vegetation: false },
]);

export const VEGETATION_CODES = Object.freeze(LCM_CLASSES.filter((entry) => entry.vegetation).map((entry) => entry.code));
export const BUILT_UP_CODES = Object.freeze([90]);
export const CHANGE_CLASSES = Object.freeze([
  { key: "gained", color: "#009E73" },
  { key: "lost", color: "#D55E00" },
]);

const CLASS_BY_CODE = new Map(LCM_CLASSES.map((entry) => [entry.code, entry]));

export function lonLatToMercator([longitude, latitude]) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [
    EARTH_RADIUS_METERS * longitude * Math.PI / 180,
    EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + clampedLatitude * Math.PI / 360)),
  ];
}

export function mercatorToLonLat([x, y]) {
  return [
    x / EARTH_RADIUS_METERS * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2) * 180 / Math.PI,
  ];
}

export function createGrid(bounds, groundResolutionMeters = 10) {
  const [southwest, northeast] = bounds;
  const [minX, minY] = lonLatToMercator(southwest);
  const [maxX, maxY] = lonLatToMercator(northeast);
  const middleLatitude = (southwest[1] + northeast[1]) / 2;
  const projectedResolution = groundResolutionMeters / Math.cos(middleLatitude * Math.PI / 180);
  const width = Math.ceil((maxX - minX) / projectedResolution);
  const height = Math.ceil((maxY - minY) / projectedResolution);
  return {
    width,
    height,
    projectedBounds: { minX, minY, maxX, maxY },
    coordinates: [
      [southwest[0], northeast[1]],
      [northeast[0], northeast[1]],
      [northeast[0], southwest[1]],
      [southwest[0], southwest[1]],
    ],
  };
}

function coordinateToPixel(coordinate, grid) {
  const [x, y] = lonLatToMercator(coordinate);
  const { minX, minY, maxX, maxY } = grid.projectedBounds;
  return [
    (x - minX) / (maxX - minX) * grid.width,
    (maxY - y) / (maxY - minY) * grid.height,
  ];
}

function polygonScanlineIntersections(rings, scanY) {
  const intersections = [];
  rings.forEach((ring) => {
    for (let index = 0; index < ring.length; index += 1) {
      const [x1, y1] = ring[index];
      const [x2, y2] = ring[(index + 1) % ring.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        intersections.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1));
      }
    }
  });
  return intersections.sort((left, right) => left - right);
}

export function rasterizeSectorMask(featureCollection, grid) {
  const mask = new Uint16Array(grid.width * grid.height);
  const sectorIds = [null];
  featureCollection.features.forEach((feature, featureIndex) => {
    const sectorIndex = featureIndex + 1;
    sectorIds[sectorIndex] = feature.properties.sectorId;
    const polygons = feature.geometry.type === "MultiPolygon"
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];
    polygons.forEach((polygon) => {
      const rings = polygon.map((ring) => ring.map((coordinate) => coordinateToPixel(coordinate, grid)));
      const allY = rings.flatMap((ring) => ring.map((coordinate) => coordinate[1]));
      const firstRow = Math.max(0, Math.ceil(Math.min(...allY) - 0.5));
      const lastRow = Math.min(grid.height - 1, Math.floor(Math.max(...allY) - 0.5));
      for (let row = firstRow; row <= lastRow; row += 1) {
        const intersections = polygonScanlineIntersections(rings, row + 0.5);
        for (let pair = 0; pair + 1 < intersections.length; pair += 2) {
          const firstColumn = Math.max(0, Math.ceil(intersections[pair] - 0.5));
          const lastColumn = Math.min(grid.width - 1, Math.floor(intersections[pair + 1] - 0.5));
          const offset = row * grid.width;
          for (let column = firstColumn; column <= lastColumn; column += 1) {
            mask[offset + column] = sectorIndex;
          }
        }
      }
    });
  });
  return { mask, sectorIds };
}

export function resampleClasses(source, grid) {
  const result = new Uint8Array(grid.width * grid.height);
  const { minX, minY, maxX, maxY } = grid.projectedBounds;
  for (let row = 0; row < grid.height; row += 1) {
    const projectedY = maxY - (row + 0.5) / grid.height * (maxY - minY);
    const latitude = mercatorToLonLat([0, projectedY])[1];
    const sourceRow = Math.floor((latitude - source.origin[1]) / source.resolution[1]) - source.window[1];
    if (sourceRow < 0 || sourceRow >= source.height) continue;
    for (let column = 0; column < grid.width; column += 1) {
      const projectedX = minX + (column + 0.5) / grid.width * (maxX - minX);
      const longitude = mercatorToLonLat([projectedX, 0])[0];
      const sourceColumn = Math.floor((longitude - source.origin[0]) / source.resolution[0]) - source.window[0];
      if (sourceColumn < 0 || sourceColumn >= source.width) continue;
      result[row * grid.width + column] = source.data[sourceRow * source.width + sourceColumn];
    }
  }
  return result;
}

function rowPixelAreaHectares(row, grid) {
  const { minX, minY, maxX, maxY } = grid.projectedBounds;
  const projectedY = maxY - (row + 0.5) / grid.height * (maxY - minY);
  const latitude = mercatorToLonLat([0, projectedY])[1] * Math.PI / 180;
  const projectedArea = (maxX - minX) / grid.width * (maxY - minY) / grid.height;
  return projectedArea * Math.cos(latitude) ** 2 / 10_000;
}

function roundArea(value) {
  return Math.round(value * 100) / 100;
}

export function buildLandCoverOutput(classes, sectorMask, grid, featureCollection) {
  if (classes.length !== sectorMask.mask.length) throw new Error("Land-cover grid and sector mask dimensions do not match.");
  const rgba = Buffer.alloc(classes.length * 4);
  const accumulators = new Map(featureCollection.features.map((feature) => [feature.properties.sectorId, {
    totalAreaHa: 0,
    classifiedAreaHa: 0,
    unclassifiableAreaHa: 0,
    vegetationAreaHa: 0,
    builtUpAreaHa: 0,
    classAreas: new Map(),
  }]));
  const presentCodes = new Set();

  for (let row = 0; row < grid.height; row += 1) {
    const pixelAreaHa = rowPixelAreaHectares(row, grid);
    for (let column = 0; column < grid.width; column += 1) {
      const pixelIndex = row * grid.width + column;
      const sectorIndex = sectorMask.mask[pixelIndex];
      if (!sectorIndex) continue;
      const sectorId = sectorMask.sectorIds[sectorIndex];
      const accumulator = accumulators.get(sectorId);
      const code = classes[pixelIndex];
      accumulator.totalAreaHa += pixelAreaHa;
      if (code === 0) continue;
      const definition = CLASS_BY_CODE.get(code);
      if (!definition) throw new Error(`Unexpected LCM-10 class ${code} inside sector ${sectorId}.`);
      presentCodes.add(code);
      const color = definition.color.slice(1);
      const rgbaOffset = pixelIndex * 4;
      rgba[rgbaOffset] = Number.parseInt(color.slice(0, 2), 16);
      rgba[rgbaOffset + 1] = Number.parseInt(color.slice(2, 4), 16);
      rgba[rgbaOffset + 2] = Number.parseInt(color.slice(4, 6), 16);
      rgba[rgbaOffset + 3] = 255;
      if (code === 254) {
        accumulator.unclassifiableAreaHa += pixelAreaHa;
        continue;
      }
      accumulator.classifiedAreaHa += pixelAreaHa;
      accumulator.classAreas.set(code, (accumulator.classAreas.get(code) ?? 0) + pixelAreaHa);
      if (definition.vegetation) accumulator.vegetationAreaHa += pixelAreaHa;
      if (BUILT_UP_CODES.includes(code)) accumulator.builtUpAreaHa += pixelAreaHa;
    }
  }

  const sectorStats = Object.fromEntries(featureCollection.features.map((feature) => {
    const accumulator = accumulators.get(feature.properties.sectorId);
    const classStats = [...accumulator.classAreas.entries()]
      .map(([code, areaHa]) => ({
        code,
        areaHa: roundArea(areaHa),
        percentage: accumulator.classifiedAreaHa ? Math.round(areaHa / accumulator.classifiedAreaHa * 10_000) / 100 : 0,
      }))
      .sort((left, right) => right.areaHa - left.areaHa);
    return [feature.properties.sectorId, {
      totalAreaHa: roundArea(accumulator.totalAreaHa),
      classifiedAreaHa: roundArea(accumulator.classifiedAreaHa),
      unclassifiableAreaHa: roundArea(accumulator.unclassifiableAreaHa),
      vegetationAreaHa: roundArea(accumulator.vegetationAreaHa),
      vegetationPercentage: accumulator.classifiedAreaHa
        ? Math.round(accumulator.vegetationAreaHa / accumulator.classifiedAreaHa * 10_000) / 100
        : null,
      builtUpAreaHa: roundArea(accumulator.builtUpAreaHa),
      builtUpPercentage: accumulator.classifiedAreaHa
        ? Math.round(accumulator.builtUpAreaHa / accumulator.classifiedAreaHa * 10_000) / 100
        : null,
      dominantClassCode: classStats[0]?.code ?? null,
      classes: classStats,
    }];
  }));

  return { rgba, sectorStats, presentCodes: [...presentCodes].sort((left, right) => left - right) };
}

export function classifyVegetationChange(baseClasses, comparisonClasses, sectorMask) {
  if (baseClasses.length !== comparisonClasses.length || baseClasses.length !== sectorMask.length) {
    throw new Error("Change grids must have identical dimensions.");
  }
  const vegetation = new Set(VEGETATION_CODES);
  const states = new Uint8Array(baseClasses.length);
  const rgba = Buffer.alloc(baseClasses.length * 4);
  for (let index = 0; index < baseClasses.length; index += 1) {
    if (!sectorMask[index]) continue;
    const before = baseClasses[index];
    const after = comparisonClasses[index];
    if (!CLASS_BY_CODE.has(before) || !CLASS_BY_CODE.has(after) || before === 254 || after === 254) continue;
    const gained = !vegetation.has(before) && vegetation.has(after);
    const lost = vegetation.has(before) && !vegetation.has(after);
    if (!gained && !lost) continue;
    const state = gained ? 1 : 2;
    const color = CHANGE_CLASSES[state - 1].color.slice(1);
    states[index] = state;
    rgba[index * 4] = Number.parseInt(color.slice(0, 2), 16);
    rgba[index * 4 + 1] = Number.parseInt(color.slice(2, 4), 16);
    rgba[index * 4 + 2] = Number.parseInt(color.slice(4, 6), 16);
    rgba[index * 4 + 3] = 255;
  }
  return { states, rgba };
}

export function summarizeVegetationChange(baseClasses, comparisonClasses, sectorMask, grid, featureCollection) {
  const vegetation = new Set(VEGETATION_CODES);
  const accumulators = new Map(featureCollection.features.map((feature) => [feature.properties.sectorId, {
    comparedAreaHa: 0,
    gainedAreaHa: 0,
    lostAreaHa: 0,
    unchangedVegetationAreaHa: 0,
  }]));
  for (let row = 0; row < grid.height; row += 1) {
    const pixelAreaHa = rowPixelAreaHectares(row, grid);
    for (let column = 0; column < grid.width; column += 1) {
      const index = row * grid.width + column;
      const sectorIndex = sectorMask.mask[index];
      if (!sectorIndex) continue;
      const before = baseClasses[index];
      const after = comparisonClasses[index];
      if (!CLASS_BY_CODE.has(before) || !CLASS_BY_CODE.has(after) || before === 254 || after === 254) continue;
      const accumulator = accumulators.get(sectorMask.sectorIds[sectorIndex]);
      accumulator.comparedAreaHa += pixelAreaHa;
      if (!vegetation.has(before) && vegetation.has(after)) accumulator.gainedAreaHa += pixelAreaHa;
      if (vegetation.has(before) && !vegetation.has(after)) accumulator.lostAreaHa += pixelAreaHa;
      if (vegetation.has(before) && vegetation.has(after)) accumulator.unchangedVegetationAreaHa += pixelAreaHa;
    }
  }
  return Object.fromEntries([...accumulators.entries()].map(([sectorId, values]) => [sectorId, {
    comparedAreaHa: roundArea(values.comparedAreaHa),
    gainedAreaHa: roundArea(values.gainedAreaHa),
    gainedPercentage: values.comparedAreaHa ? Math.round(values.gainedAreaHa / values.comparedAreaHa * 10_000) / 100 : null,
    lostAreaHa: roundArea(values.lostAreaHa),
    lostPercentage: values.comparedAreaHa ? Math.round(values.lostAreaHa / values.comparedAreaHa * 10_000) / 100 : null,
    unchangedVegetationAreaHa: roundArea(values.unchangedVegetationAreaHa),
    netChangeAreaHa: roundArea(values.gainedAreaHa - values.lostAreaHa),
  }]));
}
