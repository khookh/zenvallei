"""Prepare Landsat surface-temperature distributions by JaarBAK class.

The analytical join happens on the native aligned 30 m Landsat grid. JaarBAK
remains a 1 m binary source: its pixels are area-averaged into each Landsat
pixel, then classified only when at least half of that Landsat pixel has valid
JaarBAK coverage. Browser PNGs are lossless visual indexes, never statistics.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds

from .constants import CACHE_ROOT, MUNICIPALITIES, SECTORS_PATH
from .landsat import EXPECTED_SELECTED_OBSERVATIONS, TEMPERATURE_MAXIMUM, TEMPERATURE_MINIMUM, _read_analysis
from .landsat_urban_atlas import (
    BIN_EDGES, _reproject_byte, _scope_distributions, _subpixel_majority, _web_grid, _write_png,
)
from .pipeline import file_hash, update_index

OUTPUT_ROOT = CACHE_ROOT / "landsat-jaarbak"
YEAR_BY_OBSERVATION = {
    "landsat-2020-08-07": 2020,
    "landsat-2022-08-14": 2022,
    "landsat-2023-06-13": 2023,
    "landsat-2023-09-09": 2023,
    "landsat-2025-08-13": 2024,
    "landsat-2026-06-22": 2024,
}
SERIES = (
    {"key": "class:sealed", "type": "class", "id": "sealed", "color": "#8f1d2c", "classIndexes": [1]},
    {"key": "class:unsealed", "type": "class", "id": "unsealed", "color": "#176b43", "classIndexes": [2]},
)


def classify_soil_pixels(valid_coverage: np.ndarray, sealed_fraction: np.ndarray) -> np.ndarray:
    """Return 1 sealed, 2 unsealed or 0 excluded for each Landsat pixel."""
    coverage = np.asarray(valid_coverage, dtype=np.float32)
    fraction = np.asarray(sealed_fraction, dtype=np.float32)
    result = np.zeros(coverage.shape, dtype=np.uint8)
    eligible = np.isfinite(coverage) & np.isfinite(fraction) & (coverage >= 0.5)
    result[eligible & (fraction > 0.5)] = 1
    result[eligible & (fraction < 0.5)] = 2
    return result


def _source_window(source, grid):
    bounds = array_bounds(grid["height"], grid["width"], grid["transform"])
    source_bounds = transform_bounds(grid["crs"], source.crs, *bounds, densify_pts=21)
    window = from_bounds(*source_bounds, transform=source.transform).round_offsets().round_lengths()
    window = Window(
        max(0, window.col_off - 2), max(0, window.row_off - 2),
        min(source.width, window.col_off + window.width + 2) - max(0, window.col_off - 2),
        min(source.height, window.row_off + window.height + 2) - max(0, window.row_off - 2),
    )
    return window, source.window_transform(window)


def _classify_jaarbak(source_path: Path, grid):
    """Area-average the cached 1 m binary raster onto the Landsat grid."""
    destination_shape = (grid["height"], grid["width"])
    with rasterio.open(source_path) as source:
        if source.crs.to_epsg() != 31370 or not all(abs(abs(value) - 1) < 1e-6 for value in source.res):
            raise ValueError(f"{source_path.name}: expected JaarBAK EPSG:31370 at 1 m.")
        window, source_transform = _source_window(source, grid)
        print(f"  reading JaarBAK window {int(window.width)} x {int(window.height)}", flush=True)
        raw = source.read(1, window=window)

    valid = (raw != 255).astype(np.uint8)
    valid_coverage = np.zeros(destination_shape, dtype=np.float32)
    reproject(
        source=valid, destination=valid_coverage,
        src_transform=source_transform, src_crs="EPSG:31370",
        dst_transform=grid["transform"], dst_crs=grid["crs"],
        resampling=Resampling.average,
    )
    sealed = (raw == 1).astype(np.uint8)
    del raw, valid
    sealed_area_fraction = np.zeros(destination_shape, dtype=np.float32)
    reproject(
        source=sealed, destination=sealed_area_fraction,
        src_transform=source_transform, src_crs="EPSG:31370",
        dst_transform=grid["transform"], dst_crs=grid["crs"],
        resampling=Resampling.average,
    )
    del sealed
    sealed_fraction = np.divide(
        sealed_area_fraction, valid_coverage,
        out=np.full(destination_shape, np.nan, dtype=np.float32), where=valid_coverage > 0,
    )
    return classify_soil_pixels(valid_coverage, sealed_fraction), valid_coverage, sealed_fraction


def _surface_stats(jaarbak, year):
    entry = jaarbak["years"][str(year)]
    scopes = {
        f"sector:{sector_id}": stats for sector_id, stats in entry["sectorStats"].items()
    }
    scopes.update({
        f"municipality:{name}": stats for name, stats in entry["municipalityStats"].items()
    })
    sector_values = list(entry["sectorStats"].values())
    sums = {
        key: sum(float(item.get(key, 0) or 0) for item in sector_values)
        for key in ("completeAreaHa", "validAreaHa", "noDataAreaHa", "sealedAreaHa", "unsealedAreaHa")
    }
    complete = sums["completeAreaHa"] or 1
    sums.update({
        "validPercentage": sums["validAreaHa"] / complete * 100,
        "noDataPercentage": sums["noDataAreaHa"] / complete * 100,
        "sealedPercentage": sums["sealedAreaHa"] / complete * 100,
        "unsealedPercentage": sums["unsealedAreaHa"] / complete * 100,
    })
    scopes["region:zennevallei"] = sums
    return scopes


def display_scope_indexes(sectors, grid):
    """Build visual masks from dissolved scopes, not individual sectors.

    Sector-majority assignment intentionally excludes 30 m pixels tied across
    two sectors for statistical summaries. Reusing that index as a display
    mask created tiny transparent squares along otherwise internal sector
    borders. Dissolving first removes those artificial internal boundaries.
    """
    region_index = _subpixel_majority(((sectors.geometry.union_all(), 1),), grid)
    municipality_lookup = {name: index + 1 for index, name in enumerate(MUNICIPALITIES)}
    municipality_shapes = []
    for name, index in municipality_lookup.items():
        geometry = sectors.loc[sectors["municipality"] == name].geometry.union_all()
        if not geometry.is_empty:
            municipality_shapes.append((geometry, index))
    municipality_index = _subpixel_majority(municipality_shapes, grid)
    return region_index, municipality_index, municipality_lookup


def prepare_landsat_jaarbak():
    landsat_path = CACHE_ROOT / "landsat-temperature" / "manifest.json"
    jaarbak_path = CACHE_ROOT / "jaarbak" / "manifest.json"
    if not landsat_path.exists() or not jaarbak_path.exists():
        raise FileNotFoundError("Prepare Landsat surface temperature and JaarBAK first.")
    landsat = json.loads(landsat_path.read_text(encoding="utf-8"))
    jaarbak = json.loads(jaarbak_path.read_text(encoding="utf-8"))
    selected_ids = tuple(item["value"] for item in landsat["timelineItems"])
    if selected_ids != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("Regenerate Landsat data so the six selected heatwave observations are current.")
    if set(YEAR_BY_OBSERVATION) != set(selected_ids):
        raise ValueError("The Landsat-to-JaarBAK year mapping is incomplete.")

    first_analysis = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{selected_ids[0]}.tif"
    _, _, _, grid = _read_analysis(first_analysis)
    sectors = gpd.read_file(SECTORS_PATH).to_crs(grid["crs"])
    sector_meta = {
        index + 1: {"sectorId": row.sectorId, "municipality": row.municipality}
        for index, row in sectors.iterrows()
    }
    sector_index = _subpixel_majority(
        ((row.geometry, index + 1) for index, row in sectors.iterrows()), grid,
    )
    region_index, municipality_index, municipality_lookup = display_scope_indexes(sectors, grid)

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    web = _web_grid(grid)
    web_region = _reproject_byte(region_index.astype(np.uint8), grid, web)
    web_municipality = _reproject_byte(municipality_index, grid, web)
    scope_path = OUTPUT_ROOT / "scope-index.png"
    _write_png(scope_path, (web_region, web_municipality, np.zeros_like(web_region)))

    class_cache = {}
    observations = {}
    for observation_id in selected_ids:
        year = YEAR_BY_OBSERVATION[observation_id]
        if year not in class_cache:
            source = CACHE_ROOT / "raw" / "jaarbak" / f"jaarbak-{year}.tif"
            if not source.exists():
                raise FileNotFoundError(f"Missing cached JaarBAK source for {year}: {source}")
            print(f"JaarBAK {year}: aligning the 1 m source to Landsat", flush=True)
            class_cache[year] = _classify_jaarbak(source, grid)[0]
        soil_class = class_cache[year]

        analysis = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        temperature, status, _, observation_grid = _read_analysis(analysis)
        if observation_grid != grid:
            raise ValueError(f"{observation_id}: analytical grid is not aligned.")
        distributions = _scope_distributions(
            temperature, status, soil_class, sector_index, sector_meta, SERIES,
        )
        distribution_path = OUTPUT_ROOT / "distributions" / f"{observation_id}.json"
        distribution_path.parent.mkdir(parents=True, exist_ok=True)
        distribution_path.write_text(json.dumps({
            "schemaVersion": 1,
            "observationId": observation_id,
            "secondaryYear": year,
            "secondaryStatus": jaarbak["years"][str(year)]["status"],
            "scopes": distributions,
            "surfaceStats": _surface_stats(jaarbak, year),
        }, separators=(",", ":")), encoding="utf-8")

        encoded_temperature = np.zeros(temperature.shape, dtype=np.uint8)
        clear = (status == 1) & np.isfinite(temperature)
        encoded_temperature[clear] = np.round(np.clip(
            (temperature[clear] - TEMPERATURE_MINIMUM) / (TEMPERATURE_MAXIMUM - TEMPERATURE_MINIMUM), 0, 1,
        ) * 255).astype(np.uint8)
        data_path = OUTPUT_ROOT / "pixels" / f"{observation_id}.png"
        _write_png(data_path, (
            _reproject_byte(encoded_temperature, grid, web),
            _reproject_byte(soil_class, grid, web),
            _reproject_byte(status.astype(np.uint8), grid, web),
        ))
        observations[observation_id] = {
            "secondaryYear": year,
            "secondaryStatus": jaarbak["years"][str(year)]["status"],
            "pixelDataUrl": f"landsat-jaarbak/pixels/{observation_id}.png",
            "distributionUrl": f"landsat-jaarbak/distributions/{observation_id}.json",
            "pixelDataSha256": file_hash(data_path),
            "distributionSha256": file_hash(distribution_path),
        }

    manifest = {
        "schemaVersion": 1,
        "comparisonId": "landsat-jaarbak",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "jaarbak",
        "defaultSeries": ["class:sealed", "class:unsealed"],
        "maximumSeries": 2,
        "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
        "binEdges": BIN_EDGES.tolist(),
        "classification": {
            "sourceResolutionMetres": 1,
            "targetResolutionMetres": 30,
            "minimumValidCoverage": 0.5,
            "sealedRule": "fraction > 0.5",
            "unsealedRule": "fraction < 0.5",
            "ties": "excluded",
        },
        "yearByObservation": YEAR_BY_OBSERVATION,
        "coordinates": web["coordinates"],
        "imageSize": [web["width"], web["height"]],
        "scopeIndexUrl": "landsat-jaarbak/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
        "municipalityIndexes": municipality_lookup,
        "sectorIndexes": {metadata["sectorId"]: index for index, metadata in sector_meta.items()},
        "series": [{key: value for key, value in item.items() if key != "classIndexes"} for item in SERIES],
        "observations": observations,
        "warnings": {"methodChangeYear": 2023, "provisionalYear": 2024},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "landsatManifestSha256": file_hash(landsat_path),
            "jaarbakManifestSha256": file_hash(jaarbak_path),
        },
    }
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    update_index()
    return manifest
