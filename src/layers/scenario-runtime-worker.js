import { fromUrl } from "geotiff";
import proj4 from "proj4";

const LAMBERT72 = "+proj=lcc +lat_0=90 +lon_0=4.367486666666666 +lat_1=51.16666723333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs";
const UTM31 = "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs";
proj4.defs("EPSG:31370", LAMBERT72);
proj4.defs("EPSG:32631", UTM31);

const GROUND = Object.freeze({ locked: 0, low: 1, sealed: 2, agriculture: 3, water: 4, bare: 5 });
const GROUND_NAMES = Object.freeze(["locked", "low", "sealed", "agriculture", "water", "bare"]);
const COEFFICIENTS = Object.freeze({ high: -7.42, low: -2.07, sealed: 3.2, bare: 6.7 });
const CHANNELS = Object.freeze({ sealed: 0, high: 1, low: 2, agriculture: 3, water: 4 });
const AFFECTED_THRESHOLD = 0.01;
const cancelled = new Set();
let runtime = null;
let lastResult = null;

function assetUrl(relative) { return new URL(relative, runtime.assetRoot).href; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function unpackState(value) {
  return { ground: value & 7, canopy: Boolean(value & 8), editable: Boolean(value & 16) };
}
function stateByte(state) {
  return state.ground | (state.canopy ? 8 : 0) | (state.editable ? 16 : 0);
}
function effectiveName(state) {
  if (state.canopy && [GROUND.low, GROUND.sealed, GROUND.bare].includes(state.ground)) return "high";
  return GROUND_NAMES[state.ground];
}
function modelChannel(state) {
  const name = effectiveName(state);
  return Object.hasOwn(CHANNELS, name) ? CHANNELS[name] : -1;
}
function applyOperation(state, baseline, operation) {
  if (operation.action === "restore") return { ...baseline };
  if (!state.editable) return state;
  if (operation.action === "convert-to-low") {
    if (state.ground === GROUND.sealed || state.ground === GROUND.bare) state.ground = GROUND.low;
  } else if (operation.action === "remove-high") state.canopy = false;
  else if (operation.target === "sealed" && [GROUND.low, GROUND.bare].includes(state.ground)) state.ground = GROUND.sealed;
  else if (operation.target === "high") state.canopy = true;
  return state;
}

function projectGeometry(geometry) {
  const projectRing = (ring) => ring.map((point) => proj4("EPSG:4326", "EPSG:31370", point));
  if (geometry?.type === "Polygon") return { type: "Polygon", coordinates: geometry.coordinates.map(projectRing) };
  if (geometry?.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map(projectRing)) };
  throw new Error("Scenario operations require Polygon or MultiPolygon geometry.");
}
function polygonsOf(geometry) { return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates; }
function ringArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  return area / 2;
}
function geometryArea(geometry) {
  return polygonsOf(geometry).reduce((sum, rings) => sum + Math.abs(ringArea(rings[0]))
    - rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0);
}
function geometryBounds(geometry) {
  const values = polygonsOf(geometry).flat(2);
  return values.reduce((bounds, point) => [
    Math.min(bounds[0], point[0]), Math.min(bounds[1], point[1]),
    Math.max(bounds[2], point[0]), Math.max(bounds[3], point[1]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index]; const [xj, yj] = ring[previous];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function contains(geometry, x, y) {
  return polygonsOf(geometry).some((rings) => pointInRing(x, y, rings[0])
    && !rings.slice(1).some((ring) => pointInRing(x, y, ring)));
}

function windowForBounds(bounds) {
  const [a, , c, , e, f] = runtime.manifest.sourceGrid.transform;
  const columnMinimum = clamp(Math.floor((bounds[0] - c) / a), 0, runtime.sourceWidth);
  const columnMaximum = clamp(Math.ceil((bounds[2] - c) / a), 0, runtime.sourceWidth);
  const rowMinimum = clamp(Math.floor((bounds[3] - f) / e), 0, runtime.sourceHeight);
  const rowMaximum = clamp(Math.ceil((bounds[1] - f) / e), 0, runtime.sourceHeight);
  return [columnMinimum, rowMinimum, columnMaximum, rowMaximum];
}
async function readBaseline(window) {
  const values = await runtime.baselineImage.readRasters({ window, samples: [0, 1, 2], interleave: true });
  return values;
}

function emptyAreaStats() {
  return {
    acceptedAreaHa: 0, ignoredAreaHa: 0, noChangeAreaHa: 0, outsideScopeAreaHa: 0,
    submittedAreaHa: 0, transitions: {},
    groundDeltaHa: { low: 0, sealed: 0, agriculture: 0, water: 0, bare: 0 },
    highCanopyDeltaHa: 0,
  };
}
function addArea(target, source) {
  for (const key of ["acceptedAreaHa", "ignoredAreaHa", "noChangeAreaHa", "outsideScopeAreaHa", "submittedAreaHa"]) target[key] += source[key] || 0;
  for (const [key, value] of Object.entries(source.transitions || {})) target.transitions[key] = (target.transitions[key] || 0) + value;
  for (const [key, value] of Object.entries(source.groundDeltaHa || {})) target.groundDeltaHa[key] += value;
  target.highCanopyDeltaHa += source.highCanopyDeltaHa || 0;
}
function roundedArea(stats) {
  const result = structuredClone(stats);
  for (const key of ["acceptedAreaHa", "ignoredAreaHa", "noChangeAreaHa", "outsideScopeAreaHa", "submittedAreaHa", "highCanopyDeltaHa"]) result[key] = Number((result[key] || 0).toFixed(4));
  for (const object of [result.transitions, result.groundDeltaHa]) Object.keys(object).forEach((key) => { object[key] = Number(object[key].toFixed(4)); });
  return result;
}

async function applyOperations(operations, requestId) {
  const touched = new Map();
  let submittedAreaM2 = 0;
  for (const raw of operations) {
    if (cancelled.has(requestId)) throw new DOMException("Cancelled", "AbortError");
    const operation = { ...raw, geometry: projectGeometry(raw.geometry) };
    submittedAreaM2 += geometryArea(operation.geometry);
    if (submittedAreaM2 > runtime.manifest.limits.submittedAreaHa * 10_000 + 1) throw new Error(`Scenario polygon area exceeds ${runtime.manifest.limits.submittedAreaHa} ha.`);
    const window = windowForBounds(geometryBounds(operation.geometry));
    if (window[2] <= window[0] || window[3] <= window[1]) continue;
    const data = await readBaseline(window);
    const width = window[2] - window[0]; const height = window[3] - window[1];
    const [a, , c, , e, f] = runtime.manifest.sourceGrid.transform;
    for (let localRow = 0; localRow < height; localRow += 1) {
      const row = window[1] + localRow; const y = f + (row + 0.5) * e;
      for (let localColumn = 0; localColumn < width; localColumn += 1) {
        const column = window[0] + localColumn; const x = c + (column + 0.5) * a;
        if (!contains(operation.geometry, x, y)) continue;
        const offset = (localRow * width + localColumn) * 3;
        const key = row * runtime.sourceWidth + column;
        let entry = touched.get(key);
        if (!entry) {
          const baseline = unpackState(data[offset]);
          entry = { row, column, baseline, current: { ...baseline }, sector: data[offset + 1], ua: data[offset + 2] };
          touched.set(key, entry);
        }
        entry.current = applyOperation({ ...entry.current }, entry.baseline, operation);
      }
    }
  }
  return { touched, submittedAreaM2 };
}

function gaussianKernel(sigma, radius) {
  const values = new Float64Array(radius * 2 + 1); let sum = 0;
  for (let offset = -radius; offset <= radius; offset += 1) { const value = Math.exp(-(offset * offset) / (2 * sigma * sigma)); values[offset + radius] = value; sum += value; }
  for (let index = 0; index < values.length; index += 1) values[index] /= sum;
  return values;
}
function convolveSeparable(values, width, height, kernel) {
  const radius = Math.floor(kernel.length / 2); const horizontal = new Float32Array(values.length); const output = new Float32Array(values.length);
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) { const sourceColumn = column + offset; if (sourceColumn >= 0 && sourceColumn < width) sum += values[row * width + sourceColumn] * kernel[offset + radius]; }
    horizontal[row * width + column] = sum;
  }
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) { const sourceRow = row + offset; if (sourceRow >= 0 && sourceRow < height) sum += horizontal[sourceRow * width + column] * kernel[offset + radius]; }
    output[row * width + column] = sum;
  }
  return output;
}

function radouxDelta(touched) {
  const mixtureWidth = Math.ceil(runtime.sourceWidth / 15); const mixtureHeight = Math.ceil(runtime.sourceHeight / 15);
  const mixture = new Float32Array(mixtureWidth * mixtureHeight); const active = new Set();
  touched.forEach((entry) => {
    const before = COEFFICIENTS[effectiveName(entry.baseline)]; const after = COEFFICIENTS[effectiveName(entry.current)];
    if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return;
    const index = Math.floor(entry.row / 15) * mixtureWidth + Math.floor(entry.column / 15);
    mixture[index] += (after - before) / 225; active.add(index);
  });
  const convolved = new Float32Array(mixture.length); const kernel = runtime.radouxKernel; const radius = 20;
  active.forEach((index) => {
    const sourceRow = Math.floor(index / mixtureWidth); const sourceColumn = index % mixtureWidth; const value = mixture[index];
    for (let dy = -radius; dy <= radius; dy += 1) {
      const row = sourceRow + dy; if (row < 0 || row >= mixtureHeight) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const column = sourceColumn + dx; if (column < 0 || column >= mixtureWidth) continue;
        convolved[row * mixtureWidth + column] += value * kernel[(dy + radius) * 41 + dx + radius];
      }
    }
  });
  const output = new Float32Array(runtime.outputWidth * runtime.outputHeight);
  for (let index = 0; index < output.length; index += 1) {
    if (!runtime.scopeIndex[index]) continue;
    const column = runtime.mixtureColumns[index]; const row = runtime.mixtureRows[index];
    const x0 = Math.floor(column); const y0 = Math.floor(row); const tx = column - x0; const ty = row - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= mixtureWidth || y0 + 1 >= mixtureHeight) continue;
    const top = convolved[y0 * mixtureWidth + x0] * (1 - tx) + convolved[y0 * mixtureWidth + x0 + 1] * tx;
    const bottom = convolved[(y0 + 1) * mixtureWidth + x0] * (1 - tx) + convolved[(y0 + 1) * mixtureWidth + x0 + 1] * tx;
    output[index] = top * (1 - ty) + bottom * ty;
  }
  return output;
}

async function gunzip(response) {
  if (!response.ok) throw new Error(`Scenario asset HTTP ${response.status}.`);
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decode the scenario model.");
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}
async function ensureXgboost() {
  if (runtime.xgboost) return runtime.xgboost;
  const contract = runtime.manifest.browserRuntime.xgboost;
  if (!contract) return null;
  const [buffer, model] = await Promise.all([
    fetch(assetUrl(contract.inferenceGridUrl)).then(gunzip),
    fetch(assetUrl(contract.modelUrl)).then((response) => response.json()),
  ]);
  const view = new DataView(buffer); const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  if (magic !== "GWXGB001") throw new Error("Unsupported XGBoost browser grid.");
  const count = view.getUint32(8, true); const featureCount = view.getUint32(12, true);
  const ringWidth = view.getUint32(16, true); const sigma = view.getUint32(20, true);
  let offset = 24;
  const positions = new Int32Array(buffer, offset, count * 4); offset += count * 4 * 4;
  const features = new Float32Array(buffer, offset, count * featureCount); offset += count * featureCount * 4;
  const predictions = new Float32Array(buffer, offset, count);
  runtime.xgboost = { count, featureCount, ringWidth, sigma, positions, features, predictions, model };
  return runtime.xgboost;
}
function evaluateModel(model, values) {
  let prediction = model.baseScore;
  for (const tree of model.trees) {
    let node = 0;
    while (tree.left[node] !== -1) {
      const value = values[tree.feature[node]];
      node = Number.isNaN(value) ? (tree.defaultLeft[node] ? tree.left[node] : tree.right[node])
        : value < tree.threshold[node] ? tree.left[node] : tree.right[node];
    }
    prediction += tree.threshold[node];
  }
  return prediction;
}
function buildChangeBuckets(touched) {
  const buckets = new Map(); const changed = [];
  touched.forEach((entry) => {
    if (stateByte(entry.baseline) === stateByte(entry.current)) return;
    const before = modelChannel(entry.baseline); const after = modelChannel(entry.current);
    if (before === after) return;
    const key = `${Math.floor(entry.row / 100)}:${Math.floor(entry.column / 100)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry); changed.push(entry);
  });
  return { buckets, changed };
}
function xgboostDelta(touched) {
  const xgb = runtime.xgboost; if (!xgb) return null;
  const { buckets } = buildChangeBuckets(touched);
  const raw = new Float32Array(runtime.outputWidth * runtime.outputHeight);
  const valid = new Float32Array(raw.length);
  const bandCount = 100 / xgb.ringWidth;
  const featureColumns = Array.from({ length: 5 }, () => new Int16Array(bandCount).fill(-1));
  xgb.model.featureNames.forEach((name, index) => {
    const match = name.match(/^(soil_sealing|high_green|low_green|agriculture|water)_(\d+)_(\d+)m$/);
    if (!match) return;
    const channel = { soil_sealing: 0, high_green: 1, low_green: 2, agriculture: 3, water: 4 }[match[1]];
    featureColumns[channel][Number(match[2]) / xgb.ringWidth] = index;
  });
  const denominators = runtime.ringDenominators[xgb.ringWidth]; let outside = 0;
  for (let rowIndex = 0; rowIndex < xgb.count; rowIndex += 1) {
    const positionOffset = rowIndex * 4; const outputRow = xgb.positions[positionOffset]; const outputColumn = xgb.positions[positionOffset + 1];
    const sourceRow = xgb.positions[positionOffset + 2]; const sourceColumn = xgb.positions[positionOffset + 3];
    valid[outputRow * runtime.outputWidth + outputColumn] = 1;
    const candidates = [];
    const bucketRow = Math.floor(sourceRow / 100); const bucketColumn = Math.floor(sourceColumn / 100);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) candidates.push(...(buckets.get(`${bucketRow + dy}:${bucketColumn + dx}`) || []));
    if (!candidates.length) continue;
    const values = xgb.features.slice(rowIndex * xgb.featureCount, (rowIndex + 1) * xgb.featureCount); let changed = false;
    for (const entry of candidates) {
      const dx = entry.column - sourceColumn + 0.5; const dy = entry.row - sourceRow + 0.5; const distance = Math.hypot(dx, dy);
      if (distance >= 100) continue;
      const band = Math.floor(distance / xgb.ringWidth); const before = modelChannel(entry.baseline); const after = modelChannel(entry.current);
      if (before === after) continue;
      if (before >= 0 && featureColumns[before][band] >= 0) values[featureColumns[before][band]] -= 1 / denominators[band];
      if (after >= 0 && featureColumns[after][band] >= 0) values[featureColumns[after][band]] += 1 / denominators[band];
      changed = true;
    }
    if (!changed) continue;
    for (let column = 0; column < values.length; column += 1) {
      const range = runtime.manifest.browserRuntime.xgboost.trainingRanges?.[xgb.model.featureNames[column]];
      if (range && (values[column] < range[0] || values[column] > range[1])) { outside += 1; break; }
    }
    raw[outputRow * runtime.outputWidth + outputColumn] = evaluateModel(xgb.model, values) - xgb.predictions[rowIndex];
  }
  if (!xgb.sigma) return { delta: raw, outside };
  const sigmaPixels = xgb.sigma / 30; const radius = Math.ceil(3 * sigmaPixels); const kernel = gaussianKernel(sigmaPixels, radius);
  const numerator = convolveSeparable(raw, runtime.outputWidth, runtime.outputHeight, kernel);
  const normalizer = convolveSeparable(valid, runtime.outputWidth, runtime.outputHeight, kernel);
  for (let index = 0; index < raw.length; index += 1) raw[index] = normalizer[index] > 0 ? numerator[index] / normalizer[index] : 0;
  return { delta: raw, outside };
}

function percentile(sorted, percentage) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentage; const lower = Math.floor(position); const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}
function deltaStatistics(values) {
  const selected = values.filter((value) => Math.abs(value) >= AFFECTED_THRESHOLD).sort((left, right) => left - right);
  if (!selected.length) return { affectedCellCount: 0, medianDeltaC: null, p10DeltaC: null, p90DeltaC: null, strongestCoolingC: null, strongestWarmingC: null, deltaDistribution: { affectedThresholdC: AFFECTED_THRESHOLD, affectedCellCount: 0, domainC: [0, 0], binWidthC: null, bins: [] } };
  const maximum = Math.max(Math.abs(selected[0]), Math.abs(selected[selected.length - 1]));
  const rawWidth = Math.max(2 * maximum / 30, Number.EPSILON); const exponent = Math.floor(Math.log10(rawWidth)); const base = 10 ** exponent;
  const width = [1, 2, 5, 10].map((value) => value * base).find((value) => value >= rawWidth); const domain = Math.ceil(maximum / width - 1e-12) * width;
  const binCount = Math.max(1, Math.round(2 * domain / width)); const counts = new Uint32Array(binCount);
  selected.forEach((value) => { counts[clamp(Math.floor((value + domain) / width), 0, binCount - 1)] += 1; });
  const cooling = selected.filter((value) => value < 0); const warming = selected.filter((value) => value > 0);
  return {
    affectedCellCount: selected.length, medianDeltaC: Number(percentile(selected, 0.5).toFixed(4)),
    p10DeltaC: Number(percentile(selected, 0.1).toFixed(4)), p90DeltaC: Number(percentile(selected, 0.9).toFixed(4)),
    minimumDeltaC: Number(selected[0].toFixed(4)), maximumDeltaC: Number(selected[selected.length - 1].toFixed(4)),
    strongestCoolingC: cooling.length ? Number(cooling[0].toFixed(4)) : null,
    strongestWarmingC: warming.length ? Number(warming[warming.length - 1].toFixed(4)) : null,
    deltaDistribution: { affectedThresholdC: AFFECTED_THRESHOLD, affectedCellCount: selected.length, domainC: [-domain, domain], binWidthC: width,
      bins: Array.from(counts, (count, index) => ({ lowerC: -domain + index * width, upperC: -domain + (index + 1) * width, count, sharePct: Number((count / selected.length * 100).toFixed(4)) })) },
  };
}

function attachBalance(stats, baseline) {
  const ground = {};
  for (const name of ["low", "sealed", "agriculture", "water", "bare"]) {
    const beforeHa = baseline?.groundBeforeHa?.[name] || 0; const changeHa = stats.groundDeltaHa[name] || 0;
    ground[name] = { beforeHa, changeHa: Number(changeHa.toFixed(4)), afterHa: Number((beforeHa + changeHa).toFixed(4)) };
  }
  const canopyBefore = baseline?.highCanopyBeforeHa || 0;
  stats.landCoverBalance = { ground, highCanopy: { beforeHa: canopyBefore, changeHa: stats.highCanopyDeltaHa, afterHa: Number((canopyBefore + stats.highCanopyDeltaHa).toFixed(4)) }, validAnalysedAreaHa: baseline?.validAnalysedAreaHa || 0, lockedUnavailableAreaHa: baseline?.lockedUnavailableAreaHa || 0 };
  return stats;
}
function buildScopes(delta, touched) {
  const sectorAreas = Array.from({ length: 155 }, () => emptyAreaStats());
  let inScopeTouched = 0;
  touched.forEach((entry) => {
    if (!entry.sector) return;
    inScopeTouched += 1; const stats = sectorAreas[entry.sector]; stats.submittedAreaHa += 0.0001;
    const changed = stateByte(entry.baseline) !== stateByte(entry.current);
    if (!entry.baseline.editable) stats.ignoredAreaHa += 0.0001;
    else if (!changed) stats.noChangeAreaHa += 0.0001;
    else {
      stats.acceptedAreaHa += 0.0001;
      if (entry.baseline.ground !== entry.current.ground) {
        stats.groundDeltaHa[GROUND_NAMES[entry.baseline.ground]] -= 0.0001;
        stats.groundDeltaHa[GROUND_NAMES[entry.current.ground]] += 0.0001;
      }
      if (entry.baseline.canopy !== entry.current.canopy) stats.highCanopyDeltaHa += entry.current.canopy ? 0.0001 : -0.0001;
      const before = effectiveName(entry.baseline); const after = effectiveName(entry.current);
      if (before !== after) stats.transitions[`${before}-to-${after}`] = (stats.transitions[`${before}-to-${after}`] || 0) + 0.0001;
    }
  });
  const sectorValues = Array.from({ length: 155 }, () => []);
  for (let index = 0; index < delta.length; index += 1) if (runtime.scopeIndex[index] && Math.abs(delta[index]) >= AFFECTED_THRESHOLD) sectorValues[runtime.scopeIndex[index]].push(delta[index]);
  const sectors = {}; const municipalities = {};
  for (let sector = 1; sector <= 154; sector += 1) {
    const metadata = runtime.manifest.browserRuntime.sectorIndex[String(sector)]; if (!metadata) continue;
    const stats = attachBalance({ ...roundedArea(sectorAreas[sector]), ...deltaStatistics(sectorValues[sector]) }, runtime.baselineStats.sectors[metadata.sectorId]);
    sectors[metadata.sectorId] = stats;
    if (!municipalities[metadata.municipality]) municipalities[metadata.municipality] = { area: emptyAreaStats(), values: [] };
    addArea(municipalities[metadata.municipality].area, sectorAreas[sector]); municipalities[metadata.municipality].values.push(...sectorValues[sector]);
  }
  for (const [municipality, entry] of Object.entries(municipalities)) municipalities[municipality] = attachBalance({ ...roundedArea(entry.area), ...deltaStatistics(entry.values) }, runtime.baselineStats.municipalities[municipality]);
  const regionArea = emptyAreaStats(); for (let sector = 1; sector <= 154; sector += 1) addArea(regionArea, sectorAreas[sector]);
  regionArea.outsideScopeAreaHa = Math.max(0, (touched.size - inScopeTouched) / 10_000);
  regionArea.submittedAreaHa = touched.size / 10_000;
  const region = attachBalance({ ...roundedArea(regionArea), ...deltaStatistics(Array.from(delta).filter((value) => Math.abs(value) >= AFFECTED_THRESHOLD)) }, runtime.baselineStats.region);
  return { region, municipalities, sectors };
}

async function simulate(payload, requestId) {
  if (!Array.isArray(payload.operations) || payload.operations.length > runtime.manifest.limits.operations) throw new Error("Invalid scenario operations.");
  const { touched } = await applyOperations(payload.operations, requestId);
  const radoux = radouxDelta(touched); let xgboost = null; let xgboostError = null;
  try { await ensureXgboost(); xgboost = xgboostDelta(touched); } catch (error) { xgboostError = error.message; }
  const radouxScopes = buildScopes(radoux, touched);
  const deltas = { radoux };
  const scopes = { radoux: radouxScopes };
  const diagnostics = { radoux: { method: "radoux-linear-mixture" } };
  if (xgboost) { deltas.xgboost = xgboost.delta; scopes.xgboost = buildScopes(xgboost.delta, touched); diagnostics.xgboost = { method: "xgboost-2026", outsideTrainingRangeCellCount: xgboost.outside }; }
  else diagnostics.xgboost = { method: "xgboost-2026", unavailable: true, error: xgboostError };
  const deltaRasters = Object.fromEntries(Object.entries(deltas).map(([method, values]) => [method, { values: values.buffer, width: runtime.outputWidth, height: runtime.outputHeight, coordinates: runtime.manifest.outputGrid.coordinates, affectedThresholdC: AFFECTED_THRESHOLD }]));
  lastResult = { revision: payload.revision, operations: payload.operations, touched, deltas, scopes };
  return { schemaVersion: 7, sessionId: payload.sessionId, revision: payload.revision, deltaRasters, scopeStats: radouxScopes, scopeStatsByMethod: scopes, diagnosticsByMethod: diagnostics };
}

async function inspect(payload) {
  if (!lastResult || payload.revision !== lastResult.revision) throw new Error("The requested scenario revision is not active.");
  const [x, y] = proj4("EPSG:4326", "EPSG:31370", [payload.lng, payload.lat]); const window = windowForBounds([x, y, x + 0.01, y + 0.01]);
  if (window[2] <= window[0] || window[3] <= window[1]) return { status: "outside" };
  const data = await readBaseline([window[0], window[1], window[0] + 1, window[1] + 1]); const key = window[1] * runtime.sourceWidth + window[0];
  const ua = data[2]; const uaCode = runtime.uaCodes[ua] || null;
  const [outputX, outputY] = proj4("EPSG:31370", "EPSG:32631", [x, y]); const [a, , c, , e, f] = runtime.manifest.outputGrid.transform;
  const column = Math.floor((outputX - c) / a); const row = Math.floor((outputY - f) / e); const index = row * runtime.outputWidth + column;
  const deltaCByMethod = {};
  for (const [method, values] of Object.entries(lastResult.deltas)) if (index >= 0 && index < values.length) deltaCByMethod[method] = values[index];
  return { status: "available", urbanAtlasClassCode: uaCode, deltaCByMethod, state: lastResult.touched.get(key) || null };
}

async function initialize(payload) {
  const manifest = payload.manifest;
  if (manifest.schemaVersion !== 7 || !manifest.browserRuntime?.baseline?.url) throw new Error("Unsupported public scenario manifest.");
  const tiff = await fromUrl(new URL(manifest.browserRuntime.baseline.url, payload.assetRoot).href, { cacheSize: 100 });
  const baselineImage = await tiff.getImage();
  const scopeBuffer = await fetch(new URL(manifest.browserRuntime.outputScopes.url, payload.assetRoot).href).then(gunzip);
  const scopeView = new DataView(scopeBuffer); const scopeMagic = new TextDecoder().decode(new Uint8Array(scopeBuffer, 0, 8));
  if (scopeMagic !== "GWSCOPE1") throw new Error("Unsupported scenario scope index.");
  const outputHeight = scopeView.getUint32(8, true); const outputWidth = scopeView.getUint32(12, true); const scopeIndex = new Uint8Array(scopeBuffer, 20);
  const baselineStats = await fetch(new URL(manifest.baselineAreaStatistics.url, payload.assetRoot).href).then((response) => response.json());
  const mixtureRows = new Float32Array(outputWidth * outputHeight); const mixtureColumns = new Float32Array(outputWidth * outputHeight);
  const [outputA, , outputC, , outputE, outputF] = manifest.outputGrid.transform; const [sourceA, , sourceC, , sourceE, sourceF] = manifest.sourceGrid.transform;
  for (let row = 0; row < outputHeight; row += 1) for (let column = 0; column < outputWidth; column += 1) {
    const [x, y] = proj4("EPSG:32631", "EPSG:31370", [outputC + (column + 0.5) * outputA, outputF + (row + 0.5) * outputE]); const index = row * outputWidth + column;
    mixtureColumns[index] = (x - sourceC) / (sourceA * 15) - 0.5; mixtureRows[index] = (y - sourceF) / (sourceE * 15) - 0.5;
  }
  const sigmaPixels = manifest.psf.sigmaMeters / manifest.psf.gridResolutionMeters; const oneDimensional = gaussianKernel(sigmaPixels, 20); const radouxKernel = new Float64Array(41 * 41);
  for (let row = 0; row < 41; row += 1) for (let column = 0; column < 41; column += 1) radouxKernel[row * 41 + column] = oneDimensional[row] * oneDimensional[column];
  const ringDenominators = {};
  for (const width of [5, 10, 20, 25]) {
    const values = new Uint32Array(100 / width);
    for (let dy = -100; dy < 100; dy += 1) for (let dx = -100; dx < 100; dx += 1) { const distance = Math.hypot(dx + 0.5, dy + 0.5); if (distance < 100) values[Math.floor(distance / width)] += 1; }
    ringDenominators[width] = values;
  }
  runtime = { manifest, assetRoot: payload.assetRoot, baselineImage, baselineStats, sourceWidth: manifest.sourceGrid.width, sourceHeight: manifest.sourceGrid.height, outputWidth, outputHeight, scopeIndex, mixtureRows, mixtureColumns, radouxKernel, ringDenominators, xgboost: null };
  runtime.uaCodes = Object.fromEntries(Object.entries(manifest.urbanAtlasClassIndexes).map(([code, index]) => [index, code]));
  return { ready: true, methods: manifest.methodOrder };
}

globalThis.addEventListener("message", async ({ data }) => {
  const { command, requestId, payload } = data || {};
  if (command === "cancel") { cancelled.add(requestId); return; }
  try {
    const result = command === "init" ? await initialize(payload)
      : command === "simulate" ? await simulate(payload, requestId)
        : command === "inspect" ? await inspect(payload) : (() => { throw new Error("Unknown scenario worker command."); })();
    if (cancelled.has(requestId)) return;
    // Keep the worker's analytical arrays alive for exact pointer inspection.
    // The 30 m fields are small enough to clone without a second runtime asset.
    globalThis.postMessage({ requestId, result });
  } catch (error) {
    if (error.name !== "AbortError") globalThis.postMessage({ requestId, error: error.message || String(error) });
  } finally { cancelled.delete(requestId); }
});
