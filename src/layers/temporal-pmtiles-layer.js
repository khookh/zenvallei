let protocolInstalled = false;
let protocolPromise;

async function installPmtilesProtocol() {
  if (protocolInstalled) return;
  if (!protocolPromise) {
    protocolPromise = Promise.all([import("maplibre-gl"), import("pmtiles")]).then(([maplibregl, { Protocol }]) => {
      const protocol = new Protocol();
      maplibregl.addProtocol("pmtiles", protocol.tile);
      protocolInstalled = true;
    });
  }
  await protocolPromise;
}

/**
 * Own the MapLibre lifecycle for one temporal raster-PMTiles dataset. Dataset
 * modules retain responsibility for meaning, statistics and presentation.
 */
export function createTemporalPmtilesMap({ layerId, sourceId, opacity = 0.68, getArchiveUrl }) {
  let map = null;
  let beforeLayerId;
  let visible = false;
  let currentUrl = "";
  let currentOpacity = opacity;
  let generation = 0;
  let readiness = {
    url: "", generation: 0, status: "idle", error: null,
    promise: Promise.resolve({ ready: false, generation: 0 }),
  };
  let cancelReadinessWatch = () => {};

  const reassertPresentation = () => {
    if (!map?.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    map.setPaintProperty(layerId, "raster-opacity", currentOpacity);
    map.triggerRepaint();
  };

  const remove = () => {
    if (!map) return;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  };

  const watchCurrentSource = (sourceGeneration, url) => {
    cancelReadinessWatch();
    const state = {
      url, generation: sourceGeneration, status: "loading", error: null, promise: null,
    };
    readiness = state;
    state.promise = new Promise((resolve) => {
      let settled = false;
      let timeout;
      const finish = (ready, error = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        map?.off("sourcedata", onSourceData);
        map?.off("error", onError);
        if (readiness === state) {
          state.status = ready ? "ready" : "error";
          state.error = error;
        }
        if (ready && sourceGeneration === generation) reassertPresentation();
        resolve({ ready: Boolean(ready && sourceGeneration === generation), generation: sourceGeneration, error });
      };
      const check = () => {
        if (sourceGeneration !== generation) return finish(false, new Error("Raster source was superseded."));
        if (map?.getSource(sourceId) && map.isSourceLoaded(sourceId)) finish(true);
      };
      const onSourceData = (event) => { if (event.sourceId === sourceId) check(); };
      const onError = (event) => {
        // Raster errors from OSM or another active layer must never poison this
        // dataset's readiness state.
        if (event.sourceId === sourceId) finish(false, event.error ?? new Error("Raster source failed."));
      };
      map.on("sourcedata", onSourceData);
      map.on("error", onError);
      const timeoutMs = import.meta.env.DEV ? 45_000 : 15_000;
      timeout = window.setTimeout(() => finish(false, new Error("Raster source readiness timed out.")), timeoutMs);
      cancelReadinessWatch = () => finish(false, new Error("Raster source was superseded."));
      queueMicrotask(check);
    });
    return state.promise;
  };

  const add = () => {
    const url = getArchiveUrl();
    if (!map || !url) return false;
    cancelReadinessWatch();
    remove();
    const sourceGeneration = ++generation;
    currentUrl = url;
    map.addSource(sourceId, { type: "raster", url: `pmtiles://${url}`, tileSize: 256 });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      minzoom: 0,
      layout: { visibility: visible ? "visible" : "none" },
      paint: {
        "raster-opacity": currentOpacity,
        "raster-resampling": "nearest",
        "raster-fade-duration": 0,
      },
    }, beforeLayerId);
    watchCurrentSource(sourceGeneration, url);
    return true;
  };

  const ensureReady = async ({ retry = false } = {}) => {
    if (!map || !currentUrl || !map.getSource(sourceId)) throw new Error("Raster source is not mounted.");
    if (map.isSourceLoaded(sourceId)) {
      readiness = {
        url: currentUrl, generation, status: "ready", error: null,
        promise: Promise.resolve({ ready: true, generation }),
      };
      reassertPresentation();
      return generation;
    }
    if (retry && readiness.status === "error") add();
    else if (readiness.status !== "loading" || readiness.url !== currentUrl || readiness.generation !== generation) {
      watchCurrentSource(generation, currentUrl);
    }
    const result = await readiness.promise;
    if (!result.ready) throw result.error ?? new Error("Raster source is not ready.");
    return result.generation;
  };

  return {
    async mount(nextMap, context) {
      map = nextMap;
      beforeLayerId = context.beforeLayerId;
      if (map.getLayer(layerId)) {
        reassertPresentation();
        return true;
      }
      await installPmtilesProtocol();
      return add();
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      reassertPresentation();
    },
    refresh({ force = false } = {}) {
      const nextUrl = getArchiveUrl();
      if (!map || !nextUrl) return false;
      if (!map.getLayer(layerId) || !map.getSource(sourceId) || force) return add();
      if (nextUrl === currentUrl) {
        reassertPresentation();
        return true;
      }
      return add();
    },
    setOpacity(value) {
      currentOpacity = Number(value);
      reassertPresentation();
    },
    getOpacity: () => currentOpacity,
    whenReady: ensureReady,
    getReadiness: () => ({
      url: readiness.url, generation: readiness.generation, status: readiness.status, error: readiness.error,
    }),
  };
}
