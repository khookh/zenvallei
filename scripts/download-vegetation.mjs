/**
 * Download the selected Sentinel-2 L2A observations as preparation-only,
 * two-band NDVI/validity GeoTIFFs in the common EPSG:32631 10 m grid. OAuth
 * client credentials remain outside every cache sidecar and browser asset.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fromFile } from "geotiff";
import proj4 from "proj4";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SECTORS_PATH = path.join(PROJECT_ROOT, "public", "data", "sectors.geojson");
const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, ".cache", "vegetation");
const DEFAULT_DATE = "2023-06-24";
const DEFAULT_SELECTION_PATH = path.join(DEFAULT_CACHE_DIR, "selection.json");
const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";
const EPSG_32631 = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs";
const CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/32631";

export const VEGETATION_SOURCE = Object.freeze({
  date: DEFAULT_DATE,
  collection: "sentinel-2-l2a",
  acquisitionTime: "2023-06-24T10:46:21Z",
  products: Object.freeze([
    Object.freeze({
      id: "S2A_MSIL2A_20230624T104621_N0510_R051_T31UFS_20240912T071700",
      tile: "T31UFS",
      cloudCover: 0,
    }),
    Object.freeze({
      id: "S2A_MSIL2A_20230624T104621_N0510_R051_T31UES_20240912T071700",
      tile: "T31UES",
      cloudCover: 0.98,
    }),
  ]),
});

const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "SCL", "dataMask"],
      units: ["REFLECTANCE", "REFLECTANCE", "DN", "DN"]
    }],
    output: {
      id: "default",
      bands: 2,
      sampleType: "FLOAT32"
    }
  };
}

function evaluatePixel(sample) {
  var maskedScl = sample.SCL === 0 || sample.SCL === 1 || sample.SCL === 3
    || sample.SCL === 7 || sample.SCL === 8 || sample.SCL === 9
    || sample.SCL === 10 || sample.SCL === 11;
  var denominator = sample.B08 + sample.B04;
  if (sample.dataMask !== 1 || maskedScl || denominator === 0) return [0, 0];
  var ndvi = (sample.B08 - sample.B04) / denominator;
  if (!isFinite(ndvi) || ndvi < -1 || ndvi > 1) return [0, 0];
  return [ndvi, 1];
}`;

function parseArguments(argv) {
  const options = {
    date: DEFAULT_DATE,
    sectorsPath: DEFAULT_SECTORS_PATH,
    cacheDir: DEFAULT_CACHE_DIR,
    selectionPath: DEFAULT_SELECTION_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    switch (argv[index]) {
      case "--date": options.date = next; index += 1; break;
      case "--year": options.year = Number(next); index += 1; break;
      case "--all": options.all = true; break;
      case "--selection": options.selectionPath = path.resolve(next); index += 1; break;
      case "--sectors": options.sectorsPath = path.resolve(next); index += 1; break;
      case "--cache": options.cacheDir = path.resolve(next); index += 1; break;
      case "--force": options.force = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Gebruik: pnpm vegetation:download -- [opties]\n\n` +
    `  --all                Download alle geselecteerde jaren\n` +
    `  --year <JJJJ>        Download een geselecteerd jaar\n` +
    `  --date <JJJJ-MM-DD>  Download een expliciete datum\n` +
    `  --selection <pad>    Jaarselectie van vegetation:discover\n` +
    `  --sectors <pad>      GeoJSON met de 154 Statbel-sectoren\n` +
    `  --cache <map>        Lokale cachemap\n` +
    `  --force              Download een bestaande geldige cache opnieuw\n\n` +
    `Vereiste tijdelijke omgevingsvariabelen:\n` +
    `  CDSE_SH_CLIENT_ID\n` +
    `  CDSE_SH_CLIENT_SECRET`);
}

function visitCoordinates(coordinates, visitor) {
  if (typeof coordinates?.[0] === "number") visitor(coordinates);
  else for (const child of coordinates ?? []) visitCoordinates(child, visitor);
}

function createGrid(sectors) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of sectors.features) {
    visitCoordinates(feature.geometry.coordinates, (coordinate) => {
      const [x, y] = proj4("EPSG:4326", EPSG_32631, coordinate);
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
    });
  }
  const bbox = [
    Math.floor(bounds[0] / 10) * 10,
    Math.floor(bounds[1] / 10) * 10,
    Math.ceil(bounds[2] / 10) * 10,
    Math.ceil(bounds[3] / 10) * 10,
  ];
  return {
    bbox,
    width: Math.round((bbox[2] - bbox[0]) / 10),
    height: Math.round((bbox[3] - bbox[1]) / 10),
  };
}

function buildRequest(date, grid) {
  return {
    input: {
      bounds: {
        bbox: grid.bbox,
        properties: { crs: CRS_URI },
      },
      data: [{
        type: VEGETATION_SOURCE.collection,
        dataFilter: {
          timeRange: {
            from: `${date}T00:00:00Z`,
            to: `${date}T23:59:59Z`,
          },
          mosaickingOrder: "leastCC",
          maxCloudCoverage: 100,
        },
        processing: {
          harmonizeValues: true,
          upsampling: "NEAREST",
          downsampling: "NEAREST",
        },
      }],
    },
    output: {
      width: grid.width,
      height: grid.height,
      responses: [{ identifier: "default", format: { type: "image/tiff" } }],
    },
    evalscript: EVALSCRIPT,
  };
}

async function obtainAccessToken() {
  const clientId = process.env.CDSE_SH_CLIENT_ID?.trim();
  const clientSecret = process.env.CDSE_SH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("CDSE_SH_CLIENT_ID of CDSE_SH_CLIENT_SECRET ontbreekt. Maak eerst een Sentinel Hub OAuth-client en stel beide tijdelijke omgevingsvariabelen in.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Sentinel Hub-authenticatie mislukt: HTTP ${response.status}. ${detail}`);
  }
  const result = await response.json();
  if (!result.access_token) throw new Error("Sentinel Hub gaf geen toegangstoken terug.");
  return result.access_token;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function validateGeoTiff(filePath, grid) {
  const handle = await fsp.open(filePath, "r");
  try {
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    const isTiff = signature.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || signature.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
    if (!isTiff) throw new Error("Het antwoord is geen geldig TIFF-bestand. Controleer de Process API-foutmelding en uw Sentinel Hub-abonnement.");
  } finally {
    await handle.close();
  }

  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const geoKeys = image.getGeoKeys();
  if (geoKeys.ProjectedCSTypeGeoKey !== 32631) {
    throw new Error(`Onverwacht CRS in het GeoTIFF: ${geoKeys.ProjectedCSTypeGeoKey ?? "onbekend"}; verwacht EPSG:32631.`);
  }
  if (image.getWidth() !== grid.width || image.getHeight() !== grid.height) {
    throw new Error(`Onverwachte rasterafmetingen: ${image.getWidth()} x ${image.getHeight()}; verwacht ${grid.width} x ${grid.height}.`);
  }
  if (image.getSamplesPerPixel() !== 2) {
    throw new Error(`Het GeoTIFF bevat ${image.getSamplesPerPixel()} banden; verwacht NDVI en geldigheid.`);
  }
  const resolution = image.getResolution();
  if (Math.abs(Math.abs(resolution[0]) - 10) > 0.01 || Math.abs(Math.abs(resolution[1]) - 10) > 0.01) {
    throw new Error(`Onverwachte rasterresolutie: ${resolution.join(", ")}; verwacht 10 meter.`);
  }
  const [ndvi, validity] = await image.readRasters({ samples: [0, 1], interleave: false });
  let validPixelCount = 0;
  let minimumNdvi = Infinity;
  let maximumNdvi = -Infinity;
  for (let index = 0; index < validity.length; index += 1) {
    if (validity[index] < 0.5) continue;
    const value = ndvi[index];
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      throw new Error(`Ongeldige NDVI-waarde in het GeoTIFF: ${value}.`);
    }
    validPixelCount += 1;
    minimumNdvi = Math.min(minimumNdvi, value);
    maximumNdvi = Math.max(maximumNdvi, value);
  }
  const validPercentage = validPixelCount / validity.length * 100;
  if (validPercentage < 50) {
    throw new Error(`Het GeoTIFF bevat slechts ${validPercentage.toFixed(2)}% geldige observaties. De Sentinel-scène is leeg of onvolledig.`);
  }
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    samplesPerPixel: image.getSamplesPerPixel(),
    crs: "EPSG:32631",
    pixelSize: 10,
    validPixelCount,
    validPercentage: Number(validPercentage.toFixed(4)),
    ndviRange: [minimumNdvi, maximumNdvi],
  };
}

async function downloadRaster(request, destination) {
  const token = await obtainAccessToken();
  const response = await fetch(PROCESS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "image/tiff",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`Sentinel Hub Process API-download mislukt: HTTP ${response.status}. ${detail}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("tiff") && !contentType.toLowerCase().includes("octet-stream")) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`Sentinel Hub gaf ${contentType || "een onbekend formaat"} terug in plaats van GeoTIFF. ${detail}`);
  }
  const temporaryPath = `${destination}.partial`;
  await fsp.rm(temporaryPath, { force: true });
  await pipeline(response.body, fs.createWriteStream(temporaryPath));
  await fsp.rename(temporaryPath, destination);
}

async function prepareJob(job, options, grid) {
  const request = buildRequest(job.date, grid);
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const filename = `sentinel-2-l2a-ndvi-validity-${job.date}-epsg32631-10m.tif`;
  const destination = path.join(options.cacheDir, filename);
  const metadataPath = `${destination}.json`;
  const cached = !options.force && await fsp.stat(destination).catch(() => null);
  let validation = null;
  if (cached) {
    try {
      validation = await validateGeoTiff(destination, grid);
      console.log(`Geldige cache gevonden: ${destination}`);
    } catch (error) {
      console.warn(`Ongeldige cache wordt vervangen: ${error.message}`);
      await fsp.rm(destination, { force: true });
      await fsp.rm(metadataPath, { force: true });
    }
  }
  if (!validation) {
    console.log(`Download Sentinel-2 L2A NDVI voor ${job.year} (${job.date}) op ${grid.width} x ${grid.height} pixels...`);
    try {
      await downloadRaster(request, destination);
      validation = await validateGeoTiff(destination, grid);
    } catch (error) {
      await fsp.rm(destination, { force: true });
      throw error;
    }
  }

  const stats = await fsp.stat(destination);
  const metadata = {
    schemaVersion: 1,
    downloadedAt: new Date().toISOString(),
    year: job.year,
    date: job.date,
    acquisitionTime: job.selection?.selected?.products?.[0]?.datetime ?? `${job.date}T00:00:00Z`,
    collection: VEGETATION_SOURCE.collection,
    products: job.selection?.selected?.products ?? (job.date === DEFAULT_DATE ? VEGETATION_SOURCE.products : []),
    cloudQuality: job.selection ? {
      status: job.selection.qualityStatus,
      targetDate: job.selection.targetDate,
      dayOffset: job.selection.dayOffset,
      cloudAffectedPercentage: job.selection.selected.cloudAffectedPercentage,
      coveragePercentage: job.selection.selected.coveragePercentage,
    } : null,
    requestHash,
    responseSha256: await sha256File(destination),
    byteLength: stats.size,
    grid: { ...grid, crs: "EPSG:32631", pixelSize: 10 },
    bands: ["ndvi", "validity"],
    inputBands: ["B04", "B08", "SCL", "dataMask"],
    maskedSclCodes: [0, 1, 3, 7, 8, 9, 10, 11],
    processApiUrl: PROCESS_URL,
    validation,
  };
  await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`Klaar: ${destination}`);
  console.log(`Geldige observaties: ${validation.validPercentage.toFixed(2)}%; NDVI-bereik: ${validation.ndviRange[0].toFixed(3)} tot ${validation.ndviRange[1].toFixed(3)}.`);
  console.log(`SHA-256: ${metadata.responseSha256}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const sectors = JSON.parse(await fsp.readFile(options.sectorsPath, "utf8"));
  if (sectors.features?.length !== 154) {
    throw new Error(`De sectorbron bevat ${sectors.features?.length ?? 0} sectoren; verwacht 154.`);
  }
  const selection = await fsp.readFile(options.selectionPath, "utf8").then(JSON.parse).catch(() => null);
  let jobs;
  if (options.all) {
    if (!selection?.years) throw new Error("Voer eerst pnpm vegetation:discover uit.");
    jobs = Object.values(selection.years).map((entry) => ({
      year: Number(entry.year), date: entry.selectedDate, selection: entry,
    })).sort((left, right) => left.year - right.year);
  } else if (options.year) {
    const entry = selection?.years?.[options.year];
    if (!entry) throw new Error(`Geen geselecteerde Sentinel-opname voor ${options.year}.`);
    jobs = [{ year: options.year, date: entry.selectedDate, selection: entry }];
  } else {
    jobs = [{ year: Number(options.date.slice(0, 4)), date: options.date, selection: null }];
  }
  const grid = createGrid(sectors);
  await fsp.mkdir(options.cacheDir, { recursive: true });
  for (const job of jobs) await prepareJob(job, options, grid);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
