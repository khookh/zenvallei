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

  const remove = () => {
    if (!map) return;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  };

  const add = () => {
    const url = getArchiveUrl();
    if (!map || !url) return false;
    remove();
    currentUrl = url;
    map.addSource(sourceId, { type: "raster", url: `pmtiles://${url}`, tileSize: 256 });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      minzoom: 0,
      layout: { visibility: visible ? "visible" : "none" },
      paint: {
        "raster-opacity": opacity,
        "raster-resampling": "nearest",
        "raster-fade-duration": 0,
      },
    }, beforeLayerId);
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
  };
}
