/**
 * Convert cached annual Sentinel-2 NDVI observations into Greenwave's static
 * vegetation layer. Annual calibration and reference masks stay in this
 * preparation boundary; the browser receives green-only PNGs and statistics.
 */
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
  VEGETATION_CROPLAND_OVERRIDE_URBAN_ATLAS_CODES,
  VEGETATION_EXCLUDED_LAND_COVER_CODES,
  VEGETATION_EXCLUDED_URBAN_ATLAS_CODES,
  VEGETATION_GRASSLAND_EXCLUSION_URBAN_ATLAS_CODES,
  VEGETATION_GRASSLAND_LAND_COVER_CODES,
  VEGETATION_MASKED_SCL_CODES,
  VEGETATION_NEGATIVE_CODES,
  VEGETATION_PALETTE,
  VEGETATION_POSITIVE_CODES,
  calibrateNdviThreshold,
  rasterizeProjectedFeatures,
  roundMetric,
  vegetationExclusionReason,
} from "./lib/vegetation-core.mjs";
import { multiPolygonAreaSquareMeters, projectMultiPolygon, toMultiPolygonCoordinates } from "./lib/urban-atlas-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DATA = path.join(PROJECT_ROOT, "public", "data");
const CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "vegetation");
const EPSG_32631 = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs";
const SUBPIXEL_SCALE = 3;
const SUBPIXEL_AREA = 100 / (SUBPIXEL_SCALE ** 2);
const NDVI_BIN_COUNT = 2001;
const PUBLISHED_YEARS = Object.freeze([2020]);

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

async function createAgriculturalLandCoverMask(grid, manifestPath) {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const imagePath = path.resolve(path.dirname(manifestPath), "..", manifest.raster.imageUrl);
  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [[minimumLongitude, minimumLatitude], [maximumLongitude, maximumLatitude]] = manifest.raster.bounds;
  const requiredClasses = new Map([
    [30, "#ffff4c"],
    [40, "#f096ff"],
  ]);
  const colorToCode = new Map();
  for (const [code, expectedColor] of requiredClasses) {
    const definition = manifest.classes.find((entry) => Number(entry.code) === code);
    if (!definition || definition.color.toLowerCase() !== expectedColor) {
      throw new Error(`LCM-10-klasse ${code} of haar officiële kleur ontbreekt.`);
    }
    colorToCode.set(Number.parseInt(definition.color.slice(1), 16), code);
  }
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
      if (data[offset + 3] === 0) continue;
      const color = data[offset] << 16 | data[offset + 1] << 8 | data[offset + 2];
      mask[row * grid.width + column] = colorToCode.get(color) ?? 0;
    }
  }
  return { mask, source: manifest.source, classCodes: [...requiredClasses.keys()] };
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

function buildStatistics(raster, sectorRaster, urbanAtlasRaster, classCodes, sectorFeatures, agriculturalMask, threshold) {
  const accumulators = sectorFeatures.map(() => ({
    total: 0, valid: 0, likely: 0, below: 0, cropland: 0, water: 0, missing: 0,
    ndviCount: 0, histogram: new Uint32Array(NDVI_BIN_COUNT),
  }));
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
          const urbanAtlasIndex = urbanAtlasRaster.data[subpixel];
          const exclusion = vegetationExclusionReason({
            landCoverCode: agriculturalMask[pixel],
            urbanAtlasCode: classCodes[urbanAtlasIndex],
          });
          if (exclusion === "water") stats.water += SUBPIXEL_AREA;
          else if (exclusion === "cropland") stats.cropland += SUBPIXEL_AREA;
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
    const shareOfSector = (value) => stats.total ? roundMetric(value / stats.total * 100, 2) : 0;
    const reconciled = stats.likely + stats.below + stats.cropland + stats.water;
    if (Math.abs(reconciled - stats.valid) > 0.01) throw new Error(`Oppervlakten sluiten niet aan voor ${feature.properties.sectorId}.`);
    return [feature.properties.sectorId, {
      sectorAreaHa: area(stats.total),
      validAreaHa: area(stats.valid),
      likelyVegetatedAreaHa: area(stats.likely),
      likelyVegetatedPercentage: shareOfSector(stats.likely),
      belowThresholdAreaHa: area(stats.below),
      belowThresholdPercentage: shareOfSector(stats.below),
      excludedCroplandAreaHa: area(stats.cropland),
      excludedCroplandPercentage: shareOfSector(stats.cropland),
      excludedWaterAreaHa: area(stats.water),
      excludedWaterPercentage: shareOfSector(stats.water),
      missingObservationAreaHa: area(stats.missing),
      medianNdvi: histogramMedian(stats.histogram, stats.ndviCount),
    }];
  }));
}

function createRgba(raster, sectorRaster, urbanAtlasRaster, classCodes, agriculturalMask, threshold) {
  const output = Buffer.alloc(raster.grid.width * raster.grid.height * 4);
  const sectorCounts = new Uint8Array(155);
  const classCounts = new Uint8Array(classCodes.length);
  const likely = Buffer.from(VEGETATION_PALETTE.likelyVegetated.slice(1), "hex");
  for (let row = 0; row < raster.grid.height; row += 1) {
    for (let column = 0; column < raster.grid.width; column += 1) {
      const pixel = row * raster.grid.width + column;
      if (raster.validity[pixel] < 0.5) continue;
      const [, sectorVotes] = dominantSubpixelValue(sectorRaster, column, row, sectorCounts);
      if (sectorVotes < 5) continue;
      const [classIndex] = dominantSubpixelValue(urbanAtlasRaster, column, row, classCounts);
      if (vegetationExclusionReason({
        landCoverCode: agriculturalMask[pixel],
        urbanAtlasCode: classCodes[classIndex],
      })) continue;
      if (raster.ndvi[pixel] < threshold) continue;
      const offset = pixel * 4;
      output[offset] = likely[0]; output[offset + 1] = likely[1]; output[offset + 2] = likely[2]; output[offset + 3] = 255;
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

function agriculturalOverlapSummary(agriculturalMask, sectorRaster, urbanAtlasRaster, classCodes, grid) {
  const sectorCounts = new Uint8Array(155);
  const classCounts = new Uint8Array(classCodes.length);
  let croplandPasturePixels = 0;
  let grasslandArablePixels = 0;
  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const pixel = row * grid.width + column;
      const landCoverCode = agriculturalMask[pixel];
      if (!landCoverCode) continue;
      const [, sectorVotes] = dominantSubpixelValue(sectorRaster, column, row, sectorCounts);
      if (sectorVotes < 5) continue;
      const [classIndex] = dominantSubpixelValue(urbanAtlasRaster, column, row, classCounts);
      const urbanAtlasCode = classCodes[classIndex];
      if (landCoverCode === 40 && urbanAtlasCode === "23000") croplandPasturePixels += 1;
      if (landCoverCode === 30 && urbanAtlasCode === "21000") grasslandArablePixels += 1;
    }
  }
  return {
    pixelAreaHa: 0.01,
    croplandPasturePixels,
    croplandPastureAreaHa: roundMetric(croplandPasturePixels * 0.01),
    grasslandArablePixels,
    grasslandArableAreaHa: roundMetric(grasslandArablePixels * 0.01),
  };
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

async function removeUnpublishedBrowserRasters(directory, publishedYears) {
  const keep = new Set(publishedYears.map(Number));
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const match = /^likely-vegetation-(\d{4})(?:-[a-z0-9-]+)?\.png$/.exec(entry.name);
    if (entry.isFile() && match && !keep.has(Number(match[1]))) {
      await fsp.unlink(path.join(directory, entry.name));
    }
  }));
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
  if (sectors.features?.length !== 154 || !Object.keys(selection.years ?? {}).length) throw new Error("De sectoren of jaarselectie zijn onvolledig.");
  const jobs = Object.values(selection.years).filter((entry) => PUBLISHED_YEARS.includes(Number(entry.year))).map((entry) => ({
    ...entry,
    sourcePath: path.join(options.cacheDir, `sentinel-2-l2a-ndvi-validity-${entry.selectedDate}-epsg32631-10m.tif`),
  })).sort((left, right) => left.year - right.year);
  if (jobs.length !== PUBLISHED_YEARS.length) {
    throw new Error(`De jaarselectie bevat niet alle gepubliceerde jaren: ${PUBLISHED_YEARS.join(", ")}.`);
  }
  for (const job of jobs) if (!await fsp.stat(job.sourcePath).catch(() => null)) throw new Error(`Ontbrekend raster voor ${job.year}: ${job.sourcePath}`);

  const referenceJob = jobs[0];
  const referenceRaster = await readRaster(referenceJob.sourcePath);
  const sectorFeatures = sectors.features.map(projectedFeature);
  const urbanAtlasFeatures = urbanAtlas.features.map(projectedFeature);
  const classCodes = [null, ...urbanAtlasManifest.classes.map((entry) => String(entry.code))];
  const classIndex = new Map(classCodes.map((code, index) => [code, index]));
  console.log("Rasteriseer Statbel-sectoren en Urban Atlas één keer voor alle jaren...");
  const sectorRaster = rasterizeProjectedFeatures(sectorFeatures, referenceRaster.grid, (feature) => sectorFeatures.indexOf(feature) + 1, { scale: SUBPIXEL_SCALE, ArrayType: Uint16Array });
  const urbanAtlasRaster = rasterizeProjectedFeatures(urbanAtlasFeatures, referenceRaster.grid, (feature) => classIndex.get(String(feature.properties.classCode)) ?? 0, { scale: SUBPIXEL_SCALE, ArrayType: Uint8Array });
  console.log("Maak LCM-10-landbouwmasker voor klassen 30 en 40...");
  const agriculture = await createAgriculturalLandCoverMask(referenceRaster.grid, options.landCoverManifestPath);
  const municipalityMask = municipalityPixelMask(sectorRaster, sectorFeatures, referenceRaster.grid);
  const agriculturalOverlap = agriculturalOverlapSummary(
    agriculture.mask,
    sectorRaster,
    urbanAtlasRaster,
    classCodes,
    referenceRaster.grid,
  );
  const imageDirectory = path.join(options.outputDir, "vegetation");
  await fsp.mkdir(imageDirectory, { recursive: true });
  await removeUnpublishedBrowserRasters(imageDirectory, PUBLISHED_YEARS);

  const years = {};
  for (const job of jobs) {
    console.log(`Verwerk vegetatie-indicatie ${job.year} (${job.selectedDate})...`);
    const raster = job.year === referenceJob.year ? referenceRaster : await readRaster(job.sourcePath);
    if (!sameGrid(referenceRaster.grid, raster.grid)) throw new Error(`Rastergrid voor ${job.year} wijkt af van ${referenceJob.year}.`);
    const calibrationSamples = calibrationValues(raster, urbanAtlasRaster, classCodes);
    const calibration = calibrateNdviThreshold(calibrationSamples.positive, calibrationSamples.negative);
    console.log(`Drempel ${calibration.threshold.toFixed(3)}; AUC ${calibration.auc.toFixed(3)}.`);
    const sectorStats = buildStatistics(raster, sectorRaster, urbanAtlasRaster, classCodes, sectorFeatures, agriculture.mask, calibration.threshold);
    const rgba = createRgba(raster, sectorRaster, urbanAtlasRaster, classCodes, agriculture.mask, calibration.threshold);
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
    schemaVersion: 4,
    generatedAt,
    available: true,
    activeYear: Math.max(...availableYears),
    availableYears,
    opacity: 0.68,
    palette: { ...VEGETATION_PALETTE, excludedNoObservation: "transparent" },
    definitions: {
      thresholdMode: "annual-per-observation",
      calibrationPositiveCodes: VEGETATION_POSITIVE_CODES,
      calibrationNegativeCodes: VEGETATION_NEGATIVE_CODES,
      agriculturalExclusionRules: [
        {
          landCoverCode: VEGETATION_EXCLUDED_LAND_COVER_CODES[0],
          excludeUnlessUrbanAtlasCodes: VEGETATION_CROPLAND_OVERRIDE_URBAN_ATLAS_CODES,
        },
        {
          landCoverCode: VEGETATION_GRASSLAND_LAND_COVER_CODES[0],
          excludeWhenUrbanAtlasCodes: VEGETATION_GRASSLAND_EXCLUSION_URBAN_ATLAS_CODES,
        },
      ],
      excludedUrbanAtlasCodes: VEGETATION_EXCLUDED_URBAN_ATLAS_CODES,
      maskedSclCodes: VEGETATION_MASKED_SCL_CODES,
      headlineDenominator: "complete-statbel-sector-area",
      classification: "NDVI at or above the threshold calibrated for the observation is likely vegetated. The headline percentage divides likely-vegetated area by the complete Statbel sector area, including agricultural exclusions, water and missing observations. LCM-10 2020 cropland is excluded unless Urban Atlas 2021 classifies it as pasture. LCM-10 grassland is excluded where Urban Atlas classifies it as arable land. Urban Atlas water is also excluded.",
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
      caveat: "Urban Atlas represents 2021 and supplies the reference polygons used to calibrate the 2020 observation. Changed areas and polygon generalisation can affect calibration.",
    },
    exclusionSource: {
      dataset: agriculture.source.dataset,
      referenceYear: 2020,
      landCoverClassCodes: agriculture.classCodes,
      urbanAtlasDataset: urbanAtlasManifest.source.dataset,
      urbanAtlasReferenceYear: 2021,
      pastureOverrideClassCode: VEGETATION_CROPLAND_OVERRIDE_URBAN_ATLAS_CODES[0],
      arableExclusionClassCode: VEGETATION_GRASSLAND_EXCLUSION_URBAN_ATLAS_CODES[0],
      waterClassCode: VEGETATION_EXCLUDED_URBAN_ATLAS_CODES[0],
      caveat: "LCM-10 2020 and Urban Atlas 2021 provide fixed agricultural corrections for the published 2020 observation.",
    },
    processing: {
      generatedAt,
      sectorCount: 154,
      selectionManifestSha256: await hashFile(options.selectionPath),
      subpixelSampling: "3 x 3; calibration requires at least 8 of 9 samples in one reference class.",
      agriculturalOverlap,
      nearestNeighbour: true,
    },
  };
  await fsp.writeFile(path.join(options.outputDir, "vegetation.json"), JSON.stringify(manifest, null, 2));
  console.log(`Klaar: gepubliceerd opnamejaar ${availableYears.join(", ")}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
