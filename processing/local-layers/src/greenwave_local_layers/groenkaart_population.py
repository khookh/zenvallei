"""Prepare Green Map surrounding cover against the uniform 2019 population model."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, bounds as window_bounds
from shapely.geometry import box

from .constants import CACHE_ROOT, GROENKAART_CLASSES, PROJECT_ROOT, SECTORS_PATH
from .density import ANALYSIS_RESOLUTION
from .pipeline import file_hash, update_index
from .sealed_urban_comparisons import (
    DEFAULT_GREEN_CLASSES,
    GREEN_CLASS_CODES,
    MINIMUM_GREEN_INCOME_AREA_HA,
    MINIMUM_NATIVE_JAARBAK_COVERAGE,
    LANDSAT_GREEN_SURFACE_GROUPS,
    _coordinates,
    _green_density_10m,
    _prepare_urban_atlas_class_mask,
)

OUTPUT_ROOT = CACHE_ROOT / "groenkaart-population"
POPULATION_RASTER = PROJECT_ROOT / "public" / "data" / "population" / "population-density-2019.tif"
POPULATION_MANIFEST = PROJECT_ROOT / "public" / "data" / "population.json"


def compact_cell_record(metadata, row, column, population_density, group_pixels, group_weighted):
    """Return one published 100 m observation or None below the 0.10 ha rule."""
    minimum_pixels = int(round(MINIMUM_GREEN_INCOME_AREA_HA * 10_000))
    # Keep the small pure helper compatible with single-group fixtures while
    # the production contract always supplies both explicit Urban Atlas groups.
    if np.isscalar(group_pixels):
        group_pixels = [group_pixels]
        group_weighted = [group_weighted]
    pixel_count = int(sum(group_pixels))
    if not np.isfinite(population_density) or pixel_count < minimum_pixels:
        return None
    weighted_density = np.sum(np.asarray(group_weighted), axis=0)
    return {
        "s": metadata["sectorId"], "r": row, "c": column,
        "p": round(float(population_density), 5), "a": round(pixel_count * .0001, 4),
        "g": [round(float(value / pixel_count), 5) for value in weighted_density],
        "u": [
            [int(count), *[round(float(value), 5) for value in weighted]]
            for count, weighted in zip(group_pixels, group_weighted)
        ],
    }


def _exact_eligible_counts(density_grid):
    """Count exact sealed 1 m pixels for each supported Urban Atlas group."""
    source_path = CACHE_ROOT / "density-source" / "jaarbak" / "jaarbak-2021-halo.tif"
    urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
    urban = gpd.read_file(urban_path).to_crs("EPSG:31370")
    code_to_group = {
        code: index for index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS, start=1)
        for code in group["codes"]
    }
    urban = urban.loc[urban["classCode"].astype(str).isin(code_to_group)].copy()
    counts = np.zeros((len(LANDSAT_GREEN_SURFACE_GROUPS), density_grid["height"], density_grid["width"]), dtype=np.uint8)
    with rasterio.open(source_path) as source:
        column_offset = int(round((density_grid["transform"].c - source.transform.c) / source.res[0]))
        row_offset = int(round((source.transform.f - density_grid["transform"].f) / abs(source.res[1])))
        native_width = density_grid["width"] * ANALYSIS_RESOLUTION
        native_height = density_grid["height"] * ANALYSIS_RESOLUTION
        if column_offset < 0 or row_offset < 0 or column_offset + native_width > source.width \
                or row_offset + native_height > source.height:
            raise ValueError("JaarBAK does not cover the Green Map population grid.")
        spatial_index = urban.sindex
        rows_per_chunk = 100
        for target_row in range(0, density_grid["height"], rows_per_chunk):
            target_rows = min(rows_per_chunk, density_grid["height"] - target_row)
            window = Window(
                column_offset, row_offset + target_row * ANALYSIS_RESOLUTION,
                native_width, target_rows * ANALYSIS_RESOLUTION,
            )
            values = source.read(1, window=window)
            transform = source.window_transform(window)
            bounds = window_bounds(window, source.transform)
            indexes = list(spatial_index.query(box(*bounds), predicate="intersects"))
            shapes = [
                (row.geometry, code_to_group[str(row.classCode)])
                for _, row in urban.iloc[indexes].iterrows() if not row.geometry.is_empty
            ]
            urban_mask = rasterize(
                shapes, out_shape=values.shape, transform=transform, fill=0, dtype="uint8",
            ) if shapes else np.zeros(values.shape, dtype=np.uint8)
            for group_index in range(1, len(LANDSAT_GREEN_SURFACE_GROUPS) + 1):
                selected = (values == 1) & (urban_mask == group_index)
                counts[group_index - 1, target_row:target_row + target_rows] = selected.reshape(
                    target_rows, ANALYSIS_RESOLUTION, density_grid["width"], ANALYSIS_RESOLUTION,
                ).sum(axis=(1, 3)).astype(np.uint8)
    return counts


def _cell_records(densities, coverage, density_grid, eligible_counts, sectors):
    with rasterio.open(POPULATION_RASTER) as population_source:
        population = population_source.read(1).astype(np.float64)
        population[population == population_source.nodata] = np.nan
        population_grid = {
            "transform": population_source.transform,
            "width": population_source.width,
            "height": population_source.height,
            "crs": population_source.crs,
        }
    if str(population_grid["crs"]) != "EPSG:31370" or population_grid["transform"].a != 100:
        raise ValueError("The Flanders population model must remain an EPSG:31370 100 m raster.")

    projected = sectors.to_crs(population_grid["crs"])
    sector_index = rasterize(
        [(row.geometry, index + 1) for index, row in projected.iterrows()],
        out_shape=population.shape, transform=population_grid["transform"], fill=0, dtype="uint16",
    )
    sector_meta = {
        index + 1: {
            "sectorId": row.sectorId, "sectorName": row.sectorName, "municipality": row.municipality,
        }
        for index, row in projected.iterrows()
    }

    rows, columns = np.indices((density_grid["height"], density_grid["width"]))
    x = density_grid["transform"].c + (columns + .5) * density_grid["transform"].a
    y = density_grid["transform"].f + (rows + .5) * density_grid["transform"].e
    population_columns = np.floor((x - population_grid["transform"].c) / population_grid["transform"].a).astype(int)
    population_rows = np.floor((population_grid["transform"].f - y) / abs(population_grid["transform"].e)).astype(int)
    inside = (
        (population_columns >= 0) & (population_columns < population_grid["width"])
        & (population_rows >= 0) & (population_rows < population_grid["height"])
    )
    valid_density = np.isfinite(coverage)
    weights = np.where(inside[None] & valid_density[None], eligible_counts, 0).astype(np.float64)
    population_index = population_rows * population_grid["width"] + population_columns
    flat_population_index = population_index[inside].ravel()
    cell_count = population_grid["height"] * population_grid["width"]
    eligible_pixels = []
    weighted_density = []
    for group_index in range(len(LANDSAT_GREEN_SURFACE_GROUPS)):
        flat_weights = weights[group_index][inside].ravel()
        eligible_pixels.append(np.bincount(flat_population_index, weights=flat_weights, minlength=cell_count))
        weighted_density.append([
            np.bincount(
                flat_population_index,
                weights=(np.nan_to_num(values[inside], nan=0.0).ravel() * flat_weights),
                minlength=cell_count,
            ) for values in densities
        ])

    records = []
    for row in range(population_grid["height"]):
        for column in range(population_grid["width"]):
            flat = row * population_grid["width"] + column
            sector_number = int(sector_index[row, column])
            group_pixels = [int(round(values[flat])) for values in eligible_pixels]
            value = population[row, column]
            if not sector_number:
                continue
            metadata = sector_meta[sector_number]
            record = compact_cell_record(
                metadata, row, column, value, group_pixels,
                [[weighted_density[group][band][flat] for band, _ in enumerate(GREEN_CLASS_CODES)]
                 for group in range(len(LANDSAT_GREEN_SURFACE_GROUPS))],
            )
            if record:
                # Compact browser keys avoid repeating long property names and
                # municipality text for thousands of analytical cells. The
                # frontend expands this explicit schema before any analysis.
                records.append(record)
    return records, population_grid


def prepare_groenkaart_population():
    if not POPULATION_RASTER.exists():
        raise FileNotFoundError("Run pnpm population:prepare before the Green Map-population comparison.")
    densities, coverage, density_grid = _green_density_10m()
    eligible_counts = _exact_eligible_counts(density_grid)
    sectors = gpd.read_file(SECTORS_PATH)
    records, population_grid = _cell_records(densities, coverage, density_grid, eligible_counts, sectors)
    if not records:
        raise ValueError("Green Map-population preparation produced no eligible cells.")
    urban_mask = _prepare_urban_atlas_class_mask()
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    statistics_path = OUTPUT_ROOT / "cells.json"
    statistics_path.write_text(json.dumps({
        "schemaVersion": 3,
        "cells": records,
    }, separators=(",", ":")), encoding="utf-8")
    population_payload = json.loads(POPULATION_MANIFEST.read_text(encoding="utf-8"))
    source = population_payload["datasets"]["flanders-2019"]["source"]
    manifest = {
        "schemaVersion": 3,
        "comparisonId": "groenkaart-population",
        "primaryLayerId": "groenkaart",
        "secondaryLayerId": "population",
        "greenMapYear": 2021,
        "urbanAtlasYear": 2021,
        "jaarbakYear": 2021,
        "populationYear": 2019,
        "populationDatasetId": "flanders-2019",
        "populationResolutionMeters": 100,
        "densityRadiusMeters": 100,
        "densityCircleAreaHa": round(float(np.pi), 8),
        "densityAnalysisResolutionMeters": 10,
        "minimumDensityCoverage": MINIMUM_NATIVE_JAARBAK_COVERAGE,
        "minimumEligibleAreaHa": MINIMUM_GREEN_INCOME_AREA_HA,
        "minimumAnalysedAreaHa": MINIMUM_GREEN_INCOME_AREA_HA,
        "maskResolutionMeters": 1,
        "aggregation": "exact-masked-area",
        "urbanSurfaceGroups": [
            {"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
            for group in LANDSAT_GREEN_SURFACE_GROUPS
        ],
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
        "defaultGreenClasses": list(DEFAULT_GREEN_CLASSES),
        "greenClasses": list(GROENKAART_CLASSES),
        "cellEncoding": {"s": "sectorId", "r": "row", "c": "column",
                         "p": "populationDensityPerHa", "a": "analysedAreaHa",
                         "g": "combinedMeanDensityByGreenClass[1,2,3,4]",
                         "u": "group[pixelCount,weightedDensitySum1..4]"},
        "sectorMunicipalities": {
            row.sectorId: row.municipality for _, row in sectors.iterrows()
        },
        "coordinates": _coordinates(density_grid),
        "imageSize": [density_grid["width"], density_grid["height"]],
        "densityGridUrl": "groenkaart-income/density-grid.png",
        "densityNonGreenUrl": "groenkaart-income/density-non-green.png",
        "urbanAtlasClassMaskUrl": urban_mask["url"],
        "urbanAtlasClassIndexes": urban_mask["classIndexes"],
        "statisticsUrl": "groenkaart-population/cells.json",
        "populationRasterUrl": "data/population/population-density-2019.tif",
        "populationGrid": {
            "crs": "EPSG:31370",
            "width": population_grid["width"], "height": population_grid["height"],
            "transform": list(population_grid["transform"])[:6],
        },
        "cellCount": len(records),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "population": source,
            "populationRasterSha256": file_hash(POPULATION_RASTER),
            "statisticsSha256": file_hash(statistics_path),
            "urbanAtlasClassMaskSha256": urban_mask["sha256"],
        },
    }
    (OUTPUT_ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return manifest
