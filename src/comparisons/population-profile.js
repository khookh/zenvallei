/**
 * Build cumulative resident-share bands from uniform 1 ha population cells.
 * Equal population-density values are kept together, so displayed bands can
 * cross the nominal 10% boundary. Small neighbouring bands are merged.
 */
export function summarizeResidentProfile(records, {
  valueKey,
  populationKey = "populationDensityPerHa",
  minimumCells = 5,
  minimumPositiveCells = 10,
} = {}) {
  const valid = records.filter((record) => (
    Number.isFinite(record?.[populationKey])
    && record[populationKey] >= 0
    && Number.isFinite(record?.[valueKey])
  ));
  const zeroPopulationCount = valid.filter((record) => record[populationKey] === 0).length;
  const points = valid.filter((record) => record[populationKey] > 0)
    .sort((left, right) => left[populationKey] - right[populationKey]
      || String(left.cellId ?? "").localeCompare(String(right.cellId ?? "")));
  const totalResidents = points.reduce((sum, point) => sum + point[populationKey], 0);
  const weightedMean = totalResidents > 0
    ? points.reduce((sum, point) => sum + point[valueKey] * point[populationKey], 0) / totalResidents
    : null;
  if (points.length < minimumPositiveCells || totalResidents <= 0) {
    return { points, bands: [], sufficient: false, totalResidents, zeroPopulationCount, weightedMean };
  }

  const tied = [];
  points.forEach((point) => {
    const density = point[populationKey];
    const current = tied.at(-1);
    if (!current || current.density !== density) tied.push({ density, points: [point] });
    else current.points.push(point);
  });

  const rawBands = [];
  let current = [];
  let residentsBefore = 0;
  let nextTarget = totalResidents * .1;
  tied.forEach((tie, tieIndex) => {
    current.push(...tie.points);
    const residents = current.reduce((sum, point) => sum + point[populationKey], 0);
    const isLast = tieIndex === tied.length - 1;
    if (residentsBefore + residents >= nextTarget || isLast) {
      rawBands.push(current);
      residentsBefore += residents;
      current = [];
      while (nextTarget <= residentsBefore && nextTarget < totalResidents) nextTarget += totalResidents * .1;
    }
  });

  // Merge undersized adjacent bands. Prefer the following band so the
  // cumulative order remains intuitive; merge a small final band backwards.
  const merged = [];
  rawBands.forEach((band) => {
    if (merged.length && merged.at(-1).length < minimumCells) merged.at(-1).push(...band);
    else merged.push([...band]);
  });
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index].length >= minimumCells || merged.length === 1) continue;
    if (index + 1 < merged.length) {
      merged[index + 1].unshift(...merged[index]);
      merged.splice(index, 1);
      index -= 1;
    } else {
      merged[index - 1].push(...merged[index]);
      merged.splice(index, 1);
      index -= 1;
    }
  }

  let cumulativeResidents = 0;
  const bands = merged.map((band, index) => {
    const residents = band.reduce((sum, point) => sum + point[populationKey], 0);
    const startShare = cumulativeResidents / totalResidents * 100;
    cumulativeResidents += residents;
    return {
      index: index + 1,
      minimum: band[0][populationKey],
      maximum: band.at(-1)[populationKey],
      startShare,
      endShare: cumulativeResidents / totalResidents * 100,
      residents,
      count: band.length,
      weightedMean: band.reduce((sum, point) => sum + point[valueKey] * point[populationKey], 0) / residents,
      contributingCount: band.reduce((sum, point) => sum + Number(point.contributingCount ?? 0), 0),
    };
  });
  return { points, bands, sufficient: bands.length > 0, totalResidents, zeroPopulationCount, weightedMean };
}

/**
 * Summarise one-hour population cells as a hottest-to-coolest resident curve
 * and fixed 0.5 C resident histogram. Population is a model weight, while one
 * temperature is the exact-mask-area-weighted mean of the contributing native
 * 30 m Landsat observations in that 1 ha cell.
 */
export function summarizePopulationTemperature(records, { binWidth = 0.5 } = {}) {
  const valid = records.filter((record) => Number.isFinite(record?.populationDensityPerHa)
    && record.populationDensityPerHa >= 0 && Number.isFinite(record?.temperature)
    && Number(record.analysedAreaHa) >= 0.1);
  const zeroPopulationCount = valid.filter((record) => record.populationDensityPerHa === 0).length;
  const points = valid.filter((record) => record.populationDensityPerHa > 0)
    .sort((left, right) => right.temperature - left.temperature
      || String(left.cellId ?? "").localeCompare(String(right.cellId ?? "")));
  const totalResidents = points.reduce((sum, point) => sum + point.populationDensityPerHa, 0);
  const totalMeasurements = points.reduce((sum, point) => sum + point.contributingCount, 0);
  const weightedMean = totalResidents > 0
    ? points.reduce((sum, point) => sum + point.temperature * point.populationDensityPerHa, 0) / totalResidents
    : null;
  const byBin = new Map();
  points.forEach((point) => {
    const lower = Math.floor(point.temperature / binWidth) * binWidth;
    const key = lower.toFixed(4);
    const bin = byBin.get(key) ?? {
      lower, upper: lower + binWidth, residents: 0, cellCount: 0, contributingCount: 0,
    };
    bin.residents += point.populationDensityPerHa;
    bin.cellCount += 1;
    bin.contributingCount += point.contributingCount;
    byBin.set(key, bin);
  });
  const bins = [...byBin.values()].sort((left, right) => left.lower - right.lower)
    .map((bin) => ({ ...bin, share: totalResidents > 0 ? bin.residents / totalResidents * 100 : 0 }));
  let cumulativeResidents = 0;
  const curve = [];
  for (let start = 0; start < points.length;) {
    let end = start + 1;
    while (end < points.length && points[end].temperature === points[start].temperature) end += 1;
    const tiedResidents = points.slice(start, end)
      .reduce((sum, point) => sum + point.populationDensityPerHa, 0);
    const atOrAboveResidents = cumulativeResidents + tiedResidents;
    for (let index = start; index < end; index += 1) {
      const point = points[index];
      cumulativeResidents += point.populationDensityPerHa;
      const binLower = Math.floor(point.temperature / binWidth) * binWidth;
      const bin = byBin.get(binLower.toFixed(4));
      curve.push({
        ...point,
        cumulativeResidents,
        atOrAboveResidents,
        atOrAboveShare: totalResidents ? atOrAboveResidents / totalResidents * 100 : 0,
        coolerResidents: totalResidents - atOrAboveResidents,
        coolerShare: totalResidents ? (totalResidents - atOrAboveResidents) / totalResidents * 100 : 0,
        atOrAboveCellCount: end,
        coolerCellCount: points.length - end,
        intervalLower: binLower,
        intervalUpper: binLower + binWidth,
        intervalResidents: bin?.residents ?? 0,
        intervalCellCount: bin?.cellCount ?? 0,
        intervalContributingCount: bin?.contributingCount ?? 0,
      });
    }
    start = end;
  }
  return {
    points, curve, bins, totalResidents, totalMeasurements, zeroPopulationCount, weightedMean,
    temperatureMinimum: points.length ? points.at(-1).temperature : null,
    temperatureMaximum: points.length ? points[0].temperature : null,
  };
}

/**
 * Build a resident-weighted cumulative curve and fixed distribution for a
 * bounded percentage measured once per uniform 1 ha population-model cell.
 * Population is a weight, not a second observation, and equal values stay on
 * one cumulative step so threshold readouts remain deterministic.
 */
export function summarizePopulationPercentage(records, {
  valueKey,
  populationKey = "populationDensityPerHa",
  binWidth = 5,
  direction = "ascending",
} = {}) {
  if (!valueKey || !Number.isFinite(binWidth) || binWidth <= 0 || 100 % binWidth !== 0) {
    throw new TypeError("A percentage value key and an exact divisor of 100 are required.");
  }
  if (!new Set(["ascending", "descending"]).has(direction)) {
    throw new TypeError("Population percentage direction must be ascending or descending.");
  }
  const valid = records.filter((record) => Number.isFinite(record?.[populationKey])
    && record[populationKey] >= 0 && Number.isFinite(record?.[valueKey]))
    .map((record) => ({ ...record, [valueKey]: Math.max(0, Math.min(100, record[valueKey])) }));
  const zeroPopulationCount = valid.filter((record) => record[populationKey] === 0).length;
  const sign = direction === "ascending" ? 1 : -1;
  const points = valid.filter((record) => record[populationKey] > 0)
    .sort((left, right) => sign * (left[valueKey] - right[valueKey])
      || String(left.cellId ?? "").localeCompare(String(right.cellId ?? "")));
  const totalResidents = points.reduce((sum, point) => sum + point[populationKey], 0);
  const weightedMean = totalResidents > 0
    ? points.reduce((sum, point) => sum + point[valueKey] * point[populationKey], 0) / totalResidents
    : null;
  const binCount = 100 / binWidth;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index * binWidth,
    upper: (index + 1) * binWidth,
    residents: 0,
    cellCount: 0,
    analysedAreaHa: 0,
  }));
  points.forEach((point) => {
    const index = Math.min(binCount - 1, Math.floor(point[valueKey] / binWidth));
    bins[index].residents += point[populationKey];
    bins[index].cellCount += 1;
    bins[index].analysedAreaHa += Number(point.analysedAreaHa ?? 0);
  });
  bins.forEach((bin) => { bin.share = totalResidents ? bin.residents / totalResidents * 100 : 0; });

  let cumulativeResidents = 0;
  const curve = [];
  for (let start = 0; start < points.length;) {
    let end = start + 1;
    while (end < points.length && points[end][valueKey] === points[start][valueKey]) end += 1;
    const tied = points.slice(start, end);
    const tiedResidents = tied.reduce((sum, point) => sum + point[populationKey], 0);
    const selectedResidents = cumulativeResidents + tiedResidents;
    const value = points[start][valueKey];
    const binIndex = Math.min(binCount - 1, Math.floor(value / binWidth));
    tied.forEach((point) => {
      cumulativeResidents += point[populationKey];
      curve.push({
        ...point,
        value,
        cumulativeResidents,
        selectedResidents,
        selectedShare: totalResidents ? selectedResidents / totalResidents * 100 : 0,
        remainingResidents: totalResidents - selectedResidents,
        remainingShare: totalResidents ? (totalResidents - selectedResidents) / totalResidents * 100 : 0,
        selectedCellCount: end,
        remainingCellCount: points.length - end,
        intervalLower: bins[binIndex].lower,
        intervalUpper: bins[binIndex].upper,
        intervalResidents: bins[binIndex].residents,
        intervalCellCount: bins[binIndex].cellCount,
        intervalAnalysedAreaHa: bins[binIndex].analysedAreaHa,
      });
    });
    start = end;
  }
  return {
    points, curve, bins, direction, totalResidents, zeroPopulationCount, weightedMean,
    valueMinimum: points.length ? Math.min(...points.map((point) => point[valueKey])) : null,
    valueMaximum: points.length ? Math.max(...points.map((point) => point[valueKey])) : null,
  };
}
