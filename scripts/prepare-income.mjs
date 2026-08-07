import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_ROOT = path.join(ROOT, ".cache", "statbel-income");
const OUTPUT_PATH = path.join(ROOT, "public", "data", "income.json");
const SECTORS_PATH = path.join(ROOT, "public", "data", "sectors.geojson");
const SOURCE_URL = "https://statbel.fgov.be/sites/default/files/files/opendata/arbeid%20per%20sector/TF_PSNL_INC_TAX_SECTOR.zip";
const SOURCE_PAGE = "https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const YEARS = Object.freeze([2019, 2020, 2021, 2022, 2023]);
const BANDS = Object.freeze([
  { id: "under-20000", minimum: null, maximum: 19999.999, color: "#eff3ff" },
  { id: "20000-24999", minimum: 20000, maximum: 24999.999, color: "#c6dbef" },
  { id: "25000-29999", minimum: 25000, maximum: 29999.999, color: "#9ecae1" },
  { id: "30000-34999", minimum: 30000, maximum: 34999.999, color: "#6baed6" },
  { id: "35000-39999", minimum: 35000, maximum: 39999.999, color: "#4292c6" },
  { id: "40000-44999", minimum: 40000, maximum: 44999.999, color: "#2171b5" },
  { id: "45000-plus", minimum: 45000, maximum: null, color: "#084594" },
]);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function downloadSource(destination) {
  if (fs.existsSync(destination)) return destination;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(SOURCE_URL);
  if (!response.ok || !response.body) throw new Error(`Statbel income download failed: HTTP ${response.status}.`);
  const temporary = `${destination}.partial`;
  await pipeline(response.body, fs.createWriteStream(temporary));
  fs.renameSync(temporary, destination);
  return destination;
}

async function openTextStream(sourcePath) {
  if (path.extname(sourcePath).toLowerCase() === ".txt") return fs.createReadStream(sourcePath);
  const archive = await unzipper.Open.file(sourcePath);
  const entry = archive.files.find((file) => /TF_PSNL_INC_TAX_SECTOR\.txt$/i.test(file.path));
  if (!entry) throw new Error("The Statbel archive does not contain TF_PSNL_INC_TAX_SECTOR.txt.");
  return entry.stream();
}

function officialNumber(value) {
  if (!value || value === "." || value === "C") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function renderClass(value) {
  if (!Number.isFinite(value)) return "no-data";
  return BANDS.find(({ minimum, maximum }) => (minimum === null || value >= minimum)
    && (maximum === null || value <= maximum))?.id ?? "no-data";
}

async function readIncome(sourcePath, sectorIds) {
  const byYear = Object.fromEntries(YEARS.map((year) => [year, new Map()]));
  const input = await openTextStream(sourcePath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    if (!headers) {
      headers = line.split("|");
      continue;
    }
    const values = line.split("|");
    const year = Number(values[0]);
    const sectorId = values[2];
    if (!byYear[year] || !sectorIds.has(sectorId)) continue;
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const median = officialNumber(row.MS_MEDIAN_NET_TAXABLE_INC);
    byYear[year].set(sectorId, {
      sourceStatus: median === null ? "not-published" : "available",
      numberOfDeclarations: officialNumber(row.MS_NBR_NON_ZERO_INC),
      totalNetTaxableIncome: officialNumber(row.MS_TOT_NET_TAXABLE_INC),
      averageNetTaxableIncome: officialNumber(row.MS_AVG_TOT_NET_TAXABLE_INC),
      medianNetTaxableIncome: median,
      interquartileDifference: officialNumber(row.MS_INT_QUART_DIFF),
      interquartileCoefficient: officialNumber(row.MS_INT_QUART_COEFF),
      interquartileAsymmetry: officialNumber(row.MS_INT_QUART_ASSYM),
      renderClass: renderClass(median),
    });
  }
  return byYear;
}

async function main() {
  const requestedSource = argumentValue("--source");
  const sourcePath = requestedSource
    ? path.resolve(requestedSource)
    : await downloadSource(path.join(CACHE_ROOT, "TF_PSNL_INC_TAX_SECTOR.zip"));
  if (!fs.existsSync(sourcePath)) throw new Error(`Statbel income source not found: ${sourcePath}`);

  const sectors = JSON.parse(fs.readFileSync(SECTORS_PATH, "utf8"));
  const sectorIds = new Set(sectors.features.map((feature) => feature.properties.sectorId));
  if (sectorIds.size !== 154) throw new Error(`Expected 154 sector identifiers, received ${sectorIds.size}.`);
  const sourceRows = await readIncome(sourcePath, sectorIds);

  const years = {};
  for (const year of YEARS) {
    const matched = sourceRows[year];
    const sectorStats = {};
    for (const sectorId of [...sectorIds].sort()) {
      sectorStats[sectorId] = matched.get(sectorId) ?? {
        sourceStatus: "sector-unmatched",
        numberOfDeclarations: null,
        totalNetTaxableIncome: null,
        averageNetTaxableIncome: null,
        medianNetTaxableIncome: null,
        interquartileDifference: null,
        interquartileCoefficient: null,
        interquartileAsymmetry: null,
        renderClass: "no-data",
      };
    }
    const availableCount = Object.values(sectorStats).filter(({ sourceStatus }) => sourceStatus === "available").length;
    const matchedCount = Object.values(sectorStats).filter(({ sourceStatus }) => sourceStatus !== "sector-unmatched").length;
    if (matchedCount !== 150 || availableCount !== 141) {
      throw new Error(`Statbel ${year}: expected 150 joins and 141 published medians, received ${matchedCount} and ${availableCount}.`);
    }
    years[year] = {
      matchedCount,
      availableCount,
      noDataCount: sectorIds.size - availableCount,
      sectorStats,
    };
  }

  const payload = {
    schemaVersion: 1,
    datasetId: "statbel-income",
    kind: "sector-temporal",
    availableYears: YEARS,
    defaultYear: 2023,
    noDataColor: "#EAE2DE",
    bands: BANDS,
    measure: {
      id: "median-net-taxable-income-per-declaration",
      sourceVariable: "MS_MEDIAN_NET_TAXABLE_INC",
      unit: "EUR",
      priceBasis: "nominal",
    },
    years,
    source: {
      name: "Fiscal statistics on income by statistical sector",
      producer: "Statbel, the Belgian statistical office",
      pageUrl: SOURCE_PAGE,
      downloadUrl: SOURCE_URL,
      licence: "CC BY 4.0",
      licenceUrl: LICENSE_URL,
      period: "2005-2023",
      sourceSha256: sha256File(sourcePath),
      sourceBytes: fs.statSync(sourcePath).size,
      accessedAt: new Date().toISOString(),
    },
    geometry: {
      authority: "Statbel",
      referenceDate: "2024-01-01",
      sectorCount: 154,
      sourceSha256: sha256File(SECTORS_PATH),
    },
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Prepared ${OUTPUT_PATH}`);
  YEARS.forEach((year) => console.log(`${year}: ${years[year].availableCount} medians, ${years[year].noDataCount} no data`));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
