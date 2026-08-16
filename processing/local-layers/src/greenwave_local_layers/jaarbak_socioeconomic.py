"""Prepare Soil-sealing density comparisons with population and income.

The continuous response is the existing circular 100 m density field. Exact
native sealed square metres inside the two selected Urban Atlas groups weight
that field, matching the established Green Map socioeconomic contract.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.windows import Window, bounds as window_bounds
from shapely.geometry import box

from .constants import CACHE_ROOT, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .density import ANALYSIS_RESOLUTION, _fraction_grid, circular_kernel, focal_density
from .pipeline import file_hash, update_index
from .sealed_urban_comparisons import (
    LANDSAT_GREEN_SURFACE_GROUPS,
    MINIMUM_GREEN_INCOME_AREA_HA,
    _coordinates,
    _display_scopes_10m,
    _income_records,
    _prepare_urban_atlas_class_mask,
    _sector_coordinates,
    _sector_metadata,
    _sector_regressions,
    _surface_selection_key,
    _surface_selection_keys,
    ordinary_least_squares,
)

SOIL_YEAR = 2024
POPULATION_YEAR = 2019
POPULATION_DATASET = "flanders-2019"
MINIMUM_DENSITY_COVERAGE = 0.95
POPULATION_RASTER = PROJECT_ROOT / "public" / "data" / "population" / "population-density-2019.tif"
SOURCE_PATH = CACHE_ROOT / "density-source" / "jaarbak" / f"jaarbak-{SOIL_YEAR}-halo.tif"
OUTPUT_ROOT = CACHE_ROOT / "jaarbak-socioeconomic"


def _write_rgba(path, channels):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial.png")
    Image.fromarray(np.dstack(channels).astype(np.uint8), mode="RGBA").save(temporary, optimize=True)
    temporary.replace(path)


def _soil_density_10m():
    if not SOURCE_PATH.exists():
        raise FileNotFoundError(f"Missing cached Soil-sealing halo: {SOURCE_PATH}")
    fractions, valid = _fraction_grid(SOURCE_PATH, (1,))
    densities, coverage = focal_density(fractions, valid, circular_kernel())
    radius_cells = 100 // ANALYSIS_RESOLUTION
    density = densities[0, radius_cells:-radius_cells, radius_cells:-radius_cells]
    coverage = coverage[radius_cells:-radius_cells, radius_cells:-radius_cells]
    with rasterio.open(SOURCE_PATH) as source:
        transform = source.transform * rasterio.Affine.scale(ANALYSIS_RESOLUTION)
        transform = transform * rasterio.Affine.translation(radius_cells, radius_cells)
    return density, coverage, {
        "crs": "EPSG:31370", "transform": transform,
        "height": density.shape[0], "width": density.shape[1],
    }


def _urban_group_data():
    urban = gpd.read_file(PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson").to_crs("EPSG:31370")
    code_to_group = {
        code: index for index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS, start=1)
        for code in group["codes"]
    }
    return urban.loc[urban["classCode"].astype(str).isin(code_to_group)].copy(), code_to_group


def _native_grid_window(density_grid, source):
    column_offset = int(round((density_grid["transform"].c - source.transform.c) / source.res[0]))
    row_offset = int(round((source.transform.f - density_grid["transform"].f) / abs(source.res[1])))
    native_width = density_grid["width"] * ANALYSIS_RESOLUTION
    native_height = density_grid["height"] * ANALYSIS_RESOLUTION
    if column_offset < 0 or row_offset < 0 or column_offset + native_width > source.width \
            or row_offset + native_height > source.height:
        raise ValueError("The 2024 Soil-sealing source does not cover the density grid.")
    return column_offset, row_offset, native_width, native_height


def _exact_group_counts(density_grid):
    """Count exact sealed square metres by UA group in every 10 m cell."""
    urban, code_to_group = _urban_group_data()
    group_count = len(LANDSAT_GREEN_SURFACE_GROUPS)
    counts = np.zeros((group_count, density_grid["height"], density_grid["width"]), dtype=np.uint8)
    with rasterio.open(SOURCE_PATH) as source:
        column_offset, row_offset, native_width, _ = _native_grid_window(density_grid, source)
        spatial_index = urban.sindex
        for target_row in range(0, density_grid["height"], 100):
            target_rows = min(100, density_grid["height"] - target_row)
            window = Window(column_offset, row_offset + target_row * ANALYSIS_RESOLUTION,
                            native_width, target_rows * ANALYSIS_RESOLUTION)
            values = source.read(1, window=window)
            transform = source.window_transform(window)
            indexes = list(spatial_index.query(box(*window_bounds(window, source.transform)), predicate="intersects"))
            shapes = [(row.geometry, code_to_group[str(row.classCode)])
                      for _, row in urban.iloc[indexes].iterrows() if not row.geometry.is_empty]
            urban_mask = rasterize(shapes, out_shape=values.shape, transform=transform,
                                   fill=0, dtype="uint8") if shapes else np.zeros(values.shape, dtype=np.uint8)
            for group_index in range(1, group_count + 1):
                selected = (values == 1) & (urban_mask == group_index)
                counts[group_index - 1, target_row:target_row + target_rows] = selected.reshape(
                    target_rows, ANALYSIS_RESOLUTION, density_grid["width"], ANALYSIS_RESOLUTION,
                ).sum(axis=(1, 3)).astype(np.uint8)
    return counts


def _population_cells(density, coverage, density_grid, group_counts, sectors):
    if not POPULATION_RASTER.exists():
        raise FileNotFoundError("Run pnpm population:prepare before Soil sealing-population preparation.")
    with rasterio.open(POPULATION_RASTER) as source:
        population = source.read(1).astype(np.float64)
        population[population == source.nodata] = np.nan
        population_grid = {"transform": source.transform, "width": source.width,
                           "height": source.height, "crs": source.crs}
    if str(population_grid["crs"]) != "EPSG:31370" or population_grid["transform"].a != 100:
        raise ValueError("The Flanders population model must remain an EPSG:31370 100 m raster.")
    projected = sectors.to_crs(population_grid["crs"])
    sector_index = rasterize([(row.geometry, index + 1) for index, row in projected.iterrows()],
                             out_shape=population.shape, transform=population_grid["transform"],
                             fill=0, dtype="uint16")
    sector_meta = {index + 1: {"sectorId": row.sectorId, "sectorName": row.sectorName,
                               "municipality": row.municipality}
                   for index, row in projected.iterrows()}
    rows, columns = np.indices((density_grid["height"], density_grid["width"]))
    x = density_grid["transform"].c + (columns + .5) * density_grid["transform"].a
    y = density_grid["transform"].f + (rows + .5) * density_grid["transform"].e
    population_columns = np.floor((x - population_grid["transform"].c) / population_grid["transform"].a).astype(int)
    population_rows = np.floor((population_grid["transform"].f - y) / abs(population_grid["transform"].e)).astype(int)
    inside = ((population_columns >= 0) & (population_columns < population_grid["width"])
              & (population_rows >= 0) & (population_rows < population_grid["height"])
              & np.isfinite(coverage) & (coverage >= MINIMUM_DENSITY_COVERAGE))
    flat_index = (population_rows * population_grid["width"] + population_columns)[inside].ravel()
    cell_count = population_grid["height"] * population_grid["width"]
    pixels, weighted = [], []
    for group in group_counts:
        weights = group[inside].astype(np.float64).ravel()
        pixels.append(np.bincount(flat_index, weights=weights, minlength=cell_count))
        weighted.append(np.bincount(flat_index,
                                    weights=np.nan_to_num(density[inside], nan=0).ravel() * weights,
                                    minlength=cell_count))
    minimum_pixels = int(round(MINIMUM_GREEN_INCOME_AREA_HA * 10_000))
    records = []
    for row in range(population_grid["height"]):
        for column in range(population_grid["width"]):
            flat = row * population_grid["width"] + column
            sector_number = int(sector_index[row, column])
            counts = [int(round(item[flat])) for item in pixels]
            total = sum(counts)
            value = population[row, column]
            if not sector_number or not np.isfinite(value) or total < minimum_pixels:
                continue
            records.append({
                "s": sector_meta[sector_number]["sectorId"], "r": row, "c": column,
                "p": round(float(value), 5), "a": round(total * .0001, 4),
                "d": round(float(sum(item[flat] for item in weighted) / total), 5),
                "u": [[count, round(float(weighted[index][flat]), 5)]
                      for index, count in enumerate(counts)],
            })
    return records, population_grid


def _sector_statistics(density, coverage, density_grid, sectors, income):
    urban, code_to_group = _urban_group_data()
    sector_meta = _sector_metadata(sectors)
    sector_shapes = [(row.geometry, index + 1) for index, row in sectors.iterrows()]
    group_count = len(LANDSAT_GREEN_SURFACE_GROUPS)
    pixels = np.zeros((group_count, len(sector_meta) + 1), dtype=np.int64)
    weighted = np.zeros((group_count, len(sector_meta) + 1), dtype=np.float64)
    flat_density = density.ravel()
    flat_valid = (np.isfinite(coverage) & (coverage >= MINIMUM_DENSITY_COVERAGE)).ravel()
    cell_count = density_grid["height"] * density_grid["width"]
    with rasterio.open(SOURCE_PATH) as source:
        column_offset, row_offset, native_width, _ = _native_grid_window(density_grid, source)
        urban_index = urban.sindex
        for target_row in range(0, density_grid["height"], 100):
            target_rows = min(100, density_grid["height"] - target_row)
            window = Window(column_offset, row_offset + target_row * ANALYSIS_RESOLUTION,
                            native_width, target_rows * ANALYSIS_RESOLUTION)
            values = source.read(1, window=window)
            transform = source.window_transform(window)
            indexes = list(urban_index.query(box(*window_bounds(window, source.transform)), predicate="intersects"))
            shapes = [(row.geometry, code_to_group[str(row.classCode)])
                      for _, row in urban.iloc[indexes].iterrows() if not row.geometry.is_empty]
            urban_mask = rasterize(shapes, out_shape=values.shape, transform=transform,
                                   fill=0, dtype="uint8") if shapes else np.zeros(values.shape, dtype=np.uint8)
            sector_mask = rasterize(sector_shapes, out_shape=values.shape, transform=transform,
                                    fill=0, dtype="uint16")
            for group_index in range(1, group_count + 1):
                rows, columns = np.nonzero((values == 1) & (urban_mask == group_index) & (sector_mask > 0))
                if not len(rows):
                    continue
                parents = (target_row + rows // ANALYSIS_RESOLUTION) * density_grid["width"] \
                    + columns // ANALYSIS_RESOLUTION
                valid = flat_valid[parents]
                if not np.any(valid):
                    continue
                parents = parents[valid]
                sector_values = sector_mask[rows[valid], columns[valid]].astype(np.int64)
                keys, counts = np.unique(sector_values * cell_count + parents, return_counts=True)
                key_sectors, key_cells = keys // cell_count, keys % cell_count
                for sector_index in np.unique(key_sectors):
                    selected = key_sectors == sector_index
                    weights = counts[selected].astype(np.float64)
                    slot = group_index - 1
                    pixels[slot, sector_index] += int(np.sum(weights))
                    weighted[slot, sector_index] += float(np.sum(flat_density[key_cells[selected]] * weights))
    output = {}
    for index, metadata in sector_meta.items():
        groups = {}
        for slot, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS):
            count = int(pixels[slot, index])
            groups[group["id"]] = {
                "analysedAreaHa": round(count * .0001, 4),
                "densityAreaSum": round(float(weighted[slot, index]), 5),
                "meanDensity": None if not count else round(float(weighted[slot, index] / count), 5),
            }
        total = int(np.sum(pixels[:, index]))
        fiscal = income.get(metadata["sectorId"], {})
        output[metadata["sectorId"]] = {
            **metadata,
            "analysedAreaHa": round(total * .0001, 4),
            "meanDensity": None if not total else round(float(np.sum(weighted[:, index]) / total), 5),
            "urbanSurfaceGroups": groups,
            "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
        }
    return output


def _selected_sector_stats(sector_stats, selected_ids):
    output = {}
    for sector_id, record in sector_stats.items():
        groups = [record["urbanSurfaceGroups"][group_id] for group_id in selected_ids]
        area_m2 = sum(group["analysedAreaHa"] * 10_000 for group in groups)
        density_sum = sum(group["densityAreaSum"] for group in groups)
        output[sector_id] = {
            **record,
            "analysedAreaHa": round(area_m2 / 10_000, 4),
            "meanDensity": None if not area_m2 else round(density_sum / area_m2, 5),
        }
    return output


def _regressions(sector_stats, sectors):
    output = {}
    coordinates = _sector_coordinates(sectors)
    for ids in _surface_selection_keys():
        selected = _selected_sector_stats(sector_stats, ids)

        def calculate(records, x_key):
            valid = [record for record in records if record["analysedAreaHa"] >= MINIMUM_GREEN_INCOME_AREA_HA
                     and record.get(x_key) is not None and record.get("meanDensity") is not None]
            response = [record["meanDensity"] for record in valid]
            return ordinary_least_squares([record[x_key] for record in valid], response), valid, response

        output[_surface_selection_key(ids)] = _sector_regressions(selected, "income", calculate, coordinates)
    return output


def prepare_jaarbak_socioeconomic():
    density, coverage, density_grid = _soil_density_10m()
    sectors = gpd.read_file(SECTORS_PATH).to_crs(density_grid["crs"])
    group_counts = _exact_group_counts(density_grid)
    income_payload, income = _income_records()
    population_cells, population_grid = _population_cells(
        density, coverage, density_grid, group_counts, sectors,
    )
    sector_stats = _sector_statistics(density, coverage, density_grid, sectors, income)
    regressions = _regressions(sector_stats, sectors)
    urban_mask = _prepare_urban_atlas_class_mask()
    encoded = np.zeros(density.shape, dtype=np.uint8)
    valid = np.isfinite(density)
    encoded[valid] = np.rint(np.clip(density[valid], 0, 100) * 2.55).astype(np.uint8)
    empty = np.zeros_like(encoded)
    validity = np.where(np.isfinite(coverage) & (coverage >= MINIMUM_DENSITY_COVERAGE), 255, 0).astype(np.uint8)
    density_path = OUTPUT_ROOT / "density-grid.png"
    _write_rgba(density_path, [encoded, empty, empty, validity])

    population_root = CACHE_ROOT / "jaarbak-population"
    population_root.mkdir(parents=True, exist_ok=True)
    population_stats = population_root / "cells.json"
    population_stats.write_text(json.dumps({"schemaVersion": 1, "cells": population_cells},
                                            separators=(",", ":")), encoding="utf-8")
    income_root = CACHE_ROOT / "jaarbak-income"
    income_root.mkdir(parents=True, exist_ok=True)
    income_stats = income_root / "statistics.json.gz"
    income_stats.write_bytes(gzip.compress(json.dumps({
        "schemaVersion": 1, "sectorStats": sector_stats, "regressionsBySurface": regressions,
    }, separators=(",", ":")).encode("utf-8"), compresslevel=9, mtime=0))
    region, municipality, municipality_indexes = _display_scopes_10m(sectors, density_grid)
    scope_path = OUTPUT_ROOT / "scope-index.png"
    _write_rgba(scope_path, [region, municipality, np.zeros_like(region), np.full_like(region, 255)])
    groups = [{"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
              for group in LANDSAT_GREEN_SURFACE_GROUPS]
    common = {
        "schemaVersion": 1,
        "soilSealingYear": SOIL_YEAR,
        "urbanAtlasYear": 2021,
        "densityRadiusMeters": 100,
        "densityCircleAreaHa": round(float(np.pi), 8),
        "densityAnalysisResolutionMeters": 10,
        "minimumDensityCoverage": int(MINIMUM_DENSITY_COVERAGE * 100),
        "minimumAnalysedAreaHa": MINIMUM_GREEN_INCOME_AREA_HA,
        "maskResolutionMeters": 1,
        "aggregation": "exact-masked-area",
        "urbanSurfaceGroups": groups,
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
        "coordinates": _coordinates(density_grid),
        "imageSize": [density_grid["width"], density_grid["height"]],
        "densityGridUrl": "jaarbak-socioeconomic/density-grid.png",
        "scopeIndexUrl": "jaarbak-socioeconomic/scope-index.png",
        "urbanAtlasClassMaskUrl": urban_mask["url"],
        "urbanAtlasClassIndexes": urban_mask["classIndexes"],
        "sectorMunicipalities": {row.sectorId: row.municipality for _, row in sectors.iterrows()},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "soilSealingSha256": file_hash(SOURCE_PATH),
            "urbanAtlasClassMaskSha256": urban_mask["sha256"],
            "densityGridSha256": file_hash(density_path),
        },
    }
    population_payload = json.loads((PROJECT_ROOT / "public" / "data" / "population.json").read_text(encoding="utf-8"))
    population_manifest = {
        **common,
        "comparisonId": "jaarbak-population", "primaryLayerId": "jaarbak", "secondaryLayerId": "population",
        "populationYear": POPULATION_YEAR, "populationDatasetId": POPULATION_DATASET,
        "populationResolutionMeters": 100, "statisticsUrl": "jaarbak-population/cells.json",
        "populationRasterUrl": "data/population/population-density-2019.tif",
        "populationGrid": {"crs": "EPSG:31370", "width": population_grid["width"],
                           "height": population_grid["height"],
                           "transform": list(population_grid["transform"])[:6]},
        "cellCount": len(population_cells),
        "sources": {**common["sources"],
                    "population": population_payload["datasets"][POPULATION_DATASET]["source"],
                    "statisticsSha256": file_hash(population_stats)},
    }
    income_manifest = {
        **common,
        "comparisonId": "jaarbak-income", "primaryLayerId": "jaarbak", "secondaryLayerId": "income",
        "incomeYear": 2023, "statisticsUrl": "jaarbak-income/statistics.json.gz",
        "sources": {**common["sources"], "income": income_payload["source"],
                    "statisticsSha256": file_hash(income_stats)},
    }
    (population_root / "manifest.json").write_text(json.dumps(population_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (income_root / "manifest.json").write_text(json.dumps(income_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return {"jaarbak-population": population_manifest, "jaarbak-income": income_manifest}
