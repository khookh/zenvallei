import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fromFile } from "geotiff";
import proj4 from "proj4";
import sharp from "sharp";
import {
  VEGETATION_EXCLUDED_CODES,
  VEGETATION_MASKED_SCL_CODES,
  VEGETATION_NEGATIVE_CODES,
  VEGETATION_PALETTE,
  VEGETATION_POSITIVE_CODES,
  calibrateNdviThreshold,
  rasterizeProjectedFeatures,
  roundMetric,
} from "./lib/vegetation-core.mjs";
import {
  multiPolygonAreaSquareMeters,
  projectMultiPolygon,
  toMultiPolygonCoordinates,
} from "./lib/urban-atlas-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "public", "data");
const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "vegetation");
const DEFAULT_DATE = "2023-06-24";
const DEFAULT_SOURCE_NAME = "sentinel-2-l2a-ndvi-validity-2023-06-24-epsg32631-10m.tif";
const EPSG_32631 = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs";
const SUBPIXEL_SCALE = 3;
const SUBPIXEL_AREA_SQUARE_METERS = 100 / (SUBPIXEL_SCALE ** 2);
const NDVI_BIN_COUNT = 2001;

function parseArguments(argv) {
  const options = {
    date: DEFAULT_DATE,
    cacheDir: DEFAULT_CACHE_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    sectorsPath: path.join(DEFAULT_OUTPUT_DIR, "sectors.geojson"),
    urbanAtlasPath: path.join(DEFAULT_OUTPUT_DIR, "urban-atlas.geojson"),
    urbanAtlasManifestPath: path.join(DEFAULT_OUTPUT_DIR, "urban-atlas.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    switch (argv[index]) {
      case "--date": options.date = next; index += 1; break;
      case "--source": options.sourcePath = path.resolve(next); index += 1; break;
      case "--sectors": options.sectorsPath = path.resolve(next); index += 1; break;
      case "--urban-atlas": options.urbanAtlasPath = path.resolve(next); index += 1; break;
      case "--urban-atlas-manifest": options.urbanAtlasManifestPath = path.resolve(next); index += 1; break;
      case "--cache": options.cacheDir = path.resolve(next); index += 1; break;
      case "--output": options.outputDir = path.resolve(next); index += 1; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Gebruik: pnpm vegetation:prepare -- [opties]\n\n` +
    `  --date <JJJJ-MM-DD>         Opnamedatum; deze versie ondersteunt 2023-06-24\n` +
    `  --source <pad>              Reeds gedownload NDVI/geldigheid-GeoTIFF\n` +
    `  --sectors <pad>             Statbel-sectoren in WGS84\n` +
    `  --urban-atlas <pad>         Voorbereide Urban Atlas-fragmenten\n` +
    `  --urban-atlas-manifest <pad> Urban Atlas-bronmanifest\n` +
    `  --cache <map>               Lokale cachemap\n` +
    `  --output <map>              Browserklare uitvoermap\n\n` +
    `Als de cache ontbreekt, start dit commando eerst vegetation:download.`);
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function runDownloader(options) {
  const arguments_ = [path.join(PROJECT_ROOT, "scripts", "download-vegetation.mjs"), "--date", options.date, "--cache", options.cacheDir];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: PROJECT_ROOT, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0) throw new Error("De Sentinel-2-download is mislukt.");
}

async function resolveSource(options) {
  if (options.sourcePath) return options.sourcePath;
  const cachedPath = path.join(options.cacheDir, DEFAULT_SOURCE_NAME);
  if (!await fsp.stat(cachedPath).catch(() => null)) await runDownloader(options);
  return cachedPath;
}

function projectedFeature(feature, projector) {
  return {
    type: "Feature",
    properties: feature.properties,
    geometry: {
      type: "MultiPolygon",
      coordinates: projectMultiPolygon(toMultiPolygonCoordinates(feature.geometry), projector),
    },
  };
}

async function readRaster(sourcePath) {
  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage();
  const geoKeys = image.getGeoKeys();
  if (geoKeys.ProjectedCSTypeGeoKey !== 32631) {
    throw new Error(`Het Sentinel-2-raster gebruikt EPSG:${geoKeys.ProjectedCSTypeGeoKey ?? "onbekend"}; verwacht EPSG:32631.`);
  }
  if (image.getSamplesPerPixel() !== 2) {
    throw new Error(`Het Sentinel-2-raster bevat ${image.getSamplesPerPixel()} banden; verwacht NDVI en geldigheid.`);
  }
  const resolution = image.getResolution();
  if (Math.abs(Math.abs(resolution[0]) - 10) > 0.01 || Math.abs(Math.abs(resolution[1]) - 10) > 0.01) {
    throw new Error(`Het Sentinel-2-raster heeft geen resolutie van 10 meter: ${resolution.join(", ")}.`);
  }
  const [ndvi, validity] = await image.readRasters({ samples: [0, 1], interleave: false });
  const [originX, originY] = image.getOrigin();
  const grid = {
    minX: originX,
    maxY: originY,
    resolution: 10,
    width: image.getWidth(),
    height: image.getHeight(),
  };
  grid.maxX = grid.minX + grid.width * grid.resolution;
  grid.minY = grid.maxY - grid.height * grid.resolution;
  let validCount = 0;
  for (let index = 0; index < validity.length; index += 1) {
    if (validity[index] < 0.5) continue;
    if (!Number.isFinite(ndvi[index]) || ndvi[index] < -1 || ndvi[index] > 1) {
      throw new Error(`Ongeldige NDVI-waarde op rasterindex ${index}: ${ndvi[index]}.`);
    }
    validCount += 1;
  }
  if (validCount / validity.length < 0.5) throw new Error("Het Sentinel-2-raster bevat onvoldoende geldige observaties.");
  return { image, ndvi, validity, grid, validCount };
}

function dominantSubpixelValue(raster, column, row, counts) {
  counts.fill(0);
  const startX = column * raster.scale;
  const startY = row * raster.scale;
  let bestValue = 0;
  let bestCount = 0;
  for (let yOffset = 0; yOffset < raster.scale; yOffset += 1) {
    const offset = (startY + yOffset) * raster.width + startX;
    for (let xOffset = 0; xOffset < raster.scale; xOffset += 1) {
      const value = raster.data[offset + xOffset];
      if (!value) continue;
      counts[value] += 1;
      if (counts[value] > bestCount || (counts[value] === bestCount && value < bestValue)) {
        bestValue = value;
        bestCount = counts[value];
      }
    }
  }
  return [bestValue, bestCount];
}

function calibrationValues(ndvi, validity, urbanAtlasRaster, classCodes, grid) {
  const positive = [];
  const negative = [];
  const positiveSet = new Set(VEGETATION_POSITIVE_CODES);
  const negativeSet = new Set(VEGETATION_NEGATIVE_CODES);
  const counts = new Uint8Array(classCodes.length);
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const pixelIndex = row * grid.width + column;
      if (validity[pixelIndex] < 0.5) continue;
      const [classIndex, voteCount] = dominantSubpixelValue(urbanAtlasRaster, column, row, counts);
      if (voteCount < 8) continue;
      const code = classCodes[classIndex];
      if (positiveSet.has(code)) positive.push(ndvi[pixelIndex]);
      else if (negativeSet.has(code)) negative.push(ndvi[pixelIndex]);
    }
  }
  if (positive.length < 1_000 || negative.length < 1_000) {
    throw new Error(`Onvoldoende zuivere kalibratiepixels: ${positive.length} groen en ${negative.length} sterk verhard.`);
  }
  return { positive, negative };
}

function ndviHistogramIndex(value) {
  return Math.max(0, Math.min(NDVI_BIN_COUNT - 1, Math.round((value + 1) * 1000)));
}

function histogramMedian(histogram, count) {
  if (!count) return null;
  const target = Math.ceil(count / 2);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index];
    if (cumulative >= target) return roundMetric(-1 + index / 1000, 3);
  }
  return 1;
}

function rgbaForClassification(ndvi, validity, sectorRaster, urbanAtlasRaster, classCodes, threshold, grid) {
  const output = Buffer.alloc(grid.width * grid.height * 4);
  const sectorCounts = new Uint8Array(155);
  const classCounts = new Uint8Array(classCodes.length);
  const excluded = new Set(VEGETATION_EXCLUDED_CODES);
  const colors = {
    likely: Buffer.from(VEGETATION_PALETTE.likelyVegetated.slice(1), "hex"),
    below: Buffer.from(VEGETATION_PALETTE.belowThreshold.slice(1), "hex"),
  };
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const pixelIndex = row * grid.width + column;
      if (validity[pixelIndex] < 0.5) continue;
      const [, sectorVotes] = dominantSubpixelValue(sectorRaster, column, row, sectorCounts);
      if (sectorVotes < 5) continue;
      const [classIndex] = dominantSubpixelValue(urbanAtlasRaster, column, row, classCounts);
      if (excluded.has(classCodes[classIndex])) continue;
      const color = ndvi[pixelIndex] >= threshold ? colors.likely : colors.below;
      const outputIndex = pixelIndex * 4;
      output[outputIndex] = color[0];
      output[outputIndex + 1] = color[1];
      output[outputIndex + 2] = color[2];
      output[outputIndex + 3] = 255;
    }
  }
  return output;
}

function buildSectorStatistics(ndvi, validity, sectorRaster, urbanAtlasRaster, classCodes, sectorFeatures, grid, threshold) {
  const accumulators = sectorFeatures.map(() => ({
    totalSquareMeters: 0,
    validSquareMeters: 0,
    likelySquareMeters: 0,
    belowSquareMeters: 0,
    arableSquareMeters: 0,
    waterSquareMeters: 0,
    missingSquareMeters: 0,
    ndviCount: 0,
    ndviHistogram: new Uint32Array(NDVI_BIN_COUNT),
  }));
  const arableIndex = classCodes.indexOf("21000");
  const waterIndex = classCodes.indexOf("50000");
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const pixelIndex = row * grid.width + column;
      const isValid = validity[pixelIndex] >= 0.5;
      const value = ndvi[pixelIndex];
      const startX = column * sectorRaster.scale;
      const startY = row * sectorRaster.scale;
      for (let yOffset = 0; yOffset < sectorRaster.scale; yOffset += 1) {
        const highResolutionOffset = (startY + yOffset) * sectorRaster.width + startX;
        for (let xOffset = 0; xOffset < sectorRaster.scale; xOffset += 1) {
          const highResolutionIndex = highResolutionOffset + xOffset;
          const sectorIndex = sectorRaster.data[highResolutionIndex] - 1;
          if (sectorIndex < 0) continue;
          const accumulator = accumulators[sectorIndex];
          accumulator.totalSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
          if (!isValid) {
            accumulator.missingSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
            continue;
          }
          accumulator.validSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
          accumulator.ndviCount += 1;
          accumulator.ndviHistogram[ndviHistogramIndex(value)] += 1;
          const urbanAtlasIndex = urbanAtlasRaster.data[highResolutionIndex];
          if (urbanAtlasIndex === arableIndex) accumulator.arableSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
          else if (urbanAtlasIndex === waterIndex) accumulator.waterSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
          else if (value >= threshold) accumulator.likelySquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
          else accumulator.belowSquareMeters += SUBPIXEL_AREA_SQUARE_METERS;
        }
      }
    }
  }

  const sectorStats = {};
  for (let index = 0; index < sectorFeatures.length; index += 1) {
    const feature = sectorFeatures[index];
    const accumulator = accumulators[index];
    const exactSquareMeters = multiPolygonAreaSquareMeters(feature.geometry.coordinates);
    const normalisation = exactSquareMeters / accumulator.totalSquareMeters;
    if (!Number.isFinite(normalisation) || Math.abs(1 - normalisation) > 0.005) {
      throw new Error(`De rasterdekking voor sector ${feature.properties.sectorId} wijkt meer dan 0,5% af.`);
    }
    const areaHa = (squareMeters) => roundMetric(squareMeters * normalisation / 10_000, 2);
    const percentage = (squareMeters) => accumulator.validSquareMeters > 0
      ? roundMetric(squareMeters / accumulator.validSquareMeters * 100, 2)
      : 0;
    const reconciled = accumulator.likelySquareMeters + accumulator.belowSquareMeters
      + accumulator.arableSquareMeters + accumulator.waterSquareMeters;
    if (Math.abs(reconciled - accumulator.validSquareMeters) > 0.01) {
      throw new Error(`De categorieën voor sector ${feature.properties.sectorId} sluiten niet aan op de geldige oppervlakte.`);
    }
    sectorStats[feature.properties.sectorId] = {
      sectorAreaHa: areaHa(accumulator.totalSquareMeters),
      validAreaHa: areaHa(accumulator.validSquareMeters),
      likelyVegetatedAreaHa: areaHa(accumulator.likelySquareMeters),
      likelyVegetatedPercentage: percentage(accumulator.likelySquareMeters),
      belowThresholdAreaHa: areaHa(accumulator.belowSquareMeters),
      belowThresholdPercentage: percentage(accumulator.belowSquareMeters),
      excludedArableAreaHa: areaHa(accumulator.arableSquareMeters),
      excludedArablePercentage: percentage(accumulator.arableSquareMeters),
      excludedWaterAreaHa: areaHa(accumulator.waterSquareMeters),
      excludedWaterPercentage: percentage(accumulator.waterSquareMeters),
      missingObservationAreaHa: areaHa(accumulator.missingSquareMeters),
      medianNdvi: histogramMedian(accumulator.ndviHistogram, accumulator.ndviCount),
    };
  }
  return sectorStats;
}

function browserCoordinates(grid) {
  const toWgs84 = (coordinate) => proj4(EPSG_32631, "EPSG:4326", coordinate);
  return [
    toWgs84([grid.minX, grid.maxY]),
    toWgs84([grid.maxX, grid.maxY]),
    toWgs84([grid.maxX, grid.minY]),
    toWgs84([grid.minX, grid.minY]),
  ];
}

async function readSourceMetadata(sourcePath) {
  const sidecarPath = `${sourcePath}.json`;
  return fsp.readFile(sidecarPath, "utf8").then(JSON.parse).catch(() => null);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.date !== DEFAULT_DATE) throw new Error(`Deze eerste versie ondersteunt alleen ${DEFAULT_DATE}.`);
  const sourcePath = await resolveSource(options);
  const [raster, sectors, urbanAtlas, urbanAtlasManifest, sourceMetadata, sourceSha256] = await Promise.all([
    readRaster(sourcePath),
    fsp.readFile(options.sectorsPath, "utf8").then(JSON.parse),
    fsp.readFile(options.urbanAtlasPath, "utf8").then(JSON.parse),
    fsp.readFile(options.urbanAtlasManifestPath, "utf8").then(JSON.parse),
    readSourceMetadata(sourcePath),
    hashFile(sourcePath),
  ]);
  if (sectors.features?.length !== 154) throw new Error("De Statbel-bron bevat niet exact 154 sectoren.");
  if (!urbanAtlas.features?.length || urbanAtlasManifest?.activeYear !== 2021) {
    throw new Error("De voorbereide Urban Atlas 2021-bron ontbreekt of is ongeldig.");
  }
  const projector = (coordinate) => proj4("EPSG:4326", EPSG_32631, coordinate);
  const sectorFeatures = sectors.features.map((feature) => projectedFeature(feature, projector));
  const urbanAtlasFeatures = urbanAtlas.features.map((feature) => projectedFeature(feature, projector));
  const classCodes = [null, ...urbanAtlasManifest.classes.map((entry) => String(entry.code))];
  const classIndex = new Map(classCodes.map((code, index) => [code, index]));
  const grid = raster.grid;

  console.log(`Rasteriseer 154 Statbel-sectoren op ${SUBPIXEL_SCALE} x subpixelresolutie...`);
  const sectorRaster = rasterizeProjectedFeatures(
    sectorFeatures,
    grid,
    (feature) => sectorFeatures.indexOf(feature) + 1,
    { scale: SUBPIXEL_SCALE, ArrayType: Uint16Array },
  );
  console.log(`Rasteriseer ${urbanAtlasFeatures.length} Urban Atlas-fragmenten...`);
  const urbanAtlasRaster = rasterizeProjectedFeatures(
    urbanAtlasFeatures,
    grid,
    (feature) => classIndex.get(String(feature.properties.classCode)) ?? 0,
    { scale: SUBPIXEL_SCALE, ArrayType: Uint8Array },
  );

  console.log("Kalibreer de NDVI-drempel met zuivere Urban Atlas-pixels...");
  const samples = calibrationValues(raster.ndvi, raster.validity, urbanAtlasRaster, classCodes, grid);
  const calibration = calibrateNdviThreshold(samples.positive, samples.negative);
  console.log(`Drempel ${calibration.threshold.toFixed(3)}; AUC ${calibration.auc.toFixed(3)}; ${samples.positive.length} groene en ${samples.negative.length} verharde pixels.`);

  const sectorStats = buildSectorStatistics(
    raster.ndvi,
    raster.validity,
    sectorRaster,
    urbanAtlasRaster,
    classCodes,
    sectorFeatures,
    grid,
    calibration.threshold,
  );
  if (Object.keys(sectorStats).length !== 154) throw new Error("De uitvoer bevat niet exact 154 sectorstatistieken.");
  const rgba = rgbaForClassification(
    raster.ndvi,
    raster.validity,
    sectorRaster,
    urbanAtlasRaster,
    classCodes,
    calibration.threshold,
    grid,
  );
  const imageDirectory = path.join(options.outputDir, "vegetation");
  const imageFilename = "likely-vegetation-2023.png";
  const imagePath = path.join(imageDirectory, imageFilename);
  await fsp.mkdir(imageDirectory, { recursive: true });
  await sharp(rgba, { raw: { width: grid.width, height: grid.height, channels: 4 } })
    .png({ palette: true, colours: 8, dither: 0, compressionLevel: 9 })
    .toFile(imagePath);

  const generatedAt = new Date().toISOString();
  const year = 2023;
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    available: true,
    activeYear: year,
    availableYears: [year],
    opacity: 0.68,
    palette: {
      likelyVegetated: VEGETATION_PALETTE.likelyVegetated,
      belowThreshold: VEGETATION_PALETTE.belowThreshold,
      excludedNoObservation: "transparent",
    },
    definitions: {
      calibrationPositiveCodes: VEGETATION_POSITIVE_CODES,
      calibrationNegativeCodes: VEGETATION_NEGATIVE_CODES,
      excludedCodes: VEGETATION_EXCLUDED_CODES,
      maskedSclCodes: VEGETATION_MASKED_SCL_CODES,
      headlineDenominator: "complete-valid-sentinel-2-sector-area",
      classification: "NDVI at or above the frozen threshold is likely vegetated; Urban Atlas arable land and water are excluded from display but retained in the denominator.",
    },
    years: {
      [year]: {
        year,
        acquisitionDate: options.date,
        acquisitionTime: sourceMetadata?.acquisitionTime ?? "2023-06-24T10:46:21Z",
        imageUrl: `data/vegetation/${imageFilename}`,
        width: grid.width,
        height: grid.height,
        crs: "EPSG:32631",
        pixelSizeMeters: 10,
        coordinates: browserCoordinates(grid),
        threshold: calibration.threshold,
        calibration,
        sectorStats,
      },
    },
    source: {
      collection: "sentinel-2-l2a",
      products: sourceMetadata?.products ?? [],
      cloudCoverLimitPercentage: 1,
      inputBands: ["B04", "B08", "SCL", "dataMask"],
      requestHash: sourceMetadata?.requestHash ?? null,
      responseSha256: sourceSha256,
      byteLength: (await fsp.stat(sourcePath)).size,
      accessedAt: sourceMetadata?.downloadedAt ?? generatedAt,
      productUrl: "https://dataspace.copernicus.eu/explore-data/data-collections/sentinel-data/sentinel-2",
      processApiDocumentationUrl: "https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html",
      attribution: "Derived using European Union Copernicus Sentinel-2 information.",
    },
    calibrationSource: {
      dataset: urbanAtlasManifest.source.dataset,
      referenceYear: 2021,
      productId: urbanAtlasManifest.source.productId,
      doi: urbanAtlasManifest.source.doi,
      sourceSha256: urbanAtlasManifest.source.sha256,
      caveat: "Urban Atlas represents 2021 while the NDVI observation is from 2023. Changed areas and polygon generalisation can contaminate calibration.",
    },
    processing: {
      generatedAt,
      outputImageSha256: await hashFile(imagePath),
      subpixelSampling: "3 x 3; calibration requires at least 8 of 9 samples in one reference class.",
      areaCalculation: "10 m pixels split into 3 x 3 samples in EPSG:32631 and normalised to full projected sector area.",
      nearestNeighbour: true,
      sectorCount: 154,
    },
  };
  await fsp.writeFile(path.join(options.outputDir, "vegetation.json"), JSON.stringify(manifest, null, 2));
  console.log(`Klaar: ${imageFilename}, ${Object.keys(sectorStats).length} sectoren.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
