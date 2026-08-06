import fs from "node:fs/promises";
import path from "node:path";

const target = path.resolve(".cache", "playground-map-test");
await fs.mkdir(target, { recursive: true });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);
const variants = {
  all: "test.png",
  Beersel: "test-beersel.png",
  Drogenbos: "test-drogenbos.png",
  Halle: "test-halle.png",
  Linkebeek: "test-linkebeek.png",
  Pepingen: "test-pepingen.png",
  "Sint-Genesius-Rode": "test-sint-genesius-rode.png",
  "Sint-Pieters-Leeuw": "test-sint-pieters-leeuw.png",
};
await Promise.all([...new Set(Object.values(variants))].map((name) => fs.writeFile(path.join(target, name), png)));
await fs.writeFile(path.join(target, "manifest.json"), JSON.stringify({
  schemaVersion: 1,
  kind: "continuous",
  title: { en: "Notebook NDVI test", nl: "Notebook-NDVI-test" },
  description: {
    en: "Deterministic continuous raster exported from Python.",
    nl: "Deterministisch continu raster geëxporteerd uit Python.",
  },
  units: "NDVI",
  opacity: 0.68,
  imageUrl: "test.png",
  rasterVariants: variants,
  coordinates: [[4.07, 50.83], [4.43, 50.83], [4.43, 50.68], [4.07, 50.68]],
  legend: { items: [
    { label: "-0.20", color: "#a50026" }, { label: "0.35", color: "#ffffbf" }, { label: "0.90", color: "#006837" },
  ] },
  sectorStats: {
    "23003A001": { validAreaHa: 24.5, sectorAreaHa: 30, minimum: -0.1, maximum: 0.91, mean: 0.57, median: 0.61 },
  },
  municipalityStats: {
    Halle: { validAreaHa: 1010, sectorAreaHa: 1150, minimum: -0.2, maximum: 0.94, mean: 0.59, median: 0.64 },
  },
  source: { type: "local-notebook-export", date: "2021-06-14", crs: "EPSG:32631", resolutionMeters: 10 },
}, null, 2));
