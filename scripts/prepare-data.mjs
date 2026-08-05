import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import proj4 from "proj4";
import unzipper from "unzipper";
import XLSX from "xlsx";
import {
  EXPECTED_MUNICIPALITY_COUNTS,
  PALETTE,
  SES_COMPONENTS,
  SOURCES,
  VULNERABILITY_COMPONENTS,
} from "./lib/methodology.mjs";

// SheetJS 0.20+ keeps its browser and Node builds separate. Supplying Node's
// filesystem adapter makes readFile explicit and prevents browser APIs from
// leaking into the preparation pipeline.
XLSX.set_fs(fs);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_CACHE = path.join(PROJECT_ROOT, ".cache", "data");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "public", "data");
const BELGIAN_LAMBERT_2008 = "+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 +x_0=649328 +y_0=665262 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs";

proj4.defs("EPSG:3812", BELGIAN_LAMBERT_2008);

function parseArguments(argv) {
  const options = { cacheDir: DEFAULT_CACHE, outputDir: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--") continue;
    if (argument === "--scores" && next) options.scoresPath = path.resolve(next);
    else if (argument === "--sectors" && next) options.sectorsPath = path.resolve(next);
    else if (argument === "--cache" && next) options.cacheDir = path.resolve(next);
    else if (argument === "--output" && next) options.outputDir = path.resolve(next);
    else if (argument === "--help") options.help = true;
    else if (argument.startsWith("--")) throw new Error(`Onbekende optie: ${argument}`);
    else continue;
    index += 1;
  }
  return options;
}

function printHelp() {
  console.log(`Gebruik: npm run data:prepare -- [opties]\n\n` +
    `  --scores <pad>   Lokale 2026-XLSX (standaard: officiële download)\n` +
    `  --sectors <pad>  Lokale Statbel 2024 GeoJSON of ZIP (standaard: officiële download)\n` +
    `  --cache <map>    Downloadcache\n` +
    `  --output <map>   Doelmap voor browserdata\n`);
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadIfNeeded(source, destination) {
  if (await fileExists(destination)) return destination;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  console.log(`Download ${source.label}…`);
  const response = await fetch(source.downloadUrl, {
    headers: { "User-Agent": "ZennevalleiHittekaart/0.1 (local data preparation)" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download mislukt (${response.status}) voor ${source.downloadUrl}`);
  }
  const temporaryPath = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath));
  await fsp.rename(temporaryPath, destination);
  return destination;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sourceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function displayValue(value) {
  return sourceValue(value);
}

function statusFor(finalValue) {
  const numeric = sourceValue(finalValue);
  if (numeric === 9999) return "institution-present-no-score";
  if (numeric === null) return "insufficient-data";
  return "scored";
}

function renderClassFor(finalValue) {
  const status = statusFor(finalValue);
  if (status === "scored") return `score-${Number(finalValue)}`;
  if (status === "institution-present-no-score") return status;
  return "no-data";
}

function validateScore(value, label, sectorId) {
  const numeric = sourceValue(value);
  if (numeric === null || numeric === 9999) return;
  if (numeric < 0 || numeric > 10) {
    throw new Error(`${sectorId}: ${label} heeft ongeldige score ${numeric}`);
  }
}

function readWorkbook(scoresPath) {
  const workbook = XLSX.readFile(scoresPath, { cellDates: false });
  const dataSheet = workbook.Sheets.Hittekwetsbaarheid;
  const legendSheet = workbook.Sheets.LEGENDE;
  if (!dataSheet || !legendSheet) {
    throw new Error("De verwachte tabbladen LEGENDE en Hittekwetsbaarheid ontbreken.");
  }
  const allRows = XLSX.utils.sheet_to_json(dataSheet, { defval: null, raw: true });
  const firstColumn = Object.keys(allRows[0] ?? {})[0];
  const rows = allRows.filter((row) => row.Eerstelijn_naam === "Zennevallei").map((row) => ({
    ...row,
    sectorId: String(row[firstColumn] ?? "").trim(),
  }));
  const legendRows = XLSX.utils.sheet_to_json(legendSheet, { header: 1, defval: null, raw: false });
  const indicatorDefinitions = Object.fromEntries(
    legendRows
      .filter((row) => typeof row[0] === "string" && typeof row[1] === "string")
      .map((row) => [row[0].trim(), row[1].trim()]),
  );
  return { rows, indicatorDefinitions };
}

function buildScoreRecord(row) {
  const finalSourceValue = sourceValue(row.Hittekwetsbaarheid);
  const status = statusFor(finalSourceValue);
  if (status === "scored" && !Number.isInteger(finalSourceValue)) {
    throw new Error(`${row.sectorId}: de eindscore moet een gehele renderklasse zijn, kreeg ${finalSourceValue}`);
  }
  const components = Object.fromEntries(
    VULNERABILITY_COMPONENTS.map(({ key, sourceColumn }) => [key, displayValue(row[sourceColumn])]),
  );
  const sesComponents = Object.fromEntries(
    SES_COMPONENTS.map(({ key, sourceColumn }) => [key, displayValue(row[sourceColumn])]),
  );
  const fieldsToValidate = [
    ["Hittekwetsbaarheid", row.Hittekwetsbaarheid],
    ["Hitte", row.Hitte],
    ["Kwetsbaarheid", row.Kwetsbaarheid],
    ...VULNERABILITY_COMPONENTS.map(({ sourceColumn }) => [sourceColumn, row[sourceColumn]]),
    ...SES_COMPONENTS.map(({ sourceColumn }) => [sourceColumn, row[sourceColumn]]),
  ];
  fieldsToValidate.forEach(([label, value]) => validateScore(value, label, row.sectorId));

  return {
    sectorId: row.sectorId,
    sectorName: row.geo_naam,
    workbookSectorName: row.geo_naam,
    municipality: row.Gemeente_naam,
    arrondissement: row.Arrondissement_naam,
    province: row.Provincie_naam,
    primaryCareZone: row.Eerstelijn_naam,
    healthRegion: row.Gezondheidsmakers_naam,
    status,
    sourceSentinel: finalSourceValue === 9999 ? 9999 : null,
    scores: {
      final: displayValue(row.Hittekwetsbaarheid),
      heat: displayValue(row.Hitte),
      vulnerability: displayValue(row.Kwetsbaarheid),
      components,
      sesComponents,
    },
  };
}

async function openGeoJsonStream(sectorsPath) {
  if (sectorsPath.toLowerCase().endsWith(".zip")) {
    const archive = await unzipper.Open.file(sectorsPath);
    const entry = archive.files.find((file) => file.path.toLowerCase().endsWith(".geojson"));
    if (!entry) throw new Error("De ZIP bevat geen GeoJSON-bestand.");
    return entry.stream();
  }
  return fs.createReadStream(sectorsPath, { encoding: "utf8" });
}

function countVertices(coordinates) {
  if (!Array.isArray(coordinates)) return 0;
  if (coordinates.length >= 2 && typeof coordinates[0] === "number") return 1;
  return coordinates.reduce((sum, child) => sum + countVertices(child), 0);
}

function transformCoordinates(coordinates, bounds) {
  if (coordinates.length >= 2 && typeof coordinates[0] === "number") {
    const [longitude, latitude] = proj4("EPSG:3812", "EPSG:4326", [coordinates[0], coordinates[1]]);
    bounds.minLon = Math.min(bounds.minLon, longitude);
    bounds.maxLon = Math.max(bounds.maxLon, longitude);
    bounds.minLat = Math.min(bounds.minLat, latitude);
    bounds.maxLat = Math.max(bounds.maxLat, latitude);
    return [longitude, latitude];
  }
  return coordinates.map((child) => transformCoordinates(child, bounds));
}

async function buildGeometry(sectorsPath, scoreRecords) {
  const wantedIds = new Set(Object.keys(scoreRecords));
  const features = [];
  const nameMismatches = [];
  const bounds = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  let inputVertices = 0;
  let outputVertices = 0;
  const stream = await openGeoJsonStream(sectorsPath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!/^\{\s*"type"\s*:\s*"Feature"/.test(trimmed)) continue;
    const feature = JSON.parse(trimmed.replace(/,$/, ""));
    const sectorId = String(feature.properties?.cd_sector ?? "");
    if (!wantedIds.has(sectorId)) continue;
    if (feature.geometry?.type !== "MultiPolygon") {
      throw new Error(`${sectorId}: verwacht MultiPolygon, kreeg ${feature.geometry?.type ?? "geen geometrie"}`);
    }
    const before = countVertices(feature.geometry.coordinates);
    if (before === 0) throw new Error(`${sectorId}: lege geometrie`);
    const coordinates = transformCoordinates(feature.geometry.coordinates, bounds);
    const after = countVertices(coordinates);
    inputVertices += before;
    outputVertices += after;
    const statbelName = feature.properties.tx_sector_descr_nl;
    const record = scoreRecords[sectorId];
    if (statbelName !== record.workbookSectorName) {
      nameMismatches.push({ sectorId, workbookName: record.workbookSectorName, statbelName });
    }
    record.sectorName = statbelName;
    features.push({
      type: "Feature",
      id: sectorId,
      properties: {
        sectorId,
        sectorName: statbelName,
        municipality: record.municipality,
        renderClass: renderClassFor(record.sourceSentinel ?? record.scores.final),
      },
      geometry: { type: "MultiPolygon", coordinates },
    });
  }

  features.sort((left, right) => left.properties.sectorId.localeCompare(right.properties.sectorId, "nl"));
  return { featureCollection: { type: "FeatureCollection", features }, bounds, inputVertices, outputVertices, nameMismatches };
}

function validatePreparedData(scoreRecords, geometryResult) {
  const records = Object.values(scoreRecords);
  const features = geometryResult.featureCollection.features;
  if (records.length !== 154) throw new Error(`Verwacht 154 score-records, kreeg ${records.length}.`);
  if (new Set(records.map((record) => record.sectorId)).size !== records.length) throw new Error("Dubbele sector-ID in scoredata.");
  if (features.length !== records.length) {
    const found = new Set(features.map((feature) => feature.properties.sectorId));
    const missing = records.map((record) => record.sectorId).filter((id) => !found.has(id));
    throw new Error(`Geometriejoin is niet volledig (${features.length}/${records.length}). Ontbrekend: ${missing.join(", ")}`);
  }
  const counts = Object.fromEntries(Object.keys(EXPECTED_MUNICIPALITY_COUNTS).map((name) => [name, 0]));
  records.forEach((record) => { counts[record.municipality] = (counts[record.municipality] ?? 0) + 1; });
  for (const [municipality, expected] of Object.entries(EXPECTED_MUNICIPALITY_COUNTS)) {
    if (counts[municipality] !== expected) throw new Error(`${municipality}: verwacht ${expected}, kreeg ${counts[municipality]}.`);
  }
  const scored = records.filter((record) => record.status === "scored").length;
  const noData = records.filter((record) => record.status === "insufficient-data").length;
  if (scored !== 140 || noData !== 14) throw new Error(`Onverwachte statusaantallen: ${scored} gescoord, ${noData} zonder data.`);
  if (geometryResult.inputVertices !== geometryResult.outputVertices) throw new Error("Vertexverlies tijdens reprojection.");
  const { minLon, maxLon, minLat, maxLat } = geometryResult.bounds;
  if (minLon < 3.5 || maxLon > 5.5 || minLat < 49.5 || maxLat > 51.5) throw new Error("Uitvoercoördinaten vallen buiten plausibele Belgische grenzen.");
  return { counts, scored, noData };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  await fsp.mkdir(options.cacheDir, { recursive: true });
  const scoresPath = options.scoresPath ?? await downloadIfNeeded(SOURCES.scores, path.join(options.cacheDir, SOURCES.scores.filename));
  const sectorsPath = options.sectorsPath ?? await downloadIfNeeded(SOURCES.geometry, path.join(options.cacheDir, SOURCES.geometry.filename));
  const [scoresHash, sectorsHash] = await Promise.all([sha256(scoresPath), sha256(sectorsPath)]);
  if (!options.scoresPath && scoresHash !== SOURCES.scores.expectedSha256) throw new Error("De officiële XLSX is gewijzigd; controleer de nieuwe bron voor verwerking.");
  if (!options.sectorsPath && sectorsHash !== SOURCES.geometry.expectedSha256) throw new Error("De gepinde Statbel-ZIP is gewijzigd; controleer de bron.");

  console.log("Lees en valideer scoredata…");
  const { rows, indicatorDefinitions } = readWorkbook(scoresPath);
  const scoreRecords = Object.fromEntries(rows.map((row) => [row.sectorId, buildScoreRecord(row)]));
  console.log("Koppel en herprojecteer Statbel-geometrieën…");
  const geometryResult = await buildGeometry(sectorsPath, scoreRecords);
  const validation = validatePreparedData(scoreRecords, geometryResult);

  const generatedAt = new Date().toISOString();
  const methodology = {
    schemaVersion: 1,
    title: "Hittekwetsbaarheid Zennevallei",
    locale: "nl-BE",
    scoreScale: { minimum: 0, maximum: 10, relativeTo: "Vlaanderen" },
    palette: PALETTE,
    vulnerabilityComponents: VULNERABILITY_COMPONENTS,
    sesComponents: SES_COMPONENTS,
    indicatorDefinitions,
    caveats: [
      "De scores zijn relatieve klasseringen ten opzichte van de rest van Vlaanderen.",
      "De gepubliceerde eindscore kan niet exact worden herberekend uit de afgeronde deelscores.",
      "Hitte en kwetsbaarheid worden via decielen geclassificeerd; de eindscore hittekwetsbaarheid gebruikt natuurlijke breekpunten (natural breaks).",
      "Een lage score betekent niet dat er geen gezondheidsrisico door hitte bestaat.",
    ],
    sources: SOURCES,
  };
  const provenance = {
    schemaVersion: 1,
    generatedAt,
    inputs: {
      scores: { path: path.basename(scoresPath), sha256: scoresHash, sourceUrl: SOURCES.scores.downloadUrl, retrievedAt: generatedAt },
      geometry: { path: path.basename(sectorsPath), sha256: sectorsHash, sourceUrl: SOURCES.geometry.downloadUrl, retrievedAt: generatedAt, snapshotDate: SOURCES.geometry.snapshotDate, sourceCrs: SOURCES.geometry.sourceCrs },
    },
    output: {
      targetCrs: "EPSG:4326",
      sectorCount: geometryResult.featureCollection.features.length,
      inputVertices: geometryResult.inputVertices,
      outputVertices: geometryResult.outputVertices,
      bounds: geometryResult.bounds,
      municipalityCounts: validation.counts,
      scoredCount: validation.scored,
      insufficientDataCount: validation.noData,
      institutionPresentNoScoreCount: Object.values(scoreRecords).filter((record) => record.status === "institution-present-no-score").length,
    },
    nameMismatches: geometryResult.nameMismatches,
  };

  await fsp.mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(options.outputDir, "sectors.geojson"), JSON.stringify(geometryResult.featureCollection)),
    fsp.writeFile(path.join(options.outputDir, "scores.json"), JSON.stringify({ schemaVersion: 1, generatedAt, sectors: scoreRecords }, null, 2)),
    fsp.writeFile(path.join(options.outputDir, "methodology.json"), JSON.stringify(methodology, null, 2)),
    fsp.writeFile(path.join(options.outputDir, "provenance.json"), JSON.stringify(provenance, null, 2)),
  ]);
  console.log(`Klaar: ${featuresSummary(geometryResult.featureCollection.features, validation)}.`);
  if (geometryResult.nameMismatches.length) console.log(`Naamverschillen: ${JSON.stringify(geometryResult.nameMismatches)}`);
}

function featuresSummary(features, validation) {
  return `${features.length} sectoren, ${validation.scored} met score, ${validation.noData} zonder synthesescore`;
}

main().catch((error) => {
  console.error(`Data preparation failed: ${error.message}`);
  process.exitCode = 1;
});
