/** Build the tiny, deterministic geography used only by the Guide me tour. */
import fs from "node:fs/promises";
import path from "node:path";
import polygonClipping from "polygon-clipping";

const ROOT = path.resolve(import.meta.dirname, "..");
const INPUT = path.join(ROOT, "public", "data", "sectors.geojson");
const OUTPUT = path.join(ROOT, "public", "data", "guide-geography.geojson");
const SIMPLIFY_TOLERANCE = 0.000045;

function asMultiPolygon(geometry) {
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "Polygon") return [geometry.coordinates];
  throw new TypeError(`Unsupported guide geometry: ${geometry.type}.`);
}

function geometryFromUnion(coordinates) {
  const simplified = coordinates.map((polygon) => polygon.map(simplifyRing));
  return simplified.length === 1
    ? { type: "Polygon", coordinates: simplified[0] }
    : { type: "MultiPolygon", coordinates: simplified };
}

function exteriorRings(coordinates) {
  return coordinates.map((polygon) => simplifyRing(polygon[0]));
}

function squareDistanceToSegment(point, start, end) {
  let x = start[0];
  let y = start[1];
  const dx = end[0] - x;
  const dy = end[1] - y;
  if (dx || dy) {
    const ratio = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (ratio > 1) [x, y] = end;
    else if (ratio > 0) { x += dx * ratio; y += dy * ratio; }
  }
  const px = point[0] - x;
  const py = point[1] - y;
  return px * px + py * py;
}

function simplifyLine(points, first, last, toleranceSquared, output) {
  let maximum = toleranceSquared;
  let selected = 0;
  for (let index = first + 1; index < last; index += 1) {
    const distance = squareDistanceToSegment(points[index], points[first], points[last]);
    if (distance > maximum) { selected = index; maximum = distance; }
  }
  if (!selected) return;
  if (selected - first > 1) simplifyLine(points, first, selected, toleranceSquared, output);
  output.push(points[selected]);
  if (last - selected > 1) simplifyLine(points, selected, last, toleranceSquared, output);
}

function simplifyRing(ring) {
  const points = ring.slice(0, -1);
  if (points.length <= 4) return ring;
  const output = [points[0]];
  simplifyLine(points, 0, points.length - 1, SIMPLIFY_TOLERANCE ** 2, output);
  output.push(points.at(-1), points[0]);
  return output.length >= 4 ? output : ring;
}

function ringCentre(coordinates) {
  const points = exteriorRings(coordinates).flat();
  const bounds = points.reduce((value, [x, y]) => ({
    minX: Math.min(value.minX, x), minY: Math.min(value.minY, y),
    maxX: Math.max(value.maxX, x), maxY: Math.max(value.maxY, y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

async function main() {
  const sectors = JSON.parse(await fs.readFile(INPUT, "utf8"));
  if (sectors.features?.length !== 154) throw new Error("Guide geography requires 154 Statbel sectors.");
  const byMunicipality = sectors.features.reduce((groups, feature) => {
    const name = feature.properties.municipality;
    groups.set(name, [...(groups.get(name) ?? []), feature]);
    return groups;
  }, new Map());
  if (byMunicipality.size !== 7) throw new Error("Guide geography requires seven municipalities.");

  const municipalityUnions = [...byMunicipality].map(([name, features]) => {
    const coordinates = polygonClipping.union(...features.map(({ geometry }) => asMultiPolygon(geometry)));
    return { name, coordinates, centre: ringCentre(coordinates), sectorCount: features.length };
  }).sort((a, b) => b.centre[1] - a.centre[1] || a.name.localeCompare(b.name, "en"));

  const regionCoordinates = polygonClipping.union(...municipalityUnions.map(({ coordinates }) => coordinates));
  const features = [{
    type: "Feature",
    properties: { kind: "region", sectorCount: 154, municipalityCount: 7 },
    geometry: geometryFromUnion(regionCoordinates),
  }, {
    type: "Feature",
    properties: { kind: "region-outline" },
    geometry: { type: "MultiLineString", coordinates: exteriorRings(regionCoordinates) },
  }];

  municipalityUnions.forEach(({ name, coordinates, centre, sectorCount }, revealIndex) => {
    features.push({
      type: "Feature",
      properties: { kind: "municipality", name, revealIndex, sectorCount },
      geometry: geometryFromUnion(coordinates),
    }, {
      type: "Feature",
      properties: { kind: "municipality-label", name, revealIndex },
      geometry: { type: "Point", coordinates: centre },
    });
  });

  await fs.writeFile(OUTPUT, `${JSON.stringify({ type: "FeatureCollection", features })}\n`);
  console.log(`Generated ${path.relative(ROOT, OUTPUT)}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
