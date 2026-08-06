/**
 * Clip the official BE001L3 Urban Atlas product to Statbel sectors and compute
 * hectare totals in equal-area EPSG:3035. Geometry repairs are intentionally
 * contained here so the browser receives simple validated WGS84 fragments.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { geojson as flatGeobuf } from "flatgeobuf";
import polygonClipping from "polygon-clipping";
import proj4 from "proj4";
import unzipper from "unzipper";
import {
  ARTIFICIAL_CODES,
  CLASS_BY_CODE,
  GREEN_CODES,
  NO_DATA_CODES,
  boundsIntersect,
  buildClassManifest,
  buildSectorStatistics,
  indexMultiPolygonRings,
  indexedMultiPolygonBounds,
  multiPolygonAreaSquareMeters,
  multiPolygonBounds,
  parseUrbanAtlasStyle,
  projectMultiPolygon,
  subsetIndexedMultiPolygon,
  toMultiPolygonCoordinates,
  validateOfficialStyle,
} from "./lib/urban-atlas-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "public", "data");
const DEFAULT_CACHE = path.join(PROJECT_ROOT, ".cache", "urban-atlas");
const DOWNLOAD_ROOT = "https://download.dataspace.copernicus.eu/odata/v1/Products";
const CATALOGUE_ROOT = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products";
const STYLE_URL = "https://mapserver.dataspace.copernicus.eu/ogc?service=WMS&version=1.3.0&request=GetStyles&layers=UA_LCU_2021_VECTOR";
const PRODUCT_PAGE_URL = "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021";
const CATALOGUE_URL = "https://csv.dataspace.copernicus.eu/CLMS/land_cover_use_in_priority_areas/urban_atlas/clms_ua_land-cover-land-use_europe_V025ha_3yearly_v1/";
const EPSG_3035 = "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +datum=WGS84 +units=m +no_defs +type=crs";
const MAX_DOWNLOAD_REDIRECTS = 8;

export const URBAN_ATLAS_ARTIFACTS = Object.freeze([
  Object.freeze({
    key: "odata-2026-07-22",
    byteLength: 178_900_771,
    md5: "eae385ced547b8fab079e33fa81e03fd",
    modificationDate: "2026-07-22T21:48:38.905590Z",
    authority: "CDSE OData product metadata",
  }),
  Object.freeze({
    key: "csv-2026-03-26",
    byteLength: 178_900_904,
    md5: "88ad99ffdf56d86755519771501fb059",
    modificationDate: "2026-03-26T08:27:43.362Z",
    authority: "Official CDSE CLMS catalogue CSV snapshot",
  }),
]);

export const URBAN_ATLAS_SOURCE = Object.freeze({
  dataset: "clms_ua_land-cover-land-use_europe_V025ha_3yearly_v1",
  fuaCode: "BE001L3",
  fuaName: "Bruxelles/Brussel/Leuven",
  year: 2021,
  productName: "CLMS_UA_LCU_S2021_V025ha_BE001L3_BRUXELLES_BRUSSEL_LEUVEN_03035_V01_R01_20250730",
  productId: "cb6a69ee-dbd7-41ec-bc35-d705d5d71b33",
  expectedBytes: URBAN_ATLAS_ARTIFACTS[0].byteLength,
  expectedMd5: URBAN_ATLAS_ARTIFACTS[0].md5,
  productModificationDate: URBAN_ATLAS_ARTIFACTS[0].modificationDate,
  doi: "https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a",
  crs: "EPSG:3035",
  contentType: "application/flatgeobuf",
  productUrl: PRODUCT_PAGE_URL,
  catalogueUrl: CATALOGUE_URL,
  bboxWgs84: [3.64, 50.49, 5.25, 51.06],
});

function parseArguments(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT,
    cacheDir: DEFAULT_CACHE,
    sectorsPath: path.join(DEFAULT_OUTPUT, "sectors.geojson"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1];
    switch (argv[index]) {
      case "--source": options.sourcePath = path.resolve(next); index += 1; break;
      case "--style": options.stylePath = path.resolve(next); index += 1; break;
      case "--sectors": options.sectorsPath = path.resolve(next); index += 1; break;
      case "--cache": options.cacheDir = path.resolve(next); index += 1; break;
      case "--output": options.outputDir = path.resolve(next); index += 1; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Gebruik: pnpm urban-atlas:prepare -- [opties]\n\n` +
    `  --source <pad>   Officieel FlatGeobuf-bestand of CDSE-archief\n` +
    `  --style <pad>    Reeds gedownloade offici\u00eble GetStyles-SLD\n` +
    `  --sectors <pad>  Zennevallei-sectoren in WGS84 GeoJSON\n` +
    `  --cache <map>    Downloadcache\n` +
    `  --output <map>   Uitvoermap\n\n` +
    `Zonder --source downloadt het script het gepinde product met CDSE_ACCESS_TOKEN.`);
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function validateSourceFile(filePath) {
  const [fileStats, md5, sha256] = await Promise.all([
    fsp.stat(filePath),
    hashFile(filePath, "md5"),
    hashFile(filePath, "sha256"),
  ]);
  const artifact = URBAN_ATLAS_ARTIFACTS.find((candidate) => candidate.byteLength === fileStats.size
    && candidate.md5 === md5.toLowerCase());
  if (!artifact) {
    const accepted = URBAN_ATLAS_ARTIFACTS
      .map(({ byteLength, md5: expectedMd5 }) => `${byteLength} bytes / MD5 ${expectedMd5}`)
      .join(" of ");
    throw new Error(`Urban Atlas-productidentiteit wijkt af: ontvangen ${fileStats.size} bytes / MD5 ${md5}; verwacht ${accepted}.`);
  }
  return {
    artifactKey: artifact.key,
    artifactAuthority: artifact.authority,
    artifactModificationDate: artifact.modificationDate,
    byteLength: fileStats.size,
    md5,
    sha256,
  };
}

async function validateRemoteProductMetadata() {
  const url = `${CATALOGUE_ROOT}(${URBAN_ATLAS_SOURCE.productId})?$select=Id,Name,ContentLength,Online,ModificationDate,Checksum`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Actuele CDSE-productmetadata kon niet worden gecontroleerd: HTTP ${response.status}.`);
  const metadata = await response.json();
  const md5 = metadata.Checksum?.find(({ Algorithm }) => Algorithm?.toUpperCase() === "MD5")?.Value?.toLowerCase();
  const artifact = URBAN_ATLAS_ARTIFACTS.find((candidate) => candidate.byteLength === metadata.ContentLength
    && candidate.md5 === md5);
  if (metadata.Id !== URBAN_ATLAS_SOURCE.productId
    || metadata.Name !== URBAN_ATLAS_SOURCE.productName
    || metadata.Online !== true
    || !artifact) {
    throw new Error(`CDSE-productmetadata is sinds de laatste geverifieerde pin gewijzigd (${metadata.ContentLength ?? "?"} bytes / MD5 ${md5 ?? "onbekend"}). Controleer de officiële catalogus voordat je de nieuwe bron accepteert.`);
  }
  return metadata;
}

function bareAccessToken(token) {
  return token.trim().replace(/^Bearer\s+/i, "");
}

export function readAccessTokenClaims(token) {
  const encodedPayload = bareAccessToken(token).split(".")[1];
  if (!encodedPayload) return null;
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function assertAccessTokenIsFresh(token, nowMilliseconds = Date.now()) {
  const normalized = bareAccessToken(token);
  if (!normalized) throw new Error("CDSE_ACCESS_TOKEN is leeg.");
  const claims = readAccessTokenClaims(normalized);
  if (Number.isFinite(claims?.exp) && claims.exp * 1_000 <= nowMilliseconds + 15_000) {
    const expiredAt = new Date(claims.exp * 1_000).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" });
    throw new Error(`CDSE_ACCESS_TOKEN is verlopen (vervaltijd: ${expiredAt}). Vraag een nieuw cdse-public-token aan en voer de opdracht meteen opnieuw uit.`);
  }
  return normalized;
}

function isTrustedCdseUrl(url) {
  const parsed = new URL(url);
  return parsed.protocol === "https:"
    && (parsed.hostname === "dataspace.copernicus.eu" || parsed.hostname.endsWith(".dataspace.copernicus.eu"));
}

export async function fetchCdseDownload(url, token, fetchImplementation = fetch) {
  const normalized = assertAccessTokenIsFresh(token);
  let currentUrl = new URL(url);
  if (!isTrustedCdseUrl(currentUrl)) throw new Error(`Onbetrouwbare CDSE-download-URL: ${currentUrl.hostname}.`);

  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const response = await fetchImplementation(currentUrl, {
      headers: isTrustedCdseUrl(currentUrl) ? { Authorization: `Bearer ${normalized}` } : {},
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error(`CDSE-downloadredirect ${response.status} bevat geen Location-header.`);
    currentUrl = new URL(location, currentUrl);
    if (currentUrl.protocol !== "https:") throw new Error("CDSE-download probeerde onveilig naar een niet-HTTPS-adres om te leiden.");
  }
  throw new Error(`CDSE-download bevat meer dan ${MAX_DOWNLOAD_REDIRECTS} redirects.`);
}

async function downloadError(response) {
  if (response.status === 401) {
    return new Error("Urban Atlas-download geweigerd (HTTP 401). Het access token is verlopen, is niet door client 'cdse-public' uitgegeven, of wordt door CDSE niet voor OData-downloads aanvaard. Vraag een nieuw token aan en start de download binnen 30 minuten.");
  }
  if (response.status === 403) {
    return new Error("Urban Atlas-download geweigerd (HTTP 403). Het token is geldig, maar het CDSE-account heeft geen toegang tot dit product.");
  }
  const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`Urban Atlas-download mislukt: HTTP ${response.status}${detail ? ` (${detail})` : ""}.`);
}

async function downloadProduct(destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (await fsp.stat(destination).catch(() => null)) {
    try {
      await validateSourceFile(destination);
      console.log("Gebruik geverifieerde Urban Atlas-download uit de lokale cache.");
      return destination;
    } catch {
      await fsp.rm(destination, { force: true });
    }
  }
  const token = process.env.CDSE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("CDSE_ACCESS_TOKEN ontbreekt en er is geen geverifieerde cache. Stel een tijdelijk token in of gebruik --source.");
  }
  await validateRemoteProductMetadata();
  const response = await fetchCdseDownload(`${DOWNLOAD_ROOT}(${URBAN_ATLAS_SOURCE.productId})/$value`, token);
  if (!response.ok || !response.body) throw await downloadError(response);
  const temporaryPath = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath));
  try {
    await validateSourceFile(temporaryPath);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true });
    throw error;
  }
  await fsp.rename(temporaryPath, destination);
  return destination;
}

async function detectContainer(filePath) {
  const signature = Buffer.alloc(8);
  const handle = await fsp.open(filePath, "r");
  try {
    await handle.read(signature, 0, signature.length, 0);
  } finally {
    await handle.close();
  }
  if (signature.subarray(0, 3).equals(Buffer.from([0x66, 0x67, 0x62]))) return "flatgeobuf";
  if (signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  return "unknown";
}

async function findFlatGeobuf(inputPath, extractionRoot) {
  const stat = await fsp.stat(inputPath);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(inputPath, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = await findFlatGeobuf(path.join(inputPath, entry.name), extractionRoot).catch(() => null);
      if (candidate) return candidate;
    }
    throw new Error(`Geen FlatGeobuf gevonden in ${inputPath}.`);
  }
  const container = await detectContainer(inputPath);
  if (container === "flatgeobuf") return inputPath;
  if (container !== "zip") throw new Error(`Onbekend Urban Atlas-bestandsformaat: ${inputPath}.`);
  await fsp.rm(extractionRoot, { recursive: true, force: true });
  await fsp.mkdir(extractionRoot, { recursive: true });
  await fs.createReadStream(inputPath).pipe(unzipper.Extract({ path: extractionRoot })).promise();
  return findFlatGeobuf(extractionRoot, extractionRoot);
}

async function fetchCachedText(url, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await fsp.writeFile(destination, text, "utf8");
    return text;
  } catch (error) {
    const cached = await fsp.readFile(destination, "utf8").catch(() => null);
    if (cached) return cached;
    throw new Error(`Offici\u00eble Urban Atlas-stijl kon niet worden opgehaald (${error.message}).`);
  }
}

function propertyValue(properties, expectedName) {
  const key = Object.keys(properties ?? {}).find((candidate) => candidate.toLowerCase() === expectedName.toLowerCase());
  return key ? properties[key] : undefined;
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring.at(-1);
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function normalizedIntersection(result) {
  return result
    .map((polygon) => polygon.map(closeRing).filter((ring) => ring.length >= 4))
    .filter((polygon) => polygon.length && polygon[0].length >= 4);
}

function addArea(areaBySectorAndClass, sectorId, code, areaSquareMeters) {
  if (!areaBySectorAndClass.has(sectorId)) areaBySectorAndClass.set(sectorId, new Map());
  const areaByClass = areaBySectorAndClass.get(sectorId);
  areaByClass.set(code, (areaByClass.get(code) ?? 0) + areaSquareMeters);
}

async function readValidationStatus() {
  try {
    const response = await fetch(PRODUCT_PAGE_URL);
    if (!response.ok) return "unknown";
    const html = await response.text();
    return /Validation status[\s\S]{0,1000}Not yet validated/i.test(html) ? "not-yet-validated" : "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const generatedAt = new Date().toISOString();
  const sectors = JSON.parse(await fsp.readFile(options.sectorsPath, "utf8"));
  if (sectors.features?.length !== 154) throw new Error("De sectorgeometrie bevat niet exact 154 Zennevallei-sectoren.");
  const sectorIds = sectors.features.map((feature) => feature.properties?.sectorId);
  if (sectorIds.some((sectorId) => !sectorId) || new Set(sectorIds).size !== 154) {
    throw new Error("Elke Zennevallei-sector moet een unieke sectorId hebben.");
  }

  const productPath = options.sourcePath ?? path.join(options.cacheDir, `${URBAN_ATLAS_SOURCE.productName}.fgb`);
  if (!options.sourcePath) await downloadProduct(productPath);
  const sourceHashes = await validateSourceFile(productPath);
  const flatGeobufPath = await findFlatGeobuf(productPath, path.join(options.cacheDir, URBAN_ATLAS_SOURCE.productName));

  const stylePath = options.stylePath ?? path.join(options.cacheDir, "UA_LCU_2021_VECTOR.sld");
  const styleText = options.stylePath
    ? await fsp.readFile(options.stylePath, "utf8")
    : await fetchCachedText(STYLE_URL, stylePath);
  const styleEntries = parseUrbanAtlasStyle(styleText);
  validateOfficialStyle(styleEntries);
  const styleSha256 = createHash("sha256").update(styleText).digest("hex");

  const forward = (coordinate) => proj4("EPSG:4326", EPSG_3035, coordinate);
  const inverse = (coordinate) => proj4(EPSG_3035, "EPSG:4326", coordinate);
  const projectedSectors = sectors.features.map((feature) => {
    const multiPolygon = projectMultiPolygon(toMultiPolygonCoordinates(feature.geometry), forward);
    return {
      sectorId: feature.properties.sectorId,
      municipality: feature.properties.municipality,
      multiPolygon,
      bounds: multiPolygonBounds(multiPolygon),
      areaSquareMeters: multiPolygonAreaSquareMeters(multiPolygon),
    };
  });
  const sectorAreas = new Map(projectedSectors.map((sector) => [sector.sectorId, sector.areaSquareMeters]));
  const zennevalleiBounds = projectedSectors.reduce((aggregate, sector) => [
    Math.min(aggregate[0], sector.bounds[0]),
    Math.min(aggregate[1], sector.bounds[1]),
    Math.max(aggregate[2], sector.bounds[2]),
    Math.max(aggregate[3], sector.bounds[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);

  const outputFeatures = [];
  const presentCodes = new Set();
  const areaBySectorAndClass = new Map();
  let headerMetadata = null;
  let sourceFeatureCount = 0;
  let candidateFeatureCount = 0;
  console.log("Snijd Urban Atlas 2021 met de 154 Zennevallei-sectoren\u2026");
  const sourceStream = Readable.toWeb(fs.createReadStream(flatGeobufPath));
  for await (const feature of flatGeobuf.deserialize(sourceStream, undefined, (metadata) => { headerMetadata = metadata; })) {
    sourceFeatureCount += 1;
    const fuaCode = propertyValue(feature.properties, "fua_code");
    if (String(fuaCode ?? "") !== URBAN_ATLAS_SOURCE.fuaCode) {
      throw new Error(`Onverwachte Urban Atlas FUA-code: ${fuaCode}.`);
    }
    const code = String(propertyValue(feature.properties, "code_2021") ?? "").padStart(5, "0");
    const sourceIdentifier = String(propertyValue(feature.properties, "identifier") ?? "onbekend");
    if (!CLASS_BY_CODE.has(code)) throw new Error(`Onbekende Urban Atlas-klasse in bron: ${code || "leeg"}.`);
    const atlasGeometry = toMultiPolygonCoordinates(feature.geometry);
    const indexedAtlasGeometry = indexMultiPolygonRings(atlasGeometry);
    const atlasBounds = indexedMultiPolygonBounds(indexedAtlasGeometry);
    if (!boundsIntersect(atlasBounds, zennevalleiBounds)) continue;
    candidateFeatureCount += 1;
    for (const sector of projectedSectors) {
      if (!boundsIntersect(atlasBounds, sector.bounds)) continue;
      let intersection;
      try {
        const relevantAtlasGeometry = subsetIndexedMultiPolygon(indexedAtlasGeometry, sector.bounds);
        intersection = normalizedIntersection(polygonClipping.intersection(relevantAtlasGeometry, sector.multiPolygon));
      } catch (error) {
        throw new Error(`Geometrische intersectie mislukt voor sector ${sector.sectorId}, klasse ${code}, bronobject ${sourceIdentifier}: ${error.message}`);
      }
      if (!intersection.length) continue;
      const areaSquareMeters = multiPolygonAreaSquareMeters(intersection);
      if (areaSquareMeters <= 0.001) continue;
      presentCodes.add(code);
      addArea(areaBySectorAndClass, sector.sectorId, code, areaSquareMeters);
      outputFeatures.push({
        type: "Feature",
        properties: {
          sectorId: sector.sectorId,
          municipality: sector.municipality,
          classCode: code,
          renderClass: `ua-${code}`,
        },
        geometry: {
          type: "MultiPolygon",
          coordinates: projectMultiPolygon(intersection, inverse),
        },
      });
    }
  }
  const crsCode = Number(headerMetadata?.crs?.code ?? 0);
  if (crsCode !== 3035) throw new Error(`Urban Atlas FlatGeobuf gebruikt geen EPSG:3035 (gevonden ${crsCode || "onbekend"}).`);
  if (!sourceFeatureCount || !candidateFeatureCount || !outputFeatures.length) throw new Error("Urban Atlas-bron bevat geen bruikbare Zennevallei-geometrie.");

  const sectorStats = buildSectorStatistics(sectorAreas, areaBySectorAndClass);
  if (Object.keys(sectorStats).length !== 154) throw new Error("Urban Atlas-statistieken bevatten niet exact 154 sectoren.");
  const insufficientCoverage = Object.entries(sectorStats).filter(([, stats]) => stats.coveragePercentage < 99.5);
  if (insufficientCoverage.length) {
    throw new Error(`Urban Atlas dekt ${insufficientCoverage.length} sectoren voor minder dan 99,5% (eerste: ${insufficientCoverage[0][0]}).`);
  }
  const municipalityCounts = Object.fromEntries([...new Set(sectors.features.map((feature) => feature.properties.municipality))]
    .sort((left, right) => left.localeCompare(right, "nl"))
    .map((municipality) => [municipality, sectors.features.filter((feature) => feature.properties.municipality === municipality).length]));
  const validationStatus = await readValidationStatus();
  const classes = buildClassManifest(styleEntries, presentCodes);
  const geojson = { type: "FeatureCollection", features: outputFeatures };
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    available: true,
    activeYear: 2021,
    opacity: 0.68,
    geojsonUrl: "data/urban-atlas.geojson",
    classes,
    presentClassCodes: classes.filter((entry) => entry.present).map((entry) => entry.code),
    greenCodes: GREEN_CODES,
    artificialCodes: ARTIFICIAL_CODES,
    noDataCodes: NO_DATA_CODES,
    metricDefinitions: {
      denominator: "valid-classified-area",
      green: { classCodes: GREEN_CODES, excludes: ["14200", "21000", "22000", "24000"] },
      artificial: { classCodes: ARTIFICIAL_CODES, description: "Urban Atlas polygon coverage; not a soil-sealing estimate." },
    },
    sectorStats,
    source: {
      ...URBAN_ATLAS_SOURCE,
      ...sourceHashes,
      styleUrl: STYLE_URL,
      styleSha256,
      accessedAt: generatedAt,
      validationStatus,
      validationStatusCheckedAt: generatedAt,
      attribution: "Generated using European Union's Copernicus Land Monitoring Service information.",
    },
    processing: {
      inputCrs: "EPSG:3035",
      outputCrs: "EPSG:4326",
      sourceFeatureCount,
      candidateFeatureCount,
      outputFeatureCount: outputFeatures.length,
      sectorCount: 154,
      municipalityCounts,
      preservedDetail: true,
      areaCalculation: "Exact polygon intersections in EPSG:3035 equal-area coordinates.",
    },
  };
  await fsp.mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(options.outputDir, "urban-atlas.geojson"), JSON.stringify(geojson)),
    fsp.writeFile(path.join(options.outputDir, "urban-atlas.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  console.log(`Urban Atlas klaar: ${outputFeatures.length} sectorfragmenten, ${presentCodes.size} klassen, 154 sectorstatistieken.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
