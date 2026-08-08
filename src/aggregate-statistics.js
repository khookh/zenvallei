const round = (value, digits = 2) => Number(value.toFixed(digits));

function sectorIdsByMunicipality(scores) {
  const groups = new Map();
  Object.values(scores).forEach((record) => {
    if (!groups.has(record.municipality)) groups.set(record.municipality, []);
    groups.get(record.municipality).push(record.sectorId);
  });
  return groups;
}

function sum(records, key) {
  return records.reduce((total, record) => total + Number(record?.[key] ?? 0), 0);
}

function percentage(area, denominator) {
  return denominator > 0 ? round(area / denominator * 100) : 0;
}

function classAreas(records, collections) {
  const areas = new Map();
  records.forEach((record) => collections(record).flat().forEach((entry) => {
    areas.set(String(entry.code), (areas.get(String(entry.code)) ?? 0) + Number(entry.areaHa ?? 0));
  }));
  return areas;
}

function _aggregateLandCover(records) {
  const classifiedAreaHa = sum(records, "classifiedAreaHa");
  const areas = classAreas(records, (record) => record.classes ?? []);
  const classes = [...areas.entries()]
    .map(([code, areaHa]) => ({ code: Number(code), areaHa: round(areaHa), percentage: percentage(areaHa, classifiedAreaHa) }))
    .sort((left, right) => right.areaHa - left.areaHa || left.code - right.code);
  const vegetationAreaHa = sum(records, "vegetationAreaHa");
  const builtUpAreaHa = sum(records, "builtUpAreaHa");
  return {
    totalAreaHa: round(sum(records, "totalAreaHa")),
    classifiedAreaHa: round(classifiedAreaHa),
    unclassifiableAreaHa: round(sum(records, "unclassifiableAreaHa")),
    vegetationAreaHa: round(vegetationAreaHa),
    vegetationPercentage: percentage(vegetationAreaHa, classifiedAreaHa),
    builtUpAreaHa: round(builtUpAreaHa),
    builtUpPercentage: percentage(builtUpAreaHa, classifiedAreaHa),
    dominantClassCode: classes[0]?.code ?? null,
    classes,
  };
}

function metricClasses(codes, areas, denominator, metricArea) {
  return codes.map((code) => {
    const areaHa = areas.get(String(code)) ?? 0;
    return {
      code: String(code),
      areaHa: round(areaHa, 4),
      sectorPercentage: percentage(areaHa, denominator),
      metricPercentage: percentage(areaHa, metricArea),
    };
  });
}

function aggregateUrbanAtlas(records, urbanAtlas) {
  const validAreaHa = sum(records, "validAreaHa");
  const greenCodes = urbanAtlas.greenCodes ?? urbanAtlas.metricDefinitions?.green?.classCodes
    ?? [...new Set(records.flatMap((record) => (record.green?.classes ?? []).map((entry) => String(entry.code))))];
  const artificialCodes = urbanAtlas.artificialCodes ?? urbanAtlas.metricDefinitions?.artificial?.classCodes
    ?? [...new Set(records.flatMap((record) => (record.artificial?.classes ?? []).map((entry) => String(entry.code))))];
  const areas = classAreas(records, (record) => [
    record.green?.classes ?? [], record.artificial?.classes ?? [], record.otherClasses ?? [],
  ]);
  const greenAreaHa = [...greenCodes].reduce((total, code) => total + (areas.get(String(code)) ?? 0), 0);
  const artificialAreaHa = [...artificialCodes].reduce((total, code) => total + (areas.get(String(code)) ?? 0), 0);
  const excludedCodes = new Set([...greenCodes, ...artificialCodes].map(String));
  const otherClasses = [...areas.entries()]
    .filter(([code, areaHa]) => !excludedCodes.has(code) && areaHa > 0)
    .map(([code, areaHa]) => ({ code, areaHa: round(areaHa, 4), sectorPercentage: percentage(areaHa, validAreaHa) }))
    .sort((left, right) => right.areaHa - left.areaHa || left.code.localeCompare(right.code));
  const dominant = [...areas.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  return {
    sectorAreaHa: round(sum(records, "sectorAreaHa"), 4),
    processedAreaHa: round(sum(records, "processedAreaHa"), 4),
    validAreaHa: round(validAreaHa, 4),
    noDataAreaHa: round(sum(records, "noDataAreaHa"), 4),
    coveragePercentage: percentage(validAreaHa, sum(records, "sectorAreaHa")),
    dominantClassCode: dominant?.[0] ?? null,
    green: {
      areaHa: round(greenAreaHa, 4),
      percentage: percentage(greenAreaHa, validAreaHa),
      classes: metricClasses(greenCodes, areas, validAreaHa, greenAreaHa),
    },
    artificial: {
      areaHa: round(artificialAreaHa, 4),
      percentage: percentage(artificialAreaHa, validAreaHa),
      classes: metricClasses(artificialCodes, areas, validAreaHa, artificialAreaHa),
    },
    otherClasses,
  };
}

function _aggregateVegetation(records) {
  const sectorAreaHa = sum(records, "sectorAreaHa");
  const validAreaHa = sum(records, "validAreaHa");
  const likelyAreaHa = sum(records, "likelyVegetatedAreaHa");
  const belowAreaHa = sum(records, "belowThresholdAreaHa");
  const croplandAreaHa = sum(records, "excludedCroplandAreaHa") || sum(records, "excludedArableAreaHa");
  const waterAreaHa = sum(records, "excludedWaterAreaHa");
  const weightedMedian = records.reduce((total, record) => total + Number(record.medianNdvi ?? 0) * Number(record.validAreaHa ?? 0), 0);
  return {
    sectorAreaHa: round(sectorAreaHa),
    validAreaHa: round(validAreaHa),
    likelyVegetatedAreaHa: round(likelyAreaHa),
    likelyVegetatedPercentage: percentage(likelyAreaHa, sectorAreaHa),
    belowThresholdAreaHa: round(belowAreaHa),
    belowThresholdPercentage: percentage(belowAreaHa, sectorAreaHa),
    excludedCroplandAreaHa: round(croplandAreaHa),
    excludedCroplandPercentage: percentage(croplandAreaHa, sectorAreaHa),
    excludedWaterAreaHa: round(waterAreaHa),
    excludedWaterPercentage: percentage(waterAreaHa, sectorAreaHa),
    missingObservationAreaHa: round(sum(records, "missingObservationAreaHa")),
    medianNdvi: validAreaHa > 0 ? round(weightedMedian / validAreaHa, 3) : null,
    medianIsAreaWeightedApproximation: true,
  };
}

// Deprecated aggregators are retained only to make the retired experiments
// reproducible. They are not exported or reachable from the active registry.
void _aggregateLandCover;
void _aggregateVegetation;

/** Add area-weighted municipality summaries without changing source records. */
export function addMunicipalityStatistics({ scores, urbanAtlas }) {
  const groups = sectorIdsByMunicipality(scores);
  if (urbanAtlas?.sectorStats) {
    urbanAtlas.municipalityStats = Object.fromEntries([...groups].map(([municipality, ids]) => [
      municipality, aggregateUrbanAtlas(ids.map((id) => urbanAtlas.sectorStats[id]).filter(Boolean), urbanAtlas),
    ]));
    urbanAtlas.regionStats = aggregateUrbanAtlas(Object.values(urbanAtlas.sectorStats), urbanAtlas);
  }
}
