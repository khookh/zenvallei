/**
 * Generate the Greenwave brand mark from the committed Statbel sector geometry.
 *
 * Input:  public/data/sectors.geojson in WGS84.
 * Output: public/assets/zennevallei-river-mark.png, a transparent 512 px PNG.
 *
 * The white silhouette is the dissolved Zennevallei sector union. The blue,
 * near-vertical elongated-S curve is intentionally a brand element, not
 * hydrographic data. Its short overshoot keeps the river legible at 42-46 px.
 */
import fs from "node:fs/promises";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import proj4 from "proj4";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const INPUT = path.join(ROOT, "public", "data", "sectors.geojson");
const OUTPUT = path.join(ROOT, "public", "assets", "zennevallei-river-mark.png");
const SIZE = 512;
const PADDING = 30;
const LAMBERT_2008 = "+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 +x_0=649328 +y_0=665262 +ellps=GRS80 +units=m +no_defs";

function asMultiPolygon(geometry) {
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "Polygon") return [geometry.coordinates];
  throw new TypeError(`Niet-ondersteund geometrietype voor het logo: ${geometry.type}.`);
}

function projectUnion(union) {
  return union.map((polygon) => polygon.map((ring) => ring.map(([longitude, latitude]) => (
    proj4("EPSG:4326", LAMBERT_2008, [longitude, latitude])
  ))));
}

function boundsOf(union) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  union.forEach((polygon) => polygon.forEach((ring) => ring.forEach(([x, y]) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  })));
  return bounds;
}

function createTransform(bounds) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scale = Math.min((SIZE - PADDING * 2) / width, (SIZE - PADDING * 2) / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  const offsetX = (SIZE - drawnWidth) / 2;
  const offsetY = (SIZE - drawnHeight) / 2;
  return {
    point: ([x, y]) => [
      offsetX + (x - bounds.minX) * scale,
      offsetY + drawnHeight - (y - bounds.minY) * scale,
    ],
    box: { x: offsetX, y: offsetY, width: drawnWidth, height: drawnHeight },
  };
}

function pathData(union, transform) {
  return union.map((polygon) => polygon.map((ring) => ring.map((coordinate, index) => {
    const [x, y] = transform.point(coordinate);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ") + " Z").join(" ")).join(" ");
}

function riverPath(box) {
  const { x, y, width, height } = box;
  return [
    `M ${(x + width * 0.55).toFixed(2)} ${(y + height * 1.05).toFixed(2)}`,
    `C ${(x + width * 0.42).toFixed(2)} ${(y + height * 0.88).toFixed(2)},`,
    `${(x + width * 0.43).toFixed(2)} ${(y + height * 0.67).toFixed(2)},`,
    `${(x + width * 0.54).toFixed(2)} ${(y + height * 0.56).toFixed(2)}`,
    `C ${(x + width * 0.65).toFixed(2)} ${(y + height * 0.45).toFixed(2)},`,
    `${(x + width * 0.62).toFixed(2)} ${(y + height * 0.23).toFixed(2)},`,
    `${(x + width * 0.48).toFixed(2)} ${(y - height * 0.05).toFixed(2)}`,
  ].join(" ");
}

async function main() {
  const geojson = JSON.parse(await fs.readFile(INPUT, "utf8"));
  if (geojson.features?.length !== 154) throw new Error("Het logo vereist exact 154 Zennevallei-sectoren.");
  const municipalities = new Set(geojson.features.map((feature) => feature.properties.municipality));
  if (municipalities.size !== 7) throw new Error("Het logo vereist exact zeven Zennevallei-gemeenten.");

  const union = polygonClipping.union(...geojson.features.map((feature) => asMultiPolygon(feature.geometry)));
  const projected = projectUnion(union);
  const transform = createTransform(boundsOf(projected));
  const silhouette = pathData(projected, transform);
  const river = riverPath(transform.box);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    <path d="${silhouette}" fill="#ffffff" fill-rule="evenodd"/>
    <path d="${river}" fill="none" stroke="#48b8e7" stroke-width="37" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(OUTPUT);
  console.log(`Klaar: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
