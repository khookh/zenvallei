import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "public", "data");

function parseArguments(argv) {
  const options = {
    manifestPath: path.join(DATA_DIR, "land-cover.json"),
    sectorsPath: path.join(DATA_DIR, "sectors.geojson"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    if (argv[index] === "--manifest") { options.manifestPath = path.resolve(next); index += 1; }
    else if (argv[index] === "--sectors") { options.sectorsPath = path.resolve(next); index += 1; }
    else throw new Error(`Onbekend argument: ${argv[index]}`);
  }
  return options;
}

function polygonScanlineIntersections(rings, scanY) {
  const intersections = [];
  for (const ring of rings) for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
      intersections.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1));
    }
  }
  return intersections.sort((left, right) => left - right);
}

function rasterizeMunicipalities(sectors, raster) {
  const [[minimumLongitude, minimumLatitude], [maximumLongitude, maximumLatitude]] = raster.bounds;
  const municipalities = [...new Set(sectors.features.map((feature) => feature.properties.municipality))].sort();
  const indexByMunicipality = new Map(municipalities.map((municipality, index) => [municipality, index + 1]));
  const output = new Uint8Array(raster.width * raster.height);
  const toPixel = ([longitude, latitude]) => [
    (longitude - minimumLongitude) / (maximumLongitude - minimumLongitude) * raster.width,
    (maximumLatitude - latitude) / (maximumLatitude - minimumLatitude) * raster.height,
  ];
  for (const feature of sectors.features) {
    const polygons = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [feature.geometry.coordinates];
    const value = indexByMunicipality.get(feature.properties.municipality);
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => ring.map(toPixel));
      const yValues = rings.flatMap((ring) => ring.map((coordinate) => coordinate[1]));
      const firstRow = Math.max(0, Math.ceil(Math.min(...yValues) - 0.5));
      const lastRow = Math.min(raster.height - 1, Math.floor(Math.max(...yValues) - 0.5));
      for (let row = firstRow; row <= lastRow; row += 1) {
        const intersections = polygonScanlineIntersections(rings, row + 0.5);
        for (let pair = 0; pair + 1 < intersections.length; pair += 2) {
          const firstColumn = Math.max(0, Math.ceil(intersections[pair] - 0.5));
          const lastColumn = Math.min(raster.width - 1, Math.floor(intersections[pair + 1] - 0.5));
          output.fill(value, row * raster.width + firstColumn, row * raster.width + lastColumn + 1);
        }
      }
    }
  }
  return { municipalities, indexByMunicipality, data: output };
}

function slug(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [manifest, sectors] = await Promise.all([
    fsp.readFile(options.manifestPath, "utf8").then(JSON.parse),
    fsp.readFile(options.sectorsPath, "utf8").then(JSON.parse),
  ]);
  const sourcePath = path.resolve(path.dirname(options.manifestPath), "..", manifest.raster.imageUrl);
  const { data: rgba, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== manifest.raster.width || info.height !== manifest.raster.height) throw new Error("De landbedekkingsafmetingen wijken af van het manifest.");
  const mask = rasterizeMunicipalities(sectors, manifest.raster);
  const variants = { all: manifest.raster.imageUrl };
  const outputDirectory = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  for (const municipality of mask.municipalities) {
    const output = Buffer.alloc(rgba.length);
    const municipalityIndex = mask.indexByMunicipality.get(municipality);
    for (let pixel = 0; pixel < mask.data.length; pixel += 1) {
      if (mask.data[pixel] !== municipalityIndex) continue;
      const offset = pixel * 4;
      output[offset] = rgba[offset]; output[offset + 1] = rgba[offset + 1];
      output[offset + 2] = rgba[offset + 2]; output[offset + 3] = rgba[offset + 3];
    }
    const filename = `${baseName}-${slug(municipality)}.png`;
    await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ palette: true, colours: 32, dither: 0, compressionLevel: 9 })
      .toFile(path.join(outputDirectory, filename));
    variants[municipality] = `data/land-cover/${filename}`;
  }
  manifest.raster.rasterVariants = variants;
  await fsp.writeFile(options.manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Klaar: ${mask.municipalities.length} gemeentelijke landbedekkingsrasters.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
