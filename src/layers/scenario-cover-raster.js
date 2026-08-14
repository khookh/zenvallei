const PROTOCOL = "greenwave-scenario-cover";
const TILE_SIZE = 256;
const GREEN_RGB = new Map([
  ["31,127,0", 1], ["191,255,0", 2], ["255,255,0", 3], ["173,173,173", 4],
]);
const SEALED_RGB = "232,41,47";
const GROUND = Object.freeze({ locked: 0, low: 1, sealed: 2, agriculture: 3, water: 4, bare: 5 });
const GROUND_NAME = Object.freeze(["locked", "low", "sealed", "agriculture", "water", "bare"]);
const COLOURS = Object.freeze({
  locked: [173, 173, 173, 190], low: [191, 255, 0, 238], sealed: [232, 41, 47, 238],
  agriculture: [255, 230, 0, 238], water: [70, 145, 208, 238], bare: [176, 153, 118, 238],
  high: [31, 127, 0, 245], hatch: [58, 74, 78, 125],
});

const configurations = new Map();
const archives = new Map();
const decodedTiles = new Map();
const composedTiles = new Map();
let protocolPromise;
let sequence = 0;

function discardConfiguration(token) {
  if (!token) return;
  configurations.delete(token);
  for (const key of composedTiles.keys()) {
    if (key.startsWith(`${token}|`)) composedTiles.delete(key);
  }
}

const archiveFor = async (url) => {
  if (!archives.has(url)) {
    const { PMTiles } = await import("pmtiles");
    archives.set(url, new PMTiles(url));
  }
  return archives.get(url);
};

const tileCanvas = () => {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  return canvas;
};

const canvasPng = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => {
  if (!blob) reject(new Error("Could not encode the scenario cover tile."));
  else blob.arrayBuffer().then(resolve, reject);
}, "image/png"));

async function decodeTile(url, z, x, y, signal) {
  const key = `${url}|${z}|${x}|${y}`;
  if (!decodedTiles.has(key)) {
    decodedTiles.set(key, (async () => {
      const response = await (await archiveFor(url)).getZxy(z, x, y, signal);
      if (!response) return null;
      const bitmap = await createImageBitmap(new Blob([response.data], { type: "image/png" }));
      const canvas = tileCanvas();
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
      bitmap.close();
      return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    })().catch((error) => { decodedTiles.delete(key); throw error; }));
  }
  return decodedTiles.get(key);
}

function tilePoint([longitude, latitude], z, x, y) {
  const world = 2 ** z;
  const normalizedX = (longitude + 180) / 360;
  const bounded = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const normalizedY = (1 - Math.asinh(Math.tan(bounded * Math.PI / 180)) / Math.PI) / 2;
  return [(normalizedX * world - x) * TILE_SIZE, (normalizedY * world - y) * TILE_SIZE];
}

function longitudeForTile(column, zoom) { return column / (2 ** zoom) * 360 - 180; }
function latitudeForTile(row, zoom) {
  const value = Math.PI * (1 - 2 * row / (2 ** zoom));
  return Math.atan(Math.sinh(value)) * 180 / Math.PI;
}

function tileBounds(z, x, y) {
  return [longitudeForTile(x, z), latitudeForTile(y + 1, z),
    longitudeForTile(x + 1, z), latitudeForTile(y, z)];
}

function operationBounds(operation) {
  const pairs = [];
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) pairs.push(value);
    else value.forEach(collect);
  };
  collect(operation.geometry?.coordinates);
  const longitudes = pairs.map((pair) => pair[0]);
  const latitudes = pairs.map((pair) => pair[1]);
  return longitudes.length
    ? [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)]
    : [Infinity, Infinity, -Infinity, -Infinity];
}

function boundsIntersect(left, right) {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

function tracePolygon(context, rings, z, x, y) {
  context.beginPath();
  rings.forEach((ring) => ring.forEach((coordinate, index) => {
    const [column, row] = tilePoint(coordinate, z, x, y);
    if (!index) context.moveTo(column, row); else context.lineTo(column, row);
  }));
  context.closePath();
}

function operationMask(operation, z, x, y) {
  const canvas = tileCanvas();
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const geometry = operation.geometry;
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  context.fillStyle = "#fff";
  polygons.forEach((rings) => { tracePolygon(context, rings, z, x, y); context.fill("evenodd"); });
  return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

export function sourceState(green, soil, urban, offset, waterIndex, analysisWater = null) {
  // Urban Atlas defines the prepared scenario footprint. Inside it, missing or
  // unknown official classifications remain visible as locked cells rather
  // than becoming transparent holes that could be mistaken for edits.
  if (!urban?.data[offset + 3]) return null;
  if (!green?.data[offset + 3] || !soil?.data[offset + 3]) {
    return { ground: GROUND.locked, canopy: false, editable: false };
  }
  const greenCode = GREEN_RGB.get(`${green.data[offset]},${green.data[offset + 1]},${green.data[offset + 2]}`);
  if (!greenCode) return { ground: GROUND.locked, canopy: false, editable: false };
  const water = Boolean(urban?.data[offset + 3] && urban.data[offset] === waterIndex);
  if (water) return { ground: GROUND.water, canopy: false, editable: false };
  if (greenCode === 3) return { ground: GROUND.agriculture, canopy: false, editable: false };
  const sealed = `${soil.data[offset]},${soil.data[offset + 1]},${soil.data[offset + 2]}` === SEALED_RGB;
  const hiddenWaterLock = Boolean(analysisWater?.data[offset + 3]);
  return {
    ground: sealed ? GROUND.sealed : greenCode === 4 ? GROUND.bare : GROUND.low,
    canopy: greenCode === 1,
    // Flanders Land Use water participates in model calculations and edit
    // validity, but is intentionally not painted over the higher-resolution
    // visible source classes.
    editable: !hiddenWaterLock,
  };
}

export function applyOperation(state, baseline, operation) {
  if (operation.action === "restore") return { ...baseline };
  if (!state.editable) return state;
  if (operation.action === "convert-to-low") {
    if (state.ground === GROUND.sealed || state.ground === GROUND.bare) state.ground = GROUND.low;
  } else if (operation.action === "remove-high") {
    state.canopy = false;
  } else if (operation.target === "sealed") {
    if (state.ground === GROUND.low || state.ground === GROUND.bare) state.ground = GROUND.sealed;
  } else if (operation.target === "high") state.canopy = true;
  return state;
}

async function composeTile(configuration, z, x, y, signal) {
  const [green, soil, urban, analysisWater] = await Promise.all([
    decodeTile(configuration.greenUrl, z, x, y, signal),
    decodeTile(configuration.soilUrl, z, x, y, signal),
    decodeTile(configuration.urbanUrl, z, x, y, signal),
    decodeTile(configuration.analysisWaterUrl, z, x, y, signal),
  ]);
  const canvas = tileCanvas();
  if (!green || !soil) return canvasPng(canvas);
  const context = canvas.getContext("2d");
  const output = context.createImageData(TILE_SIZE, TILE_SIZE);
  const currentTileBounds = tileBounds(z, x, y);
  const operations = configuration.operations.filter((operation) => (
    boundsIntersect(operation.bounds ?? operationBounds(operation), currentTileBounds)
  )).map((operation) => ({
    operation, mask: operationMask(operation, z, x, y),
  }));
  const visible = configuration.visible;
  for (let row = 0; row < TILE_SIZE; row += 1) {
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const offset = (row * TILE_SIZE + column) * 4;
      const baseline = sourceState(
        green, soil, urban, offset, configuration.waterIndex, analysisWater,
      );
      if (!baseline) continue;
      let state = { ...baseline };
      let touched = false;
      operations.forEach(({ operation, mask }) => {
        if (mask[offset + 3] < 128) return;
        touched = true;
        state = applyOperation(state, baseline, operation);
      });
      const groundName = GROUND_NAME[state.ground];
      if (visible.has(groundName)) output.data.set(COLOURS[groundName], offset);
      // Anchor patterns in global tile pixels. A tile-local modulus produced a
      // visible phase jump because 256 is not divisible by five.
      const globalRow = y * TILE_SIZE + row;
      const globalColumn = x * TILE_SIZE + column;
      if (state.canopy && visible.has("high") && (globalRow % 5) < 3 && (globalColumn % 5) < 3) {
        output.data.set(COLOURS.high, offset);
      }
      if (touched && !state.editable && visible.has("locked") && ((globalRow + globalColumn) % 8) < 2) {
        output.data.set(COLOURS.hatch, offset);
      }
    }
  }
  context.putImageData(output, 0, 0);
  return canvasPng(canvas);
}

async function installProtocol() {
  if (!protocolPromise) {
    protocolPromise = import("maplibre-gl").then((maplibregl) => maplibregl.addProtocol(
      PROTOCOL,
      async (request, abortController) => {
        const match = request.url.match(/^greenwave-scenario-cover:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/);
        if (!match) throw new Error("Invalid scenario-cover tile URL.");
        const [, token, z, x, y] = match;
        const configuration = configurations.get(token);
        if (!configuration) return { data: await canvasPng(tileCanvas()) };
        const key = `${token}|${z}|${x}|${y}`;
        if (!composedTiles.has(key)) {
          composedTiles.set(key, composeTile(
            configuration, Number(z), Number(x), Number(y), abortController.signal,
          ).catch((error) => { composedTiles.delete(key); throw error; }));
        }
        return { data: await composedTiles.get(key) };
      },
    ));
  }
  await protocolPromise;
}

function waitForSource(map, sourceId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      map.off("sourcedata", onData);
      map.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onData = (event) => {
      if (event.sourceId === sourceId && (event.isSourceLoaded || map.isSourceLoaded(sourceId))) finish();
    };
    const onError = (event) => { if (event.sourceId === sourceId) finish(event.error ?? new Error("Scenario cover failed.")); };
    map.on("sourcedata", onData);
    map.on("error", onError);
    const timeout = setTimeout(() => finish(new Error("Scenario cover timed out.")), 45_000);
    queueMicrotask(() => { if (map.getSource(sourceId) && map.isSourceLoaded(sourceId)) finish(); });
  });
}

/** A focused, double-buffered compositor for the one scenario cover map. */
export function createScenarioCoverRaster({ id, beforeLayerId }) {
  let map;
  let activeSlot = -1;
  let activeToken = "";
  let generation = 0;
  let desiredVisible = false;
  let desiredOpacity = .78;
  let replacementQueue = Promise.resolve(false);

  const removeSlot = (slot) => {
    if (!map || slot < 0) return;
    const layerId = `${id}-${slot}`;
    const sourceId = `${layerId}-source`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  };

  const replace = async (nextMap, configuration, requestGeneration) => {
      map = nextMap;
      await installProtocol();
      if (requestGeneration !== generation) return false;
      const slot = activeSlot === 0 ? 1 : 0;
      removeSlot(slot);
      const token = `s${++sequence}`;
      configurations.set(token, {
        ...configuration,
        operations: (configuration.operations ?? []).map((operation) => ({
          ...operation, bounds: operationBounds(operation),
        })),
        visible: new Set(configuration.visibleCategories),
      });
      const sourceId = `${id}-${slot}-source`;
      const layerId = `${id}-${slot}`;
      map.addSource(sourceId, {
        type: "raster", tileSize: TILE_SIZE, minzoom: 10, maxzoom: 17,
        tiles: [`${PROTOCOL}://${token}/{z}/{x}/{y}.png`],
      });
      map.addLayer({
        id: layerId, type: "raster", source: sourceId,
        layout: { visibility: "none" },
        paint: { "raster-opacity": desiredOpacity, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, beforeLayerId);
      try {
        await waitForSource(map, sourceId);
        if (requestGeneration !== generation) {
          discardConfiguration(token);
          removeSlot(slot);
          return false;
        }
        map.setLayoutProperty(layerId, "visibility", desiredVisible ? "visible" : "none");
        const oldSlot = activeSlot;
        activeSlot = slot;
        discardConfiguration(activeToken);
        activeToken = token;
        removeSlot(oldSlot);
        map.triggerRepaint();
        return true;
      } catch (error) {
        discardConfiguration(token);
        removeSlot(slot);
        throw error;
      }
  };

  return {
    show(nextMap, configuration) {
      const requestGeneration = ++generation;
      // Serialisation prevents two rapid visibility/edit revisions from
      // reusing the same buffer slot. Superseded queued revisions are skipped.
      replacementQueue = replacementQueue.catch(() => false).then(() => (
        requestGeneration === generation
          ? replace(nextMap, configuration, requestGeneration) : false
      ));
      return replacementQueue;
    },
    setVisible(visible) {
      desiredVisible = Boolean(visible);
      if (activeSlot >= 0 && map?.getLayer(`${id}-${activeSlot}`)) {
        map.setLayoutProperty(`${id}-${activeSlot}`, "visibility", desiredVisible ? "visible" : "none");
      }
    },
    setOpacity(opacity) {
      desiredOpacity = Math.max(0, Math.min(1, Number(opacity)));
      for (const slot of [0, 1]) {
        const layerId = `${id}-${slot}`;
        if (map?.getLayer(layerId)) map.setPaintProperty(layerId, "raster-opacity", desiredOpacity);
      }
    },
    remove() {
      generation += 1;
      removeSlot(0); removeSlot(1);
      discardConfiguration(activeToken);
      activeToken = ""; activeSlot = -1;
    },
  };
}

export { GROUND, boundsIntersect, operationBounds };
