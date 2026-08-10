/**
 * Prepare two population-density views without mixing their methodologies.
 * Statbel's 2025 privacy-adjusted cells drive the current map, while matching
 * sector tables remain the authority for selected-area totals. The 2019
 * Flanders raster is retained as a separate historical 100 m model.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fromFile, writeArrayBuffer } from "geotiff";
import proj4 from "proj4";
import sharp from "sharp";
import xlsx from "xlsx";
import unzipper from "unzipper";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, ".cache", "population");
const OUTPUT_ROOT = path.join(ROOT, "public", "data", "population");
const MANIFEST_PATH = path.join(ROOT, "public", "data", "population.json");
const SECTORS_PATH = path.join(ROOT, "public", "data", "sectors.geojson");

const URLS = Object.freeze({
  grid2025: "https://statbel.fgov.be/sites/default/files/files/opendata/SH_VARYING_CELL_SIZE_GRID/POP_GRID_2025_3035_geojson.zip",
  sectors2025: "https://statbel.fgov.be/sites/default/files/files/opendata/bevolking/sectoren/OPENDATA_SECTOREN_2025_OLD.xlsx",
  sectors2019: "https://statbel.fgov.be/sites/default/files/files/opendata/bevolking/sectoren/OPEN%20DATA_SECTOREN_2019.xlsx",
  flanders2019: "https://datasets.omgeving.vlaanderen.be/be.vlaanderen.omgeving.distribution.geo.60ed653e-caac-41f8-a87b-9452d154a926.ni_inw_ha_vlaa_2019.zip",
});

const SOURCE_PAGES = Object.freeze({
  statbelGrid: "https://statbel.fgov.be/en/themes/datalab/variable-cell-grid",
  statbelSector: "https://statbel.fgov.be/en/open-data?category=89&page=0",
  flandersRaster: "https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019",
});

const CRS3035 = "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs";
const CRS31370 = "+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs";
proj4.defs("EPSG:3035", CRS3035);
proj4.defs("EPSG:31370", CRS31370);

const DATASETS = Object.freeze({
  statbel: "statbel-2025",
  flanders: "flanders-2019",
});
const MUNICIPALITIES = Object.freeze([
  "Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen", "Sint-Genesius-Rode", "Sint-Pieters-Leeuw",
]);
const BANDS = Object.freeze([
  { id: "zero", minimum: 0, maximum: 0, color: "#f2f3f5" },
  { id: "under-5", minimum: Number.MIN_VALUE, maximum: 5, color: "#edf8fb" },
  { id: "5-15", minimum: 5, maximum: 15, color: "#d7b5d8" },
  { id: "15-30", minimum: 15, maximum: 30, color: "#c994c7" },
  { id: "30-60", minimum: 30, maximum: 60, color: "#9e9ac8" },
  { id: "60-100", minimum: 60, maximum: 100, color: "#756bb1" },
  { id: "100-200", minimum: 100, maximum: 200, color: "#54278f" },
  { id: "200-plus", minimum: 200, maximum: null, color: "#2d004b" },
]);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function download(url, destination) {
  if (fs.existsSync(destination)) return destination;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Population source download failed: HTTP ${response.status} (${url}).`);
  const temporary = `${destination}.partial`;
  await pipeline(response.body, fs.createWriteStream(temporary));
  fs.renameSync(temporary, destination);
  return destination;
}

async function extractFirst(source, matcher, destination) {
  if (fs.existsSync(destination)) return destination;
  const archive = await unzipper.Open.file(source);
  const entry = archive.files.find((file) => matcher.test(file.path));
  if (!entry) throw new Error(`Archive ${path.basename(source)} does not contain the expected file.`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await pipeline(entry.stream(), fs.createWriteStream(destination));
  return destination;
}

function mapCoordinates(coordinates, transform) {
  if (typeof coordinates?.[0] === "number") return transform(coordinates);
  return coordinates.map((item) => mapCoordinates(item, transform));
}

function transformGeometry(geometry, from, to) {
  return { ...geometry, coordinates: mapCoordinates(geometry.coordinates, (coordinate) => proj4(from, to, coordinate)) };
}

function ringContains(ring, point) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(polygon, point) {
  return ringContains(polygon[0], point) && !polygon.slice(1).some((ring) => ringContains(ring, point));
}

function geometryContains(geometry, point) {
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return polygons.some((polygon) => polygonContains(polygon, point));
}

function polygonCentroid(ring) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const factor = ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
    twiceArea += factor;
    x += (ring[index][0] + ring[index + 1][0]) * factor;
    y += (ring[index][1] + ring[index + 1][1]) * factor;
  }
  if (Math.abs(twiceArea) < 1e-9) return ring[0];
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function featureAtPoint(sectors, point) {
  return sectors.find((sector) => (!sector.bounds
    || (point[0] >= sector.bounds[0] && point[0] <= sector.bounds[2]
      && point[1] >= sector.bounds[1] && point[1] <= sector.bounds[3]))
    && geometryContains(sector.geometry, point));
}

function boundsOf(features) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates?.[0] === "number") {
      bounds[0] = Math.min(bounds[0], coordinates[0]);
      bounds[1] = Math.min(bounds[1], coordinates[1]);
      bounds[2] = Math.max(bounds[2], coordinates[0]);
      bounds[3] = Math.max(bounds[3], coordinates[1]);
    } else coordinates.forEach(visit);
  };
  features.forEach(({ geometry }) => visit(geometry.coordinates));
  return bounds;
}

function officialRows(filePath, valueColumn, sectorIds) {
  const workbook = xlsx.read(fs.readFileSync(filePath));
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: null });
  const records = new Map();
  rows.forEach((row) => {
    const sectorId = String(row.CD_SECTOR ?? "").trim();
    if (!sectorIds.has(sectorId)) return;
    const population = Number(row[valueColumn]);
    const areaHa = Number(row["OPPERVLAKKTE IN HM²"]);
    records.set(sectorId, {
      sourceStatus: Number.isFinite(population) ? "available" : "not-published",
      population: Number.isFinite(population) ? population : null,
      areaHa: Number.isFinite(areaHa) ? areaHa : null,
      densityPerHa: Number.isFinite(population) && areaHa > 0 ? population / areaHa : null,
    });
  });
  const output = {};
  [...sectorIds].sort().forEach((sectorId) => {
    output[sectorId] = records.get(sectorId) ?? {
      sourceStatus: "sector-unmatched", population: null, areaHa: null, densityPerHa: null,
    };
  });
  if (Object.values(output).filter(({ sourceStatus }) => sourceStatus === "sector-unmatched").length) {
    throw new Error(`${path.basename(filePath)} does not match all 154 application sectors.`);
  }
  return output;
}

function aggregateStats(sectorStats, sectorFeatures) {
  const aggregate = (ids) => {
    const rows = ids.map((id) => sectorStats[id]);
    const population = rows.reduce((sum, row) => sum + (row.population ?? 0), 0);
    const areaHa = rows.reduce((sum, row) => sum + (row.areaHa ?? 0), 0);
    const available = rows.every((row) => row.sourceStatus === "available");
    return {
      sourceStatus: available ? "available" : "partly-unavailable",
      population: available ? population : null,
      areaHa,
      densityPerHa: available && areaHa > 0 ? population / areaHa : null,
      sectorCount: ids.length,
    };
  };
  const municipalityStats = Object.fromEntries(MUNICIPALITIES.map((municipality) => [
    municipality,
    aggregate(sectorFeatures.filter((feature) => feature.properties.municipality === municipality)
      .map((feature) => feature.properties.sectorId)),
  ]));
  return { municipalityStats, regionStats: aggregate(sectorFeatures.map((feature) => feature.properties.sectorId)) };
}

function bandFor(value) {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return BANDS[0];
  return BANDS.slice(1).find(({ minimum, maximum }) => value > minimum && (maximum === null || value <= maximum)) ?? BANDS.at(-1);
}

function rgbaFor(value, inScope) {
  if (!inScope) return [0, 0, 0, 0];
  if (!Number.isFinite(value) || value < 0) return [234, 226, 222, 255];
  const color = bandFor(value)?.color ?? "#EAE2DE";
  return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16), 255];
}

async function prepareGrid(sourcePath, projectedSectors) {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (source?.crs?.properties?.name !== "urn:ogc:def:crs:EPSG::3035") throw new Error("Statbel population grid is not EPSG:3035.");
  const features = [];
  const municipalityTotals = Object.fromEntries(MUNICIPALITIES.map((name) => [name, 0]));
  const regionBounds = boundsOf(projectedSectors);
  for (const feature of source.features) {
    const properties = feature.properties ?? {};
    const side = Number(properties.ms_len);
    const population = Number(properties.ms_pop);
    const areaKm2 = Number(properties.ms_km2);
    if (![125, 250, 500, 1000].includes(side) || !Number.isFinite(population) || !Number.isFinite(areaKm2) || areaKm2 <= 0) continue;
    const approximateCenter = [Number(properties.x_3035) + side / 2, Number(properties.y_3035) + side / 2];
    if (approximateCenter[0] < regionBounds[0] - side || approximateCenter[0] > regionBounds[2] + side
      || approximateCenter[1] < regionBounds[1] - side || approximateCenter[1] > regionBounds[3] + side) continue;
    const polygon = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates[0][0] : feature.geometry.coordinates[0];
    const centroid = polygonCentroid(polygon);
    const sector = featureAtPoint(projectedSectors, centroid);
    if (!sector) continue;
    const municipality = sector.properties.municipality;
    municipalityTotals[municipality] += population;
    const densityPerHa = population / (areaKm2 * 100);
    features.push({
      type: "Feature",
      id: `${properties.x_3035}-${properties.y_3035}-${side}`,
      properties: {
        cellId: `${properties.x_3035}-${properties.y_3035}-${side}`,
        municipality,
        population,
        sideM: side,
        areaKm2,
        densityPerHa: Number(densityPerHa.toFixed(6)),
        renderClass: bandFor(densityPerHa)?.id ?? "no-data",
      },
      geometry: transformGeometry(feature.geometry, "EPSG:3035", "EPSG:4326"),
    });
  }
  if (!features.length) throw new Error("No Statbel population cells intersect Zennevallei.");
  const output = { type: "FeatureCollection", name: "Statbel variable population grid 2025, Zennevallei", features };
  const destination = path.join(OUTPUT_ROOT, "population-grid-2025.geojson");
  fs.writeFileSync(destination, `${JSON.stringify(output)}\n`, "utf8");
  return { destination, cellCount: features.length, municipalityTotals };
}

async function prepareFlandersRaster(sourcePath, sectors31370) {
  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage();
  const [sourceMinX, , , sourceMaxY] = image.getBoundingBox();
  const [pixelWidth, pixelHeightRaw] = image.getResolution();
  const pixelHeight = Math.abs(pixelHeightRaw);
  if (image.getGeoKeys().ProjectedCSTypeGeoKey !== 31370 || pixelWidth !== 100 || pixelHeight !== 100) {
    throw new Error("The Flanders population raster must be EPSG:31370 at 100 m resolution.");
  }
  const [minX, minY, maxX, maxY] = boundsOf(sectors31370);
  const left = Math.max(0, Math.floor((minX - sourceMinX) / pixelWidth));
  const right = Math.min(image.getWidth(), Math.ceil((maxX - sourceMinX) / pixelWidth));
  const top = Math.max(0, Math.floor((sourceMaxY - maxY) / pixelHeight));
  const bottom = Math.min(image.getHeight(), Math.ceil((sourceMaxY - minY) / pixelHeight));
  const width = right - left;
  const height = bottom - top;
  const [values] = await image.readRasters({ window: [left, top, right, bottom] });
  const cropMinX = sourceMinX + left * pixelWidth;
  const cropMaxY = sourceMaxY - top * pixelHeight;
  const masked = new Float32Array(width * height).fill(-9999);
  const scopeByIndex = new Array(width * height).fill("");
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const point = [cropMinX + (column + 0.5) * pixelWidth, cropMaxY - (row + 0.5) * pixelHeight];
      const sector = featureAtPoint(sectors31370, point);
      if (!sector) continue;
      scopeByIndex[index] = sector.properties.municipality;
      const value = Number(values[index]);
      masked[index] = Number.isFinite(value) && value >= 0 ? value : -9999;
    }
  }

  const analyticalPath = path.join(OUTPUT_ROOT, "population-density-2019.tif");
  const arrayBuffer = await writeArrayBuffer(masked, {
    width, height, SampleFormat: [3], BitsPerSample: [32],
    ProjectedCSTypeGeoKey: 31370,
    ModelPixelScale: [pixelWidth, pixelHeight, 0],
    ModelTiepoint: [0, 0, 0, cropMinX, cropMaxY, 0],
    GDAL_NODATA: "-9999",
  });
  fs.writeFileSync(analyticalPath, Buffer.from(arrayBuffer));

  const variants = { all: "data/population/population-density-2019.png" };
  for (const scope of ["all", ...MUNICIPALITIES]) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < masked.length; index += 1) {
      const color = rgbaFor(masked[index], scopeByIndex[index] && (scope === "all" || scopeByIndex[index] === scope));
      rgba.set(color, index * 4);
    }
    const suffix = scope === "all" ? "" : `-${scope.toLocaleLowerCase("nl").replace(/[^a-z0-9]+/g, "-")}`;
    const fileName = `population-density-2019${suffix}.png`;
    await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, palette: true }).toFile(path.join(OUTPUT_ROOT, fileName));
    if (scope !== "all") variants[scope] = `data/population/${fileName}`;
  }
  const corners = [
    [cropMinX, cropMaxY],
    [cropMinX + width * pixelWidth, cropMaxY],
    [cropMinX + width * pixelWidth, cropMaxY - height * pixelHeight],
    [cropMinX, cropMaxY - height * pixelHeight],
  ].map((coordinate) => proj4("EPSG:31370", "EPSG:4326", coordinate));
  return { analyticalPath, width, height, corners, variants };
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const supplied = {
    grid: argumentValue("--grid"), sectors2025: argumentValue("--sectors-2025"),
    sectors2019: argumentValue("--sectors-2019"), flanders: argumentValue("--flanders-2019"),
  };
  const gridZip = supplied.grid ? path.resolve(supplied.grid) : await download(URLS.grid2025, path.join(CACHE, "population-grid-2025.zip"));
  const sectors2025Path = supplied.sectors2025 ? path.resolve(supplied.sectors2025) : await download(URLS.sectors2025, path.join(CACHE, "sectors-2025-old.xlsx"));
  const sectors2019Path = supplied.sectors2019 ? path.resolve(supplied.sectors2019) : await download(URLS.sectors2019, path.join(CACHE, "sectors-2019.xlsx"));
  const flandersZip = supplied.flanders ? path.resolve(supplied.flanders) : await download(URLS.flanders2019, path.join(CACHE, "flanders-population-2019.zip"));
  [gridZip, sectors2025Path, sectors2019Path, flandersZip].forEach((filePath) => {
    if (!fs.existsSync(filePath)) throw new Error(`Population source not found: ${filePath}`);
  });
  const gridPath = path.extname(gridZip).toLowerCase() === ".geojson" ? gridZip
    : await extractFirst(gridZip, /POP_GRID_2025_3035\.geojson$/i, path.join(CACHE, "POP_GRID_2025_3035.geojson"));
  const flandersPath = path.extname(flandersZip).toLowerCase() === ".tif" ? flandersZip
    : await extractFirst(flandersZip, /ni_inw_ha_vlaa_2019\.tif$/i, path.join(CACHE, "ni_inw_ha_vlaa_2019.tif"));

  const sectors = JSON.parse(fs.readFileSync(SECTORS_PATH, "utf8"));
  const sectorIds = new Set(sectors.features.map((feature) => feature.properties.sectorId));
  if (sectorIds.size !== 154) throw new Error(`Expected 154 application sectors, received ${sectorIds.size}.`);
  const projectSectors = (crs) => sectors.features.map((feature) => {
    const geometry = transformGeometry(feature.geometry, "EPSG:4326", crs);
    return { ...feature, geometry, bounds: boundsOf([{ geometry }]) };
  });
  const sectors3035 = projectSectors("EPSG:3035");
  const sectors31370 = projectSectors("EPSG:31370");
  const stats2025 = officialRows(sectors2025Path, "TOTAL", sectorIds);
  const stats2019 = officialRows(sectors2019Path, "POPULATION", sectorIds);
  const aggregates2025 = aggregateStats(stats2025, sectors.features);
  const aggregates2019 = aggregateStats(stats2019, sectors.features);
  const grid = await prepareGrid(gridPath, sectors3035);
  const raster = await prepareFlandersRaster(flandersPath, sectors31370);

  const manifest = {
    schemaVersion: 1,
    datasetId: "population-density",
    kind: "dataset-switch",
    availableDatasets: [DATASETS.statbel, DATASETS.flanders],
    defaultDataset: DATASETS.statbel,
    unit: "inhabitants-per-hectare",
    noDataColor: "#EAE2DE",
    bands: BANDS,
    datasets: {
      [DATASETS.statbel]: {
        kind: "variable-vector-grid",
        referenceDate: "2025-01-01",
        resolutionM: [125, 250, 500, 1000],
        mapUrl: "data/population/population-grid-2025.geojson",
        cellCount: grid.cellCount,
        sectorStats: stats2025,
        ...aggregates2025,
        source: {
          name: "Population grid with cells of varying size 2025",
          producer: "Statbel, the Belgian statistical office",
          pageUrl: SOURCE_PAGES.statbelGrid,
          gridDownloadUrl: URLS.grid2025,
          sectorDownloadUrl: URLS.sectors2025,
          gridSha256: sha256(gridZip),
          sectorSha256: sha256(sectors2025Path),
          confidentiality: "Cell subdivision and geographical displacement follow Statbel confidentiality rules.",
          aggregationWarning: "Grid cells are a density display and may cross administrative boundaries; selected-area totals use the separate official sector table.",
        },
      },
      [DATASETS.flanders]: {
        kind: "modelled-raster",
        referenceDate: "2019-01-01",
        resolutionM: 100,
        imageVariants: raster.variants,
        analyticalUrl: "data/population/population-density-2019.tif",
        width: raster.width,
        height: raster.height,
        corners: raster.corners,
        sectorStats: stats2019,
        ...aggregates2019,
        source: {
          name: "Inwonersdichtheid per ha - Vlaanderen - toestand 2019",
          producer: "Department of Environment & Spatial Development, Government of Flanders",
          pageUrl: SOURCE_PAGES.flandersRaster,
          downloadUrl: URLS.flanders2019,
          rasterSha256: sha256(flandersZip),
          sectorSha256: sha256(sectors2019Path),
        },
      },
    },
    geometry: {
      authority: "Statbel",
      referenceDate: "2024-01-01",
      sectorCount: 154,
      sourceSha256: sha256(SECTORS_PATH),
    },
    processedAt: new Date().toISOString(),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Prepared ${grid.cellCount} Statbel cells and a ${raster.width} x ${raster.height} Flanders raster.`);
  console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
