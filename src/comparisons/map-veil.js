const SOURCE_ID = "comparison-basemap-veil-source";
const LAYER_ID = "comparison-basemap-veil";

const WORLD = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]],
  },
};

/** Subdue OSM without changing the basemap or its attribution. */
export function showComparisonVeil(map, beforeLayerId, opacity = 0.46) {
  if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, { type: "geojson", data: WORLD });
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": "#e7e9e7", "fill-opacity": opacity },
    }, beforeLayerId);
  } else {
    map.setPaintProperty(LAYER_ID, "fill-opacity", opacity);
    map.setLayoutProperty(LAYER_ID, "visibility", "visible");
    map.moveLayer(LAYER_ID, beforeLayerId);
  }
}

export function hideComparisonVeil(map) {
  if (map?.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, "visibility", "none");
}

export const comparisonVeilLayerId = () => LAYER_ID;
