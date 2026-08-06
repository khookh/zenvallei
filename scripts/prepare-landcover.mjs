/**
 * Validate and window the pinned Copernicus LCM-10 COG. Nearest-neighbour
 * sampling preserves categorical codes; latitude-weighted pixels provide the
 * area summaries written to the browser manifest.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fromFile } from "geotiff";
import sharp from "sharp";
import unzipper from "unzipper";
import {
  BUILT_UP_CODES,
  CHANGE_CLASSES,
  LCM_CLASSES,
  VEGETATION_CODES,
  buildLandCoverOutput,
  classifyVegetationChange,
  createGrid,
  detectRasterContainer,
  rasterizeSectorMask,
  resampleClasses,
  summarizeVegetationChange,
} from "./lib/landcover-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_CACHE = path.join(PROJECT_ROOT, ".cache", "land-cover");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "public", "data");
const SOURCE_2020 = Object.freeze({
  dataset: "lcm_global_10m_yearly_v1",
  year: 2020,
  productName: "LCFM_LCM-10_V100_2020_N48E003_cog",
  productId: "0d1a8740-7798-4c23-b057-beffba83cccd",
  expectedMd5: "a71128e04beb6f1a148af7557db17179",
  expectedBytes: 104_123_112,
  contentType: "application/tiff",
  doi: "https://doi.org/10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9",
  productUrl: "https://land.copernicus.eu/en/products/global-dynamic-land-cover/land-cover-2020-raster-10-m-global-annual",
});
const DOWNLOAD_ROOT = "https://download.dataspace.copernicus.eu/odata/v1/Products";

function parseArguments(argv) {
  const options = {
    cacheDir: DEFAULT_CACHE,
    outputDir: DEFAULT_OUTPUT,
    geometryPath: path.join(DEFAULT_OUTPUT, "sectors.geojson"),
    provenancePath: path.join(DEFAULT_OUTPUT, "provenance.json"),
    comparisonYear: 2026,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--cog": options.cogPath = path.resolve(value); index += 1; break;
      case "--comparison-cog": options.comparisonCogPath = path.resolve(value); index += 1; break;
      case "--comparison-year": options.comparisonYear = Number(value); index += 1; break;
      case "--comparison-product-id": options.comparisonProductId = value; index += 1; break;
      case "--comparison-md5": options.comparisonMd5 = value; index += 1; break;
      case "--geometry": options.geometryPath = path.resolve(value); index += 1; break;
      case "--provenance": options.provenancePath = path.resolve(value); index += 1; break;
      case "--cache": options.cacheDir = path.resolve(value); index += 1; break;
      case "--output": options.outputDir = path.resolve(value); index += 1; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Gebruik: npm run landcover:prepare -- [opties]\n\n` +
    `  --cog <pad>                  Gebruik een lokaal officieel LCM-10-product (.tif of .zip)\n` +
    `  --comparison-cog <pad>       Optioneel later-jaar GeoTIFF voor verandering\n` +
    `  --comparison-year <jaar>     Vergelijkingsjaar (standaard 2026)\n` +
    `  --comparison-product-id <id> Verplichte officiële bron-ID bij vergelijking\n` +
    `  --comparison-md5 <hash>      Verplichte officiële MD5 bij vergelijking\n` +
    `  --geometry <pad>             Zennevallei GeoJSON\n` +
    `  --output <map>               Uitvoermap\n\n` +
    `Zonder --cog downloadt het script het gepinde 2020-product met CDSE_ACCESS_TOKEN.`);
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function validateSourceFile(filePath, source) {
  const [fileStats, md5, sha256] = await Promise.all([
    fsp.stat(filePath),
    hashFile(filePath, "md5"),
    hashFile(filePath, "sha256"),
  ]);
  if (source.expectedBytes && fileStats.size !== source.expectedBytes) {
    throw new Error(`CDSE-productgrootte wijkt af: verwacht ${source.expectedBytes}, ontvangen ${fileStats.size}.`);
  }
  if (source.expectedMd5 && md5.toLowerCase() !== source.expectedMd5.toLowerCase()) {
    throw new Error(`CDSE-producthash wijkt af: verwacht ${source.expectedMd5}, ontvangen ${md5}.`);
  }
  return { md5, sha256, byteLength: fileStats.size };
}

async function downloadProduct(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (await fsp.stat(destination).catch(() => null)) {
    try {
      await validateSourceFile(destination, source);
      return destination;
    } catch {
      // A partial or outdated cache entry must never be used as source data.
    }
    await fsp.rm(destination);
  }
  const token = process.env.CDSE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("CDSE_ACCESS_TOKEN ontbreekt. Stel een tijdelijk toegangstoken in of gebruik --cog met het officiële GeoTIFF of de CDSE-ZIP.");
  }
  const response = await fetch(`${DOWNLOAD_ROOT}(${source.productId})/$value`, {
    headers: { Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` },
  });
  if (!response.ok || !response.body) throw new Error(`CDSE-download mislukt: HTTP ${response.status}.`);
  const temporaryPath = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath));
  try {
    await validateSourceFile(temporaryPath, source);
  } catch (error) {
    await fsp.rm(temporaryPath);
    throw error;
  }
  await fsp.rename(temporaryPath, destination);
  return destination;
}

async function findGeoTiff(inputPath, extractionRoot) {
  const stat = await fsp.stat(inputPath);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(inputPath, { withFileTypes: true });
    for (const entry of entries) {
      const found = await findGeoTiff(path.join(inputPath, entry.name), extractionRoot).catch(() => null);
      if (found) return found;
    }
    throw new Error(`Geen GeoTIFF gevonden in ${inputPath}.`);
  }
  const signature = Buffer.alloc(4);
  const handle = await fsp.open(inputPath, "r");
  try {
    await handle.read(signature, 0, 4, 0);
  } finally {
    await handle.close();
  }
  const format = detectRasterContainer(signature);
  if (format === "tiff") return inputPath;
  if (format !== "zip") throw new Error(`Onbekend LCM-10-bestandsformaat: ${inputPath}.`);
  await fsp.mkdir(extractionRoot, { recursive: true });
  await fs.createReadStream(inputPath).pipe(unzipper.Extract({ path: extractionRoot })).promise();
  return findGeoTiff(extractionRoot, extractionRoot);
}

function boundsFromProvenance(provenance) {
  const { minLon, minLat, maxLon, maxLat } = provenance.output.bounds;
  return [[minLon, minLat], [maxLon, maxLat]];
}

async function readSourceWindow(cogPath, bounds) {
  const tiff = await fromFile(cogPath);
  const image = await tiff.getImage();
  const geoKeys = image.getGeoKeys();
  if (geoKeys.GeographicTypeGeoKey !== 4326) {
    throw new Error(`LCM-10 GeoTIFF gebruikt geen EPSG:4326 (gevonden ${geoKeys.GeographicTypeGeoKey ?? "onbekend"}).`);
  }
  if (image.getSamplesPerPixel() !== 1) {
    throw new Error(`LCM-10 GeoTIFF moet exact één classificatieband bevatten (gevonden ${image.getSamplesPerPixel()}).`);
  }
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  if (Math.abs(Math.abs(resolution[0]) - 1 / 12_000) > 1e-8 || Math.abs(Math.abs(resolution[1]) - 1 / 12_000) > 1e-8) {
    throw new Error(`Onverwachte LCM-10 rasterresolutie: ${resolution.join(", ")}.`);
  }
  const imageBounds = image.getBoundingBox();
  if (imageBounds[0] > bounds[0][0] || imageBounds[1] > bounds[0][1]
      || imageBounds[2] < bounds[1][0] || imageBounds[3] < bounds[1][1]) {
    throw new Error("Het LCM-10 GeoTIFF dekt niet de volledige Zennevallei.");
  }
  const xCoordinates = bounds.map((coordinate) => (coordinate[0] - origin[0]) / resolution[0]);
  const yCoordinates = [bounds[1], bounds[0]].map((coordinate) => (coordinate[1] - origin[1]) / resolution[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xCoordinates)) - 1);
  const x1 = Math.min(image.getWidth(), Math.ceil(Math.max(...xCoordinates)) + 1);
  const y0 = Math.max(0, Math.floor(Math.min(...yCoordinates)) - 1);
  const y1 = Math.min(image.getHeight(), Math.ceil(Math.max(...yCoordinates)) + 1);
  const data = await image.readRasters({ window: [x0, y0, x1, y1], interleave: true });
  return { data, width: x1 - x0, height: y1 - y0, window: [x0, y0, x1, y1], origin, resolution };
}

async function writePng(rgba, grid, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await sharp(rgba, { raw: { width: grid.width, height: grid.height, channels: 4 } })
    .png({ palette: true, colours: 16, dither: 0, compressionLevel: 9 })
    .toFile(destination);
}

async function prepareSource(options, sourceDefinition) {
  let productPath = options.cogPath;
  if (!productPath) {
    const archivePath = path.join(options.cacheDir, `${sourceDefinition.productName}.zip`);
    const legacyCachePath = path.join(options.cacheDir, `${sourceDefinition.productName}.tif`);
    productPath = await fsp.stat(archivePath).then(() => archivePath).catch(async () => (
      fsp.stat(legacyCachePath).then(() => legacyCachePath).catch(() => archivePath)
    ));
    await downloadProduct(sourceDefinition, productPath);
  }
  const hashes = await validateSourceFile(productPath, sourceDefinition);
  return {
    path: await findGeoTiff(productPath, path.join(options.cacheDir, sourceDefinition.productName)),
    downloaded: !options.cogPath,
    ...hashes,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const [geojson, provenance] = await Promise.all([
    fsp.readFile(options.geometryPath, "utf8").then(JSON.parse),
    fsp.readFile(options.provenancePath, "utf8").then(JSON.parse),
  ]);
  if (geojson.features.length !== 154) throw new Error("De sectorgeometrie bevat niet exact 154 Zennevallei-sectoren.");
  const bounds = boundsFromProvenance(provenance);
  const grid = createGrid(bounds, 10);
  console.log(`Bereid LCM-10-raster voor op ${grid.width} × ${grid.height} pixels…`);
  const sectorMask = rasterizeSectorMask(geojson, grid);
  const representedSectors = new Set(sectorMask.mask).size - 1;
  if (representedSectors !== 154) throw new Error(`Het uitvoerraster bevat ${representedSectors} in plaats van 154 sectoren.`);
  const baseProduct = await prepareSource(options, SOURCE_2020);
  const baseSource = await readSourceWindow(baseProduct.path, bounds);
  const baseClasses = resampleClasses(baseSource, grid);
  const landCoverOutput = buildLandCoverOutput(baseClasses, sectorMask, grid, geojson);
  if (Object.keys(landCoverOutput.sectorStats).length !== 154
      || Object.values(landCoverOutput.sectorStats).some((stats) => stats.totalAreaHa <= 0)) {
    throw new Error("Het basisraster levert geen volledige statistieken voor alle 154 sectoren.");
  }
  const landCoverDirectory = path.join(options.outputDir, "land-cover");
  const baseImageName = "land-cover-2020.png";
  await writePng(landCoverOutput.rgba, grid, path.join(landCoverDirectory, baseImageName));
  let activeYear = 2020;
  let activeImageName = baseImageName;
  let activeLandCoverOutput = landCoverOutput;
  let availableYears = [2020];

  let change = {
    available: false,
    baseYear: 2020,
    comparisonYear: options.comparisonYear,
    palette: CHANGE_CLASSES,
    reason: "comparison-year-not-published",
  };
  if (options.comparisonCogPath) {
    if (!Number.isInteger(options.comparisonYear) || options.comparisonYear <= SOURCE_2020.year) {
      throw new Error("Het vergelijkingsjaar moet een geheel jaar na 2020 zijn.");
    }
    if (!options.comparisonProductId || !options.comparisonMd5) {
      throw new Error("Een officieel vergelijkingsraster vereist --comparison-product-id en --comparison-md5.");
    }
    const comparisonFile = await validateSourceFile(options.comparisonCogPath, {
      expectedMd5: options.comparisonMd5,
    });
    const comparisonSource = await readSourceWindow(options.comparisonCogPath, bounds);
    const comparisonClasses = resampleClasses(comparisonSource, grid);
    activeLandCoverOutput = buildLandCoverOutput(comparisonClasses, sectorMask, grid, geojson);
    if (Object.values(activeLandCoverOutput.sectorStats).some((stats) => stats.totalAreaHa <= 0)) {
      throw new Error("Het vergelijkingsraster levert geen volledige statistieken voor alle 154 sectoren.");
    }
    activeYear = options.comparisonYear;
    activeImageName = `land-cover-${activeYear}.png`;
    availableYears = [2020, activeYear];
    await writePng(activeLandCoverOutput.rgba, grid, path.join(landCoverDirectory, activeImageName));
    const changeOutput = classifyVegetationChange(baseClasses, comparisonClasses, sectorMask.mask);
    const imageName = `vegetation-change-2020-${options.comparisonYear}.png`;
    await writePng(changeOutput.rgba, grid, path.join(landCoverDirectory, imageName));
    change = {
      available: true,
      baseYear: 2020,
      comparisonYear: options.comparisonYear,
      imageUrl: `data/land-cover/${imageName}`,
      coordinates: grid.coordinates,
      palette: CHANGE_CLASSES,
      vegetationCodes: VEGETATION_CODES,
      sectorStats: summarizeVegetationChange(baseClasses, comparisonClasses, sectorMask, grid, geojson),
      sourceHashes: {
        2020: { md5: baseProduct.md5, sha256: baseProduct.sha256 },
        [options.comparisonYear]: { md5: comparisonFile.md5, sha256: comparisonFile.sha256 },
      },
      source: {
        productId: options.comparisonProductId,
        md5: comparisonFile.md5,
        sha256: comparisonFile.sha256,
        byteLength: comparisonFile.byteLength,
      },
    };
  }

  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    generatedAt,
    availableYears,
    activeYear,
    opacity: 0.68,
    raster: {
      available: true,
      year: activeYear,
      imageUrl: `data/land-cover/${activeImageName}`,
      width: grid.width,
      height: grid.height,
      bounds,
      coordinates: grid.coordinates,
    },
    classes: LCM_CLASSES.map((entry) => ({ ...entry, present: activeLandCoverOutput.presentCodes.includes(entry.code) })),
    vegetationCodes: VEGETATION_CODES,
    builtUpCodes: BUILT_UP_CODES,
    metricDefinitions: {
      vegetation: {
        classCodes: VEGETATION_CODES,
        denominator: "classified-area",
        description: "Tree cover and grassland only; cropland and all other LCM-10 classes are excluded.",
      },
      builtUp: {
        classCodes: BUILT_UP_CODES,
        denominator: "classified-area",
        description: "LCM-10 built-up class; this is a classification estimate, not a cadastral or soil-sealing measurement.",
      },
    },
    sectorStats: activeLandCoverOutput.sectorStats,
    change,
    source: {
      ...SOURCE_2020,
      accessedAt: generatedAt,
      md5: baseProduct.md5,
      sha256: baseProduct.sha256,
      byteLength: baseProduct.byteLength,
      crs: "EPSG:4326",
      nativeResolutionDegrees: [1 / 12_000, 1 / 12_000],
      processing: "Clipped to the Statbel sector union and resampled to Web Mercator with nearest-neighbour sampling.",
      attribution: "Generated using European Union's Copernicus Land Monitoring Service information.",
    },
  };
  await fsp.writeFile(path.join(options.outputDir, "land-cover.json"), JSON.stringify(manifest, null, 2));
  console.log(`Klaar: ${baseImageName}, ${landCoverOutput.presentCodes.length} klassen, 154 sectorstatistieken.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
