import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateApplicationData } from "../src/data-validation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(projectRoot, "public");
const dataRoot = path.join(publicRoot, "data");

async function readJson(fileName) {
  return JSON.parse(await fs.readFile(path.join(dataRoot, fileName), "utf8"));
}

function browserAssetPath(assetUrl) {
  if (!assetUrl || /^(?:https?:)?\/\//i.test(assetUrl)) throw new Error(`Expected a local browser asset, received '${assetUrl}'.`);
  return path.join(publicRoot, assetUrl.replace(/^\//, ""));
}

const [geojson, scorePayload, methodology, provenance, landCover, urbanAtlas] = await Promise.all([
  readJson("sectors.geojson"),
  readJson("scores.json"),
  readJson("methodology.json"),
  readJson("provenance.json"),
  readJson("land-cover.json"),
  readJson("urban-atlas.json"),
]);

const { sectorIds } = validateApplicationData({
  geojson,
  scorePayload,
  methodology,
  provenance,
  landCover,
  urbanAtlas,
});

if (sectorIds.size !== 154) throw new Error(`Expected 154 Zennevallei sectors, received ${sectorIds.size}.`);
for (const [name, stats] of [["land cover", landCover.sectorStats], ["Urban Atlas", urbanAtlas.sectorStats]]) {
  const ids = Object.keys(stats ?? {});
  if (ids.length !== sectorIds.size || ids.some((sectorId) => !sectorIds.has(sectorId))) {
    throw new Error(`${name} statistics do not match the 154 sector identifiers.`);
  }
}

await fs.access(browserAssetPath(landCover.raster.imageUrl));
await fs.access(browserAssetPath(urbanAtlas.geojsonUrl));
console.log(`Validated ${sectorIds.size} sectors and all prepared browser assets.`);
