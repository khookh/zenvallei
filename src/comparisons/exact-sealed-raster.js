import { greenDensityColor } from "./sealed-urban-shared.js";
import { thermalColor } from "./thermal-palette.js";

const PROTOCOL = "greenwave-compose";
const TILE_SIZE = 256;
const SEALED_RGB = [0xe8, 0x29, 0x2f];
const configurations = new Map();
const archives = new Map();
const decodedTiles = new Map();
const composedTiles = new Map();
let protocolPromise;
let tokenSequence = 0;

const archiveFor = async (url) => {
  if (!archives.has(url)) {
    const { PMTiles } = await import("pmtiles");
    archives.set(url, new PMTiles(url));
  }
  return archives.get(url);
};

const createTileCanvas = () => {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  return canvas;
};

const canvasPng = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => {
  if (!blob) reject(new Error("Could not encode exact raster tile."));
  else blob.arrayBuffer().then(resolve, reject);
}, "image/png"));

async function transparentTile() {
  return canvasPng(createTileCanvas());
}

async function decodeTile(url, z, x, y, signal) {
  const key = `${url}|${z}|${x}|${y}`;
  if (!decodedTiles.has(key)) {
    decodedTiles.set(key, (async () => {
      const response = await (await archiveFor(url)).getZxy(z, x, y, signal);
      if (!response) return null;
      const bitmap = await createImageBitmap(new Blob([response.data], { type: "image/png" }));
      const canvas = createTileCanvas();
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
      bitmap.close();
      return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    })().catch((error) => {
      decodedTiles.delete(key);
      throw error;
    }));
  }
  return decodedTiles.get(key);
}

export function isOfficialSealedPixel(data, offset) {
  return data[offset] === SEALED_RGB[0] && data[offset + 1] === SEALED_RGB[1]
    && data[offset + 2] === SEALED_RGB[2] && data[offset + 3] > 0;
}

function rasterOffset(configuration, z, x, y, column, row) {
  const world = 2 ** z;
  const normalizedX = (x + (column + 0.5) / TILE_SIZE) / world;
  const normalizedY = (y + (row + 0.5) / TILE_SIZE) / world;
  const longitude = normalizedX * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * normalizedY))) * 180 / Math.PI;
  const [west, south, east, north] = configuration.dataBounds;
  const rasterColumn = Math.floor((longitude - west) / (east - west) * configuration.dataSize[0]);
  const rasterRow = Math.floor((north - latitude) / (north - south) * configuration.dataSize[1]);
  if (rasterColumn < 0 || rasterRow < 0
    || rasterColumn >= configuration.dataSize[0] || rasterRow >= configuration.dataSize[1]) return -1;
  return (rasterRow * configuration.dataSize[0] + rasterColumn) * 4;
}

function selectedDensity(configuration, offset) {
  if (configuration.densityData.data[offset + 3] === 0) return null;
  let value = 0;
  configuration.selectedClasses.forEach((code) => {
    value += (code === 4
      ? configuration.nonGreenData.data[offset]
      : configuration.densityData.data[offset + code - 1]) / 2.55;
  });
  return Math.max(0, Math.min(100, value));
}

async function composeTile(configuration, z, x, y, signal) {
  const [jaarbak, urban] = await Promise.all([
    decodeTile(configuration.jaarbakUrl, z, x, y, signal),
    configuration.urbanMaskUrl ? decodeTile(configuration.urbanMaskUrl, z, x, y, signal) : null,
  ]);
  if (!jaarbak || (configuration.urbanMaskUrl && !urban)) return transparentTile();
  const canvas = createTileCanvas();
  const context = canvas.getContext("2d");
  const output = context.createImageData(TILE_SIZE, TILE_SIZE);
  for (let row = 0; row < TILE_SIZE; row += 1) {
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const tileOffset = (row * TILE_SIZE + column) * 4;
      if (!isOfficialSealedPixel(jaarbak.data, tileOffset) || (urban && urban.data[tileOffset + 3] === 0)) continue;
      if (configuration.mode === "sealed") {
        output.data.set([...SEALED_RGB, 255], tileOffset);
        continue;
      }
      const offset = rasterOffset(configuration, z, x, y, column, row);
      if (offset < 0) continue;
      if (configuration.mode === "density") {
        const density = selectedDensity(configuration, offset);
        if (density == null) continue;
        output.data.set([...greenDensityColor(density), 232], tileOffset);
      } else if (configuration.mode === "temperature") {
        // Display status is deliberately independent from the narrower point
        // set used by comparison charts. This prevents graph eligibility rules
        // from punching artificial 30 m holes into the exact 1 m footprint.
        const status = configuration.temperatureData.data[offset + 3];
        if (status === 255) {
          const code = configuration.temperatureData.data[offset] * 256 + configuration.temperatureData.data[offset + 1];
          const temperature = code / 100 - 100;
          output.data.set([...thermalColor(Math.round(Math.max(0, Math.min(1, (temperature - 15) / 35)) * 255)), 242], tileOffset);
        } else if (status === 254) {
          const light = (row + column) % 8 < 4;
          output.data.set(light ? [194, 201, 203, 235] : [126, 135, 139, 235], tileOffset);
        }
      }
    }
  }
  context.putImageData(output, 0, 0);
  return canvasPng(canvas);
}

async function installProtocol() {
  if (!protocolPromise) {
    protocolPromise = import("maplibre-gl").then((maplibregl) => {
      maplibregl.addProtocol(PROTOCOL, async (request, abortController) => {
        const match = request.url.match(/^greenwave-compose:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/);
        if (!match) throw new Error("Invalid exact-raster tile URL.");
        const [, token, z, x, y] = match;
        const configuration = configurations.get(token);
        if (!configuration) return { data: await transparentTile() };
        const key = `${token}|${z}|${x}|${y}`;
        if (!composedTiles.has(key)) {
          composedTiles.set(key, composeTile(configuration, Number(z), Number(x), Number(y), abortController.signal)
            .catch((error) => { composedTiles.delete(key); throw error; }));
        }
        return { data: await composedTiles.get(key) };
      });
    });
  }
  return protocolPromise;
}

function waitForSource(map, sourceId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      map.off("sourcedata", onData);
      map.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onData = (event) => {
      if (event.sourceId === sourceId && (event.isSourceLoaded || map.isSourceLoaded(sourceId))) finish();
    };
    const onError = (event) => {
      if (event.sourceId === sourceId) finish(event.error ?? new Error("Exact raster failed to load."));
    };
    map.on("sourcedata", onData);
    map.on("error", onError);
    const timeout = window.setTimeout(() => finish(new Error("Exact raster timed out.")), import.meta.env.DEV ? 45_000 : 15_000);
    queueMicrotask(() => { if (map.getSource(sourceId) && map.isSourceLoaded(sourceId)) finish(); });
  });
}

/** Double-buffer a composed raster so a refresh never exposes an empty intermediate map. */
export function createExactSealedRaster({ id, beforeLayerId, opacity = 1 }) {
  let map;
  let activeSlot = -1;
  let generation = 0;
  let activeToken = "";

  const tilePixel = (point, zoom = 17) => {
    const world = 2 ** zoom;
    const normalizedX = (point.lng + 180) / 360;
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
    const normalizedY = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
    const scaledX = normalizedX * world;
    const scaledY = normalizedY * world;
    return {
      z: zoom, x: Math.floor(scaledX), y: Math.floor(scaledY),
      column: Math.min(255, Math.floor((scaledX - Math.floor(scaledX)) * TILE_SIZE)),
      row: Math.min(255, Math.floor((scaledY - Math.floor(scaledY)) * TILE_SIZE)),
    };
  };

  const removeSlot = (slot) => {
    if (!map || slot < 0) return;
    const layerId = `${id}-${slot}`;
    const sourceId = `${id}-${slot}-source`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  };

  return {
    async show(nextMap, configuration) {
      map = nextMap;
      await installProtocol();
      const requestGeneration = ++generation;
      const slot = activeSlot === 0 ? 1 : 0;
      removeSlot(slot);
      const token = `r${++tokenSequence}`;
      configurations.set(token, configuration);
      const sourceId = `${id}-${slot}-source`;
      const layerId = `${id}-${slot}`;
      map.addSource(sourceId, {
        type: "raster", tileSize: TILE_SIZE, minzoom: 10, maxzoom: 17,
        tiles: [`${PROTOCOL}://${token}/{z}/{x}/{y}.png`],
      });
      map.addLayer({
        id: layerId, type: "raster", source: sourceId,
        paint: { "raster-opacity": 0, "raster-resampling": "nearest", "raster-fade-duration": 0 },
      }, beforeLayerId);
      try {
        await waitForSource(map, sourceId);
        if (requestGeneration !== generation) return false;
        map.setPaintProperty(layerId, "raster-opacity", opacity);
        const oldSlot = activeSlot;
        activeSlot = slot;
        configurations.delete(activeToken);
        activeToken = token;
        removeSlot(oldSlot);
        map.triggerRepaint();
        return true;
      } catch (error) {
        configurations.delete(token);
        removeSlot(slot);
        throw error;
      }
    },
    remove() {
      generation += 1;
      removeSlot(0);
      removeSlot(1);
      configurations.delete(activeToken);
      activeToken = "";
      activeSlot = -1;
    },
    async contains(point) {
      const configuration = configurations.get(activeToken);
      if (!configuration) return false;
      const tile = tilePixel(point);
      const [jaarbak, urban] = await Promise.all([
        decodeTile(configuration.jaarbakUrl, tile.z, tile.x, tile.y),
        configuration.urbanMaskUrl ? decodeTile(configuration.urbanMaskUrl, tile.z, tile.x, tile.y) : null,
      ]);
      const offset = (tile.row * TILE_SIZE + tile.column) * 4;
      return Boolean(jaarbak && isOfficialSealedPixel(jaarbak.data, offset)
        && (!configuration.urbanMaskUrl || Boolean(urban && urban.data[offset + 3] > 0)));
    },
    layerId: () => activeSlot < 0 ? null : `${id}-${activeSlot}`,
  };
}

export function boundsFromCoordinates(coordinates) {
  const longitudes = coordinates.map(([longitude]) => longitude);
  const latitudes = coordinates.map(([, latitude]) => latitude);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}
