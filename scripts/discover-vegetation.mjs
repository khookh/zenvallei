/**
 * Select one comparable annual Sentinel-2 observation using cloud and coverage
 * evidence over the actual Zennevallei sector union, not scene-level metadata
 * alone. Credentials are read from the process environment and never written.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import polygonClipping from "polygon-clipping";
import proj4 from "proj4";
import { multiPolygonAreaSquareMeters } from "./lib/urban-atlas-core.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG_URL = "https://sh.dataspace.copernicus.eu/catalog/v1/search";
const STATISTICS_URL = "https://sh.dataspace.copernicus.eu/statistics/v1";
const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const TARGET_MONTH_DAY = "06-24";
const CLOUD_CODES = new Set([3, 7, 8, 9, 10, 11]);
const REQUIRED_TILES = new Set(["T31UFS", "T31UES"]);

function parseArguments(argv) {
  const options = {
    fromYear: 2015,
    toYear: new Date().getUTCFullYear(),
    sectorsPath: path.join(PROJECT_ROOT, "public", "data", "sectors.geojson"),
    outputPath: path.join(PROJECT_ROOT, ".cache", "vegetation", "selection.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--from-year": options.fromYear = Number(value); index += 1; break;
      case "--to-year": options.toYear = Number(value); index += 1; break;
      case "--sectors": options.sectorsPath = path.resolve(value); index += 1; break;
      case "--output": options.outputPath = path.resolve(value); index += 1; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Onbekend argument: ${argv[index]}`);
    }
  }
  return options;
}

function printHelp() {
  console.log("Gebruik: pnpm vegetation:discover -- --from-year 2015 --to-year 2026");
}

async function accessToken() {
  const clientId = process.env.CDSE_SH_CLIENT_ID?.trim();
  const clientSecret = process.env.CDSE_SH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("CDSE_SH_CLIENT_ID of CDSE_SH_CLIENT_SECRET ontbreekt.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`Sentinel Hub-authenticatie mislukt: HTTP ${response.status}.`);
  const payload = await response.json();
  return payload.access_token;
}

function multiPolygon(feature) {
  return feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [feature.geometry.coordinates];
}

function unionGeometry(sectors) {
  let union = multiPolygon(sectors.features[0]);
  for (const feature of sectors.features.slice(1)) union = polygonClipping.union(union, multiPolygon(feature));
  return { type: "MultiPolygon", coordinates: union };
}

function projectGeometry(geometry) {
  return {
    ...geometry,
    coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map((coordinate) =>
      proj4("EPSG:4326", "EPSG:32631", coordinate)
    ))),
  };
}

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of geometry.coordinates) for (const ring of polygon) for (const [x, y] of ring) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

function footprintFraction(geometry) {
  const bounds = geometryBounds(geometry);
  return multiPolygonAreaSquareMeters(geometry.coordinates)
    / ((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]));
}

function tileFromProductId(productId) {
  return productId.match(/T31U(?:FS|ES)/)?.[0] ?? null;
}

function boundsOf(sectors) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates?.[0] === "number") {
      result[0] = Math.min(result[0], coordinates[0]);
      result[1] = Math.min(result[1], coordinates[1]);
      result[2] = Math.max(result[2], coordinates[0]);
      result[3] = Math.max(result[3], coordinates[1]);
    } else for (const child of coordinates ?? []) visit(child);
  };
  sectors.features.forEach((feature) => visit(feature.geometry.coordinates));
  return result;
}

async function catalogueCandidates(year, bbox, token) {
  const start = year === 2015 ? `${year}-07-04T00:00:00Z` : `${year}-06-01T00:00:00Z`;
  const body = {
    collections: ["sentinel-2-l2a"],
    bbox,
    datetime: `${start}/${year}-07-31T23:59:59Z`,
    limit: 100,
    fields: { include: ["id", "properties.datetime", "properties.eo:cloud_cover", "properties.s2:mgrs_tile_id"] },
  };
  const features = [];
  let next;
  do {
    const response = await fetch(CATALOG_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(next ? { ...body, next } : body),
    });
    if (!response.ok) throw new Error(`Cataloguszoekopdracht voor ${year} mislukt: HTTP ${response.status}.`);
    const result = await response.json();
    features.push(...result.features);
    next = result.context?.next;
  } while (next);

  const byDate = new Map();
  for (const feature of features) {
    const date = feature.properties.datetime.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(feature);
  }
  return [...byDate.entries()].map(([date, items]) => ({
    date,
    products: items.map((item) => ({
      id: item.id,
      datetime: item.properties.datetime,
      tile: item.properties["s2:mgrs_tile_id"] ?? tileFromProductId(item.id),
      catalogueCloudPercentage: item.properties["eo:cloud_cover"] ?? null,
    })),
    maximumTileCloudPercentage: Math.max(...items.map((item) => Number(item.properties["eo:cloud_cover"] ?? 100))),
  })).filter((candidate) => {
    const tiles = new Set(candidate.products.map((product) => product.tile));
    return [...REQUIRED_TILES].every((tile) => tiles.has(tile));
  });
}

const QUALITY_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["SCL", "CLD", "dataMask"], units: ["DN", "PERCENT", "DN"] }],
    output: [
      { id: "quality", bands: ["cloudAffected", "cloudProbability", "coverage"] },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(sample) {
  var cloud = sample.SCL === 3 || sample.SCL === 7 || sample.SCL === 8 || sample.SCL === 9 || sample.SCL === 10 || sample.SCL === 11;
  return {
    quality: [cloud ? 1 : 0, sample.CLD / 100, sample.dataMask],
    dataMask: [1]
  };
}`;

async function measureCandidate(candidate, geometry, footprint, token) {
  const nextDate = new Date(`${candidate.date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const request = {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/32631" } },
        data: [{ type: "sentinel-2-l2a", dataFilter: { mosaickingOrder: "leastCC", maxCloudCoverage: 100 } }],
      },
      aggregation: {
        timeRange: { from: `${candidate.date}T00:00:00Z`, to: nextDate.toISOString() },
        aggregationInterval: { of: "P1D" },
        evalscript: QUALITY_EVALSCRIPT,
        resx: 20,
        resy: 20,
      },
    }),
  };
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(STATISTICS_URL, request);
    if (response.status !== 429) break;
    const retryAfter = Math.min(10, Math.max(3, Number(response.headers.get("retry-after") ?? 5)));
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`Kwaliteitsmeting voor ${candidate.date} mislukt: HTTP ${response.status}. ${detail}`);
  }
  const payload = await response.json();
  const bands = payload.data?.[0]?.outputs?.quality?.bands;
  if (!bands) return { ...candidate, coveragePercentage: 0, cloudAffectedPercentage: 100, meanCloudProbability: 1 };
  const coverage = bands.coverage.stats.mean;
  return {
    ...candidate,
    coveragePercentage: Number((Math.min(1, coverage / footprint) * 100).toFixed(4)),
    cloudAffectedPercentage: Number((coverage > 0 ? bands.cloudAffected.stats.mean / coverage * 100 : 100).toFixed(4)),
    meanCloudProbability: Number((coverage > 0 ? bands.cloudProbability.stats.mean / coverage * 100 : 100).toFixed(4)),
  };
}

function dayDistance(date, year) {
  return Math.abs((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${year}-${TARGET_MONTH_DAY}T00:00:00Z`)) / 86_400_000);
}

function selectCandidate(year, candidates) {
  const complete = candidates.filter((entry) => entry.coveragePercentage >= 99.5);
  const core = complete.filter((entry) => dayDistance(entry.date, year) <= 16);
  const acceptableCore = core.filter((entry) => entry.cloudAffectedPercentage <= 2);
  const acceptableAll = complete.filter((entry) => entry.cloudAffectedPercentage <= 2);
  const pool = acceptableCore.length ? acceptableCore : acceptableAll.length ? acceptableAll : complete.length ? complete : candidates;
  return [...pool].sort((left, right) => {
    if (acceptableCore.length || acceptableAll.length) {
      return dayDistance(left.date, year) - dayDistance(right.date, year)
        || left.cloudAffectedPercentage - right.cloudAffectedPercentage
        || left.date.localeCompare(right.date);
    }
    return left.cloudAffectedPercentage - right.cloudAffectedPercentage
      || dayDistance(left.date, year) - dayDistance(right.date, year)
      || left.date.localeCompare(right.date);
  })[0];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const sectors = JSON.parse(await fsp.readFile(options.sectorsPath, "utf8"));
  if (sectors.features?.length !== 154) throw new Error("De sectorbron bevat niet exact 154 sectoren.");
  const token = await accessToken();
  const geometry = projectGeometry(unionGeometry(sectors));
  const footprint = footprintFraction(geometry);
  const bbox = boundsOf(sectors);
  const years = {};
  for (let year = options.fromYear; year <= options.toYear; year += 1) {
    const catalogue = await catalogueCandidates(year, bbox, token);
    if (!catalogue.length) throw new Error(`Geen Sentinel-2 L2A-kandidaten gevonden voor ${year}.`);
    const shortlist = [...catalogue]
      .sort((left, right) => left.maximumTileCloudPercentage - right.maximumTileCloudPercentage
        || dayDistance(left.date, year) - dayDistance(right.date, year))
      .slice(0, 6);
    if (!shortlist.some((entry) => dayDistance(entry.date, year) <= 16)) {
      shortlist.push([...catalogue].sort((left, right) => dayDistance(left.date, year) - dayDistance(right.date, year))[0]);
    }
    const measured = [];
    for (const candidate of shortlist) {
      measured.push(await measureCandidate(candidate, geometry, footprint, token));
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const selected = selectCandidate(year, measured);
    years[year] = {
      year,
      targetDate: `${year}-${TARGET_MONTH_DAY}`,
      selectedDate: selected.date,
      dayOffset: dayDistance(selected.date, year),
      qualityStatus: selected.coveragePercentage >= 99.5 && selected.cloudAffectedPercentage <= 2 ? "good" : "warning",
      selected,
      candidates: measured.sort((left, right) => left.date.localeCompare(right.date)),
    };
    console.log(`${year}: ${selected.date}; wolkenindex ${selected.cloudAffectedPercentage.toFixed(2)}%; dekking ${selected.coveragePercentage.toFixed(2)}%.`);
  }
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    collection: "sentinel-2-l2a",
    targetMonthDay: TARGET_MONTH_DAY,
    cloudAffectedSclCodes: [...CLOUD_CODES],
    years,
  };
  await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fsp.writeFile(options.outputPath, JSON.stringify(output, null, 2));
  console.log(`Selectierapport: ${options.outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
