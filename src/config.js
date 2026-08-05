export const MAP_CONFIG = Object.freeze({
  tileUrl: import.meta.env.VITE_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution:
    import.meta.env.VITE_TILE_ATTRIBUTION ||
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
  tileSize: 256,
  maximumZoom: 19,
});
