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
  let readyPromise = Promise.resolve({ ready: false, generation: 0 });

  const remove = () => {
    if (!map) return;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  };

  const add = () => {
    const url = getArchiveUrl();
    if (!map || !url) return false;
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
    readyPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ready, error = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        map.off("sourcedata", onSourceData);
        map.off("error", onError);
        if (ready && sourceGeneration === generation && map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
          map.setPaintProperty(layerId, "raster-opacity", currentOpacity);
        }
        resolve({ ready: Boolean(ready && sourceGeneration === generation), generation: sourceGeneration, error });
      };
      const check = () => {
        if (sourceGeneration !== generation) return finish(false, new Error("Raster source was superseded."));
        if (map.isSourceLoaded(sourceId)) finish(true);
      };
      const onSourceData = (event) => { if (event.sourceId === sourceId) check(); };
      const onError = (event) => {
        if (event.sourceId === sourceId || /pmtiles|raster/i.test(event.error?.message ?? "")) finish(false, event.error);
      };
      map.on("sourcedata", onSourceData);
      map.on("error", onError);
      const timeout = window.setTimeout(() => finish(false, new Error("Raster source readiness timed out.")), 8000);
      queueMicrotask(check);
    });
    return true;
  };

  return {
    async mount(nextMap, context) {
      map = nextMap;
      beforeLayerId = context.beforeLayerId;
      if (map.getLayer(layerId)) return true;
      await installPmtilesProtocol();
      return add();
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      if (map?.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    },
    refresh() {
      const nextUrl = getArchiveUrl();
      if (!map || !nextUrl || nextUrl === currentUrl) return Boolean(nextUrl);
      return add();
    },
    setOpacity(value) {
      currentOpacity = Number(value);
      if (map?.getLayer(layerId)) map.setPaintProperty(layerId, "raster-opacity", currentOpacity);
    },
    getOpacity: () => currentOpacity,
    async whenReady() {
      const result = await readyPromise;
      if (!result.ready) throw result.error ?? new Error("Raster source is not ready.");
      return result.generation;
    },
  };
}
