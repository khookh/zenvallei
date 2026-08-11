"""Prepare Landsat surface temperature against the uniform 2019 population model."""

from __future__ import annotations

import gzip
import json

import geopandas as gpd
import numpy as np
import rasterio

from .constants import CACHE_ROOT, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .groenkaart_population import POPULATION_RASTER
from .exact_landsat_mask import MINIMUM_ANALYSED_AREA_M2, SOIL_SEALED, prepare_exact_mask_table
from .landsat import EXPECTED_SELECTED_OBSERVATIONS, _read_analysis
from .landsat_jaarbak import YEAR_BY_OBSERVATION
from .pipeline import file_hash, update_index
from .sealed_urban_comparisons import (
    LANDSAT_GREEN_SURFACE_GROUPS,
    _coordinates, _exact_group_indexes,
    _prepare_urban_atlas_class_mask,
    _sector_metadata,
)

OUTPUT_ROOT = CACHE_ROOT / "landsat-population"
MINIMUM_ANALYSED_AREA_HA = MINIMUM_ANALYSED_AREA_M2 / 10_000


def prepare_landsat_population():
    if not POPULATION_RASTER.exists():
        raise FileNotFoundError("Run pnpm population:prepare before Landsat-population preparation.")
    landsat_path = CACHE_ROOT / "landsat-temperature" / "manifest.json"
    landsat = json.loads(landsat_path.read_text(encoding="utf-8"))
    observation_ids = tuple(item["value"] for item in landsat["timelineItems"])
    if observation_ids != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("The six selected Landsat observations are not current.")
    _, _, _, grid = _read_analysis(
        CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_ids[0]}.tif"
    )
    sectors = gpd.read_file(SECTORS_PATH).to_crs(grid["crs"])
    sector_meta = _sector_metadata(sectors)

    with rasterio.open(POPULATION_RASTER) as source:
        population = source.read(1).astype(np.float64)
        population[population == source.nodata] = np.nan
        population_grid = {
            "transform": source.transform, "width": source.width, "height": source.height, "crs": source.crs,
        }
    if str(population_grid["crs"]) != "EPSG:31370" or abs(population_grid["transform"].a - 100) > 1e-6:
        raise ValueError("The Flanders population model must remain an EPSG:31370 100 m raster.")
    observations = {}
    for observation_id in observation_ids:
        year = YEAR_BY_OBSERVATION[observation_id]
        exact = prepare_exact_mask_table(observation_id, year)
        groups = _exact_group_indexes(exact)
        temperatures = exact.temperature[exact.landsat - 1]
        group_areas = []
        group_temperature_sums = []
        group_landsat_ids = []
        for group_index in range(1, len(LANDSAT_GREEN_SURFACE_GROUPS) + 1):
            eligible = ((groups == group_index) & (exact.soil == SOIL_SEALED)
                        & (exact.status == 1) & (exact.population > 0)
                        & np.isfinite(temperatures))
            # Preserve sector-boundary pieces. The browser reunites identical
            # population cells after applying its active administrative scope.
            keys = exact.sector[eligible].astype(np.int64) * (population.size + 1) + exact.population[eligible]
            unique, inverse = np.unique(keys, return_inverse=True)
            areas = np.bincount(inverse, weights=exact.area_m2[eligible], minlength=len(unique))
            sums = np.bincount(
                inverse, weights=temperatures[eligible] * exact.area_m2[eligible], minlength=len(unique),
            )
            land_sets = {}
            for record, parent in zip(inverse, exact.landsat[eligible]):
                land_sets.setdefault(int(record), set()).add(int(parent))
            group_areas.append((unique, areas))
            group_temperature_sums.append((unique, sums))
            group_landsat_ids.append((unique, [
                sorted(land_sets.get(index, ())) for index in range(len(unique))
            ]))
        all_keys = np.unique(np.concatenate([item[0] for item in group_areas]))
        records = []
        for key in all_keys:
            sector_number, population_one_based = divmod(int(key), population.size + 1)
            flat = population_one_based - 1
            row, column = divmod(flat, population_grid["width"])
            density = population[row, column]
            if not np.isfinite(density) or sector_number not in sector_meta:
                continue
            metadata = sector_meta[sector_number]
            group_records = []
            for index in range(len(LANDSAT_GREEN_SURFACE_GROUPS)):
                keys, areas = group_areas[index]
                position = int(np.searchsorted(keys, key))
                if position >= len(keys) or keys[position] != key:
                    group_records.append([0, 0.0, []])
                else:
                    group_records.append([
                        int(round(areas[position])),
                        round(float(group_temperature_sums[index][1][position]), 6),
                        group_landsat_ids[index][1][position],
                    ])
            records.append([
                metadata["sectorId"], row, column, round(float(density), 5),
                *group_records,
            ])
        statistics_path = OUTPUT_ROOT / "cells" / f"{observation_id}.json.gz"
        statistics_path.parent.mkdir(parents=True, exist_ok=True)
        statistics_payload = json.dumps({
            "schemaVersion": 3, "observationId": observation_id, "cells": records,
        }, separators=(",", ":")).encode("utf-8")
        statistics_path.write_bytes(gzip.compress(statistics_payload, compresslevel=9, mtime=0))
        display_path = CACHE_ROOT / "shared" / "landsat-display" / f"{observation_id}.png"
        observations[observation_id] = {
            "jaarbakYear": year,
            "displayDataUrl": f"shared/landsat-display/{observation_id}.png",
            "statisticsUrl": f"landsat-population/cells/{observation_id}.json.gz",
            "displayDataSha256": file_hash(display_path),
            "statisticsSha256": file_hash(statistics_path),
            "cellCount": len(records),
        }

    population_payload = json.loads(
        (PROJECT_ROOT / "public" / "data" / "population.json").read_text(encoding="utf-8")
    )
    urban_mask = _prepare_urban_atlas_class_mask()
    manifest = {
        "schemaVersion": 3,
        "comparisonId": "landsat-population",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "population",
        "populationDatasetId": "flanders-2019",
        "populationYear": 2019,
        "populationResolutionMeters": 100,
        "urbanAtlasYear": 2021,
        "urbanSurfaceGroups": [
            {"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
            for group in LANDSAT_GREEN_SURFACE_GROUPS
        ],
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
        "minimumAnalysedAreaHa": MINIMUM_ANALYSED_AREA_HA,
        "cellEncoding": ["sectorId", "row", "column", "populationDensityPerHa", "residential[areaM2,temperatureAreaSum,landsatIndexes]", "employmentInstitutional[areaM2,temperatureAreaSum,landsatIndexes]"],
        "maskResolutionMeters": 1,
        "temperatureResolutionMeters": 30,
        "aggregation": "exact-masked-area",
        "analysisResolutionMeters": 30,
        "displayResolutionMeters": 1,
        "coordinates": _coordinates(grid),
        "imageSize": [grid["width"], grid["height"]],
        "sectorMunicipalities": {item["sectorId"]: item["municipality"] for item in sector_meta.values()},
        "urbanAtlasClassMaskUrl": urban_mask["url"],
        "urbanAtlasClassMaskSha256": urban_mask["sha256"],
        "urbanAtlasClassIndexes": urban_mask["classIndexes"],
        "observations": observations,
        "populationSourceSha256": population_payload["datasets"]["flanders-2019"]["source"]["rasterSha256"],
    }
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    update_index()
    return manifest
