import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fromFile } from "geotiff";
import proj4 from "proj4";
import sharp from "sharp";
import {
  VEGETATION_EXCLUDED_LAND_COVER_CODES,
  VEGETATION_EXCLUDED_URBAN_ATLAS_CODES,
  VEGETATION_MASKED_SCL_CODES,
  VEGETATION_NEGATIVE_CODES,
  VEGETATION_PALETTE,
  VEGETATION_POSITIVE_CODES,
  calibrateNdviThreshold,
  rasterizeProjectedFeatures,
  roundMetric,
} from "./lib/vegetation-core.mjs";
import { multiPolygonAreaSquareMeters, projectMultiPolygon, toMultiPolygonCoordinates } from "./lib/urban-atlas-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DATA = path.join(PROJECT_ROOT, "public", "data");
const CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "vegetation");
const EPSG_32631 = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs";
const SUBPIXEL_SCALE = 3;
const SUBPIXEL_AREA = 100 / (SUBPIXEL_SCALE ** 2);
const NDVI_BIN_COUNT = 2001;
const CALIBRATION_YEAR = 2023;

function parseArguments(argv) {
  const options = {
    cacheDir: CACHE_DIR,
    outputDir: PUBLIC_DATA,
    selectionPath: path.join(CACHE_DIR, "selection.json"),
    sectorsPath: path.join(PUBLIC_DATA, "sectors.geojson"),
    urbanAtlasPath: path.join(PUBLIC_DATA, "urban-atlas.geojson"),
    urbanAtlasManifestPath: path.join(PUBLIC_DATA, "urban-atlas.json"),
    landCoverManifestPath: path.join(PUBLIC_DATA, "land-cover.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    switch (argv[index]) {
      case "--cache": options.cacheDir = path.resolve(next); index += 1; break;
      case "--output": options.outputDir = path.resolve(next); index += 1; break;
      case "--selection": options.selectionPath = path.resolve(next); index += 1; break;
      case "--sectors": options.sectorsPath = path.resolve(next); index += 1; break;
      case "--urban-atlas": options.urbanAtlasPath = path.resolve(next); index += 1; break;
      case "--urban-atlas-manifest": options.urbanAtlasManifestPath = path.resolve(next); index += 1; break;
      case "--land-cover-manifest": options.landCoverManifestPath = path.resolve(next); index += 1; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log("Gebruik: pnpm vegetation:prepare -- [--selection <pad>] [--cache <map>] [--output <map>]");
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function projectedFeature(feature) {
  return {
    type: "Feature",
    properties: feature.properties,
    geometry: {
      type: "MultiPolygon",
      coordinates: projectMultiPolygon(
        toMultiPolygonCoordinates(feature.geometry),
        (coordinate) => proj4("EPSG:4326", EPSG_32631, coordinate),
      ),
    },
  };
}

async function readRaster(sourcePath) {
  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage();
  const geoKeys = image.getGeoKeys();
  if (geoKeys.ProjectedCSTypeGeoKey !== 32631 || image.getSamplesPerPixel() !== 2) {
    throw new Error(`${path.basename(sourcePath)} is geen NDVI/geldigheidsraster in EPSG:32631.`);
  }
  const resolution = image.getResolution();
  if (Math.abs(Math.abs(resolution[0]) - 10) > 0.01 || Math.abs(Math.abs(resolution[1]) - 10) > 0.01) {
    throw new Error(`${path.basename(sourcePath)} heeft geen resolutie van 10 meter.`);
  }
  const [ndvi, validity] = await image.readRasters({ samples: [0, 1], interleave: false });
  const [minX, maxY] = image.getOrigin();
  const grid = {
    minX,
    maxY,
    resolution: 10,
    width: image.getWidth(),
    height: image.getHeight(),
  };
  grid.maxX = grid.minX + grid.width * 10;
  grid.minY = grid.maxY - grid.height * 10;
  return { ndvi, validity, grid };
}

function sameGrid(left, right) {
  return left.width === right.width && left.height === right.height
    && left.minX === right.minX && left.maxY === right.maxY && left.resolution === right.resolution;
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

function calibrationValues(raster, urbanAtlasRaster, classCodes) {
  const positive = [];
  const negative = [];
  const positiveCodes = new Set(VEGETATION_POSITIVE_CODES);
  const negativeCodes = new Set(VEGETATION_NEGATIVE_CODES);
  const counts = new Uint8Array(classCodes.length);
  for (let row = 0; row < raster.grid.height; row += 1) {
    for (let column = 0; column < raster.grid.width; column += 1) {
      const pixel = row * raster.grid.width + column;
      if (raster.validity[pixel] < 0.5) continue;
      const [classIndex, votes] = dominantSubpixelValue(urbanAtlasRaster, column, row, counts);
      if (votes < 8) continue;
      const code = classCodes[classIndex];
      if (positiveCodes.has(code)) positive.push(raster.ndvi[pixel]);
      else if (negativeCodes.has(code)) negative.push(raster.ndvi[pixel]);
    }
  }
  if (positive.length < 1_000 || negative.length < 1_000) {
    throw new Error(`Onvoldoende kalibratiepixels: ${positive.length} groene en ${negative.length} sterk verharde pixels.`);
  }
  return { positive, negative };
}

async function createCroplandMask(grid, manifestPath) {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const imagePath = path.resolve(path.dirname(manifestPath), "..", manifest.raster.imageUrl);
  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [[minimumLongitude, minimumLatitude], [maximumLongitude, maximumLatitude]] = manifest.raster.bounds;
  const cropland = manifest.classes.find((entry) => Number(entry.code) === 40);
  if (!cropland || cropland.color.toLowerCase() !== "#f096ff") throw new Error("LCM-10-klasse 40 of haar officiële kleur ontbreekt.");
  const target = Buffer.from(cropland.color.slice(1), "hex");
  const mask = new Uint8Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row += 1) {
    const northing = grid.maxY - (row + 0.5) * 10;
    for (let column = 0; column < grid.width; column += 1) {
      const easting = grid.minX + (column + 0.5) * 10;
      const [longitude, latitude] = proj4(EPSG_32631, "EPSG:4326", [easting, northing]);
      const sourceColumn = Math.floor((longitude - minimumLongitude) / (maximumLongitude - minimumLongitude) * info.width);
      const sourceRow = Math.floor((maximumLatitude - latitude) / (maximumLatitude - minimumLatitude) * info.height);
      if (sourceColumn < 0 || sourceColumn >= info.width || sourceRow < 0 || sourceRow >= info.height) continue;
      const offset = (sourceRow * info.width + sourceColumn) * 4;
      if (data[offset] === target[0] && data[offset + 1] === target[1] && data[offset + 2] === target[2] && data[offset + 3] > 0) {
        mask[row * grid.width + column] = 1;
      }
    }
  }
  return { mask, source: manifest.source, classCode: 40 };
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

function ndviHistogramIndex(value) {
  return Math.max(0, Math.min(NDVI_BIN_COUNT - 1, Math.round((value + 1) * 1000)));
}

function buildStatistics(raster, sectorRaster, urbanAtlasRaster, classCodes, sectorFeatures, croplandMask, threshold) {
  const accumulators = sectorFeatures.map(() => ({
    total: 0, valid: 0, likely: 0, below: 0, cropland: 0, water: 0, missing: 0,
    ndviCount: 0, histogram: new Uint32Array(NDVI_BIN_COUNT),
  }));
  const waterIndex = classCodes.indexOf("50000");
  for (let row = 0; row < raster.grid.height; row += 1) {
    for (let column = 0; column < raster.grid.width; column += 1) {
      const pixel = row * raster.grid.width + column;
      const valid = raster.validity[pixel] >= 0.5;
      const startX = column * sectorRaster.scale;
      const startY = row * sectorRaster.scale;
      for (let yOffset = 0; yOffset < sectorRaster.scale; yOffset += 1) {
        const start = (startY + yOffset) * sectorRaster.width + startX;
        for (let xOffset = 0; xOffset < sectorRaster.scale; xOffset += 1) {
          const subpixel = start + xOffset;
          const sectorIndex = sectorRaster.data[subpixel] - 1;
          if (sectorIndex < 0) continue;
          const stats = accumulators[sectorIndex];
          stats.total += SUBPIXEL_AREA;
          if (!valid) { stats.missing += SUBPIXEL_AREA; continue; }
          stats.valid += SUBPIXEL_AREA;
          stats.ndviCount += 1;
          stats.histogram[ndviHistogramIndex(raster.ndvi[pixel])] += 1;
          if (croplandMask[pixel]) stats.cropland += SUBPIXEL_AREA;
          else if (urbanAtlasRaster.data[subpixel] === waterIndex) stats.water += SUBPIXEL_AREA;
          else if (raster.ndvi[pixel] >= threshold) stats.likely += SUBPIXEL_AREA;
          else stats.below += SUBPIXEL_AREA;
        }
      }
    }
  }
  return Object.fromEntries(sectorFeatures.map((feature, index) => {
    const stats = accumulators[index];
    const exactArea = multiPolygonAreaSquareMeters(feature.geometry.coordinates);
    const normalisation = exactArea / stats.total;
    if (!Number.isFinite(normalisation) || Math.abs(1 - normalisation) > 0.005) {
      throw new Error(`Rasterdekking wijkt meer dan 0,5% af voor ${feature.properties.sectorId}.`);
    }
    const area = (value) => roundMetric(value * normalisation / 10_000, 2);
    const share = (value) => stats.valid ? roundMetric(value / stats.valid * 100, 2) : 0;
    const reconciled = stats.likely + stats.below + stats.cropland + stats.water;
    if (Math.abs(reconciled - stats.valid) > 0.01) throw new Error(`Oppervlakten sluiten niet aan voor ${feature.properties.sectorId}.`);
    return [feature.properties.sectorId, {
      sectorAreaHa: area(stats.total),
      validAreaHa: area(stats.valid),
      likelyVegetatedAreaHa: area(stats.likely),
      likelyVegetatedPercentage: share(stats.likely),
      belowThresholdAreaHa: area(stats.below),
      belowThresholdPercentage: share(stats.below),
      excludedCroplandAreaHa: area(stats.cropland),
      excludedCroplandPercentage: share(stats.cropland),
      excludedWaterAreaHa: area(stats.water),
      excludedWaterPercentage: share(stats.water),
      missingObservationAreaHa: area(stats.missing),
      medianNdvi: histogramMedian(stats.histogram, stats.ndviCount),
    }];
  }));
}

function createRgba(raster, sectorRaster, urbanAtlasRaster, classCodes, croplandMask, threshold) {
  const output = Buffer.alloc(raster.grid.width * raster.grid.height * 4);
  const sectorCounts = new Uint8Array(155);
  const classCounts = new Uint8Array(classCodes.length);
  const waterIndex = classCodes.indexOf("50000");
  const likely = Buffer.from(VEGETATION_PALETTE.likelyVegetated.slice(1), "hex");
  const below = Buffer.from(VEGETATION_PALETTE.belowThreshold.slice(1), "hex");
  for (let row = 0; row < raster.grid.height; row += 1) {
    for (let column = 0; column < raster.grid.width; column += 1) {
      const pixel = row * raster.grid.width + column;
      if (raster.validity[pixel] < 0.5 || croplandMask[pixel]) continue;
      const [, sectorVotes] = dominantSubpixelValue(sectorRaster, column, row, sectorCounts);
      if (sectorVotes < 5) continue;
      const [classIndex] = dominantSubpixelValue(urbanAtlasRaster, column, row, classCounts);
      if (classIndex === waterIndex) continue;
      const color = raster.ndvi[pixel] >= threshold ? likely : below;
      const offset = pixel * 4;
      output[offset] = color[0]; output[offset + 1] = color[1]; output[offset + 2] = color[2]; output[offset + 3] = 255;
    }
  }
  return output;
}

function municipalityPixelMask(sectorRaster, sectorFeatures, grid) {
  const municipalities = [...new Set(sectorFeatures.map((feature) => feature.properties.municipality))].sort();
  const municipalityIndex = new Map(municipalities.map((municipality, index) => [municipality, index + 1]));
  const sectorMunicipality = sectorFeatures.map((feature) => municipalityIndex.get(feature.properties.municipality));
  const mask = new Uint8Array(grid.width * grid.height);
  const counts = new Uint8Array(155);
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const [sectorIndex, votes] = dominantSubpixelValue(sectorRaster, column, row, counts);
      if (votes >= 5) mask[row * grid.width + column] = sectorMunicipality[sectorIndex - 1] ?? 0;
    }
  }
  return { municipalities, municipalityIndex, mask };
}

function slug(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function writePng(rgba, grid, outputPath) {
  await sharp(rgba, { raw: { width: grid.width, height: grid.height, channels: 4 } })
    .png({ palette: true, colours: 8, dither: 0, compressionLevel: 9 })
    .toFile(outputPath);
}

async function writeRasterVariants(rgba, grid, municipalityMask, directory, year) {
  const baseName = `likely-vegetation-${year}`;
  const allPath = path.join(directory, `${baseName}.png`);
  await writePng(rgba, grid, allPath);
  const variants = { all: `data/vegetation/${baseName}.png` };
  for (const municipality of municipalityMask.municipalities) {
    const selected = Buffer.alloc(rgba.length);
    const index = municipalityMask.municipalityIndex.get(municipality);
    for (let pixel = 0; pixel < municipalityMask.mask.length; pixel += 1) {
      if (municipalityMask.mask[pixel] !== index) continue;
      const offset = pixel * 4;
      selected[offset] = rgba[offset];
      selected[offset + 1] = rgba[offset + 1];
      selected[offset + 2] = rgba[offset + 2];
      selected[offset + 3] = rgba[offset + 3];
    }
    const filename = `${baseName}-${slug(municipality)}.png`;
    await writePng(selected, grid, path.join(directory, filename));
    variants[municipality] = `data/vegetation/${filename}`;
  }
  return { variants, hash: await hashFile(allPath) };
}

function browserCoordinates(grid) {
  const convert = (coordinate) => proj4(EPSG_32631, "EPSG:4326", coordinate);
  return [convert([grid.minX, grid.maxY]), convert([grid.maxX, grid.maxY]), convert([grid.maxX, grid.minY]), convert([grid.minX, grid.minY])];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const [selection, sectors, urbanAtlas, urbanAtlasManifest] = await Promise.all([
    fsp.readFile(options.selectionPath, "utf8").then(JSON.parse),
    fsp.readFile(options.sectorsPath, "utf8").then(JSON.parse),
    fsp.readFile(options.urbanAtlasPath, "utf8").then(JSON.parse),
    fsp.readFile(options.urbanAtlasManifestPath, "utf8").then(JSON.parse),
  ]);
  if (sectors.features?.length !== 154 || !selection.years?.[CALIBRATION_YEAR]) throw new Error("De sectoren of jaarselectie zijn onvolledig.");
  const jobs = Object.values(selection.years).map((entry) => ({
    ...entry,
    sourcePath: path.join(options.cacheDir, `sentinel-2-l2a-ndvi-validity-${entry.selectedDate}-epsg32631-10m.tif`),
  })).sort((left, right) => left.year - right.year);
  for (const job of jobs) if (!await fsp.stat(job.sourcePath).catch(() => null)) throw new Error(`Ontbrekend raster voor ${job.year}: ${job.sourcePath}`);

  const referenceJob = jobs.find((job) => job.year === CALIBRATION_YEAR);
  const referenceRaster = await readRaster(referenceJob.sourcePath);
  const sectorFeatures = sectors.features.map(projectedFeature);
  const urbanAtlasFeatures = urbanAtlas.features.map(projectedFeature);
  const classCodes = [null, ...urbanAtlasManifest.classes.map((entry) => String(entry.code))];
  const classIndex = new Map(classCodes.map((code, index) => [code, index]));
  console.log("Rasteriseer Statbel-sectoren en Urban Atlas één keer voor alle jaren...");
  const sectorRaster = rasterizeProjectedFeatures(sectorFeatures, referenceRaster.grid, (feature) => sectorFeatures.indexOf(feature) + 1, { scale: SUBPIXEL_SCALE, ArrayType: Uint16Array });
  const urbanAtlasRaster = rasterizeProjectedFeatures(urbanAtlasFeatures, referenceRaster.grid, (feature) => classIndex.get(String(feature.properties.classCode)) ?? 0, { scale: SUBPIXEL_SCALE, ArrayType: Uint8Array });
  const calibrationSamples = calibrationValues(referenceRaster, urbanAtlasRaster, classCodes);
  const calibration = calibrateNdviThreshold(calibrationSamples.positive, calibrationSamples.negative);
  console.log(`Bevroren drempel ${calibration.threshold.toFixed(3)} uit ${CALIBRATION_YEAR}; AUC ${calibration.auc.toFixed(3)}.`);
  console.log("Maak LCM-10-croplandmasker voor klasse 40...");
  const cropland = await createCroplandMask(referenceRaster.grid, options.landCoverManifestPath);
  const municipalityMask = municipalityPixelMask(sectorRaster, sectorFeatures, referenceRaster.grid);
  const imageDirectory = path.join(options.outputDir, "vegetation");
  await fsp.mkdir(imageDirectory, { recursive: true });

  const years = {};
  for (const job of jobs) {
    console.log(`Verwerk vegetatie-indicatie ${job.year} (${job.selectedDate})...`);
    const raster = job.year === CALIBRATION_YEAR ? referenceRaster : await readRaster(job.sourcePath);
    if (!sameGrid(referenceRaster.grid, raster.grid)) throw new Error(`Rastergrid voor ${job.year} wijkt af van ${CALIBRATION_YEAR}.`);
    const sectorStats = buildStatistics(raster, sectorRaster, urbanAtlasRaster, classCodes, sectorFeatures, cropland.mask, calibration.threshold);
    const rgba = createRgba(raster, sectorRaster, urbanAtlasRaster, classCodes, cropland.mask, calibration.threshold);
    const output = await writeRasterVariants(rgba, raster.grid, municipalityMask, imageDirectory, job.year);
    const sidecar = await fsp.readFile(`${job.sourcePath}.json`, "utf8").then(JSON.parse).catch(() => null);
    years[job.year] = {
      year: job.year,
      acquisitionDate: job.selectedDate,
      acquisitionTime: sidecar?.acquisitionTime ?? job.selected?.products?.[0]?.datetime ?? `${job.selectedDate}T00:00:00Z`,
      imageUrl: output.variants.all,
      rasterVariants: output.variants,
      width: raster.grid.width,
      height: raster.grid.height,
      crs: "EPSG:32631",
      pixelSizeMeters: 10,
      coordinates: browserCoordinates(raster.grid),
      threshold: calibration.threshold,
      calibration,
      quality: {
        status: job.qualityStatus,
        targetDate: job.targetDate,
        dayOffset: job.dayOffset,
        cloudAffectedPercentage: job.selected.cloudAffectedPercentage,
        coveragePercentage: job.selected.coveragePercentage,
        validObservationPercentage: sidecar?.validation?.validPercentage ?? null,
      },
      products: sidecar?.products ?? job.selected.products,
      sourceSha256: sidecar?.responseSha256 ?? await hashFile(job.sourcePath),
      outputImageSha256: output.hash,
      sectorStats,
    };
  }

  const generatedAt = new Date().toISOString();
  const availableYears = jobs.map((job) => job.year);
  const manifest = {
    schemaVersion: 2,
    generatedAt,
    available: true,
    activeYear: Math.max(...availableYears),
    availableYears,
    opacity: 0.68,
    palette: { ...VEGETATION_PALETTE, excludedNoObservation: "transparent" },
    definitions: {
      calibrationYear: CALIBRATION_YEAR,
      frozenThreshold: calibration.threshold,
      calibrationPositiveCodes: VEGETATION_POSITIVE_CODES,
      calibrationNegativeCodes: VEGETATION_NEGATIVE_CODES,
      excludedLandCoverCodes: VEGETATION_EXCLUDED_LAND_COVER_CODES,
      excludedUrbanAtlasCodes: VEGETATION_EXCLUDED_URBAN_ATLAS_CODES,
      maskedSclCodes: VEGETATION_MASKED_SCL_CODES,
      headlineDenominator: "complete-valid-sentinel-2-sector-area",
      classification: "NDVI at or above the frozen 2023 threshold is likely vegetated. LCM-10 2020 cropland and Urban Atlas water are excluded from display but retained in the denominator.",
    },
    years,
    source: {
      collection: "sentinel-2-l2a",
      inputBands: ["B04", "B08", "SCL", "dataMask"],
      productUrl: "https://dataspace.copernicus.eu/explore-data/data-collections/sentinel-data/sentinel-2",
      processApiDocumentationUrl: "https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html",
      attribution: "Derived using European Union Copernicus Sentinel-2 information.",
    },
    calibrationSource: {
      dataset: urbanAtlasManifest.source.dataset,
      referenceYear: 2021,
      productId: urbanAtlasManifest.source.productId,
      doi: urbanAtlasManifest.source.doi,
      caveat: "Urban Atlas represents 2021 while the frozen calibration observation is from 2023. Changed areas and polygon generalisation can affect calibration.",
    },
    exclusionSource: {
      dataset: cropland.source.dataset,
      referenceYear: 2020,
      classCode: cropland.classCode,
      caveat: "The same LCM-10 2020 cropland mask is applied to every observation year for temporal consistency.",
    },
    processing: {
      generatedAt,
      sectorCount: 154,
      selectionManifestSha256: await hashFile(options.selectionPath),
      subpixelSampling: "3 x 3; calibration requires at least 8 of 9 samples in one reference class.",
      nearestNeighbour: true,
    },
  };
  await fsp.writeFile(path.join(options.outputDir, "vegetation.json"), JSON.stringify(manifest, null, 2));
  console.log(`Klaar: ${availableYears.length} jaren, ${availableYears[0]} tot ${availableYears.at(-1)}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
