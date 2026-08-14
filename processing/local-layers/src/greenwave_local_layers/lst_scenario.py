"""Prepare and calculate the local Radoux land-cover temperature scenario.

The official Green Map and Soil sealing rasters stay on their native 1 m
Belgian Lambert grid. A scenario changes only supported source classes. Changed
areas are aggregated to 15 m before the Radoux thermal point-spread function is
applied, and the resulting delta is sampled on Greenwave's common 30 m Landsat
grid. A 1 m source cell is therefore an area contribution, never a temperature
observation.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import shutil
import struct
import sys
import uuid
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import array_bounds, rowcol
from rasterio.windows import Window, bounds as window_bounds, from_bounds as raster_window_from_bounds
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds
from scipy.signal import fftconvolve
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform as shapely_transform

from .analysis_water import (
    DEFAULT_ANALYSIS_WATER_PATH,
    LAND_USE_WATER_CODE,
    LAND_USE_YEAR,
    analysis_water_metadata,
    analysis_water_union,
    land_use_water,
)
from .constants import CACHE_ROOT, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .landsat import EXPECTED_SELECTED_OBSERVATIONS
from .pipeline import _pmtiles, _validate_pmtiles, _write_cutline, file_hash, update_index
from .scenario_land_cover import (
    GROUND_AGRICULTURE,
    GROUND_BARE,
    GROUND_LOCKED,
    GROUND_LOW,
    GROUND_NAME_BY_CODE,
    GROUND_SEALED,
    GROUND_WATER,
    apply_land_cover_operations,
    baseline_land_cover,
    upper_surface_masks,
    xgboost_channels_from_state,
    xgboost_land_cover_channels,
)
from .scenario_statistics import AFFECTED_THRESHOLD_C, delta_statistics as _quantiles


DATASET_ID = "land-cover-scenario"
GREEN_BASELINE_YEAR = 2021
SOIL_BASELINE_YEAR = 2024
SOURCE_CRS = "EPSG:31370"
LANDSAT_CRS = "EPSG:32631"
SOURCE_RESOLUTION = 1
MIXTURE_RESOLUTION = 15
OUTPUT_RESOLUTION = 30
PSF_SIGMA_METERS = 79.5
PSF_SIZE = 41
PSF_HALO_METERS = 300
MAX_OPERATIONS = 100
MAX_VERTICES = 10_000
MAX_SUBMITTED_AREA_HA = 200.0
PROCESSING_TILE_SIZE = 900  # divisible by the 15 m mixture grid
DELTA_ENCODING_SCALE = 100
DELTA_ENCODING_OFFSET = 32768
XGBOOST_MODEL_CONTRACT_VERSION = 5
XGBOOST_NOTEBOOK_URL = (
    "https://github.com/khookh/zenvallei/blob/main/playground/"
    "xgboost_2026_heatwave_regression_zennevallei.ipynb"
)

CLASS_LOCKED = 0
CLASS_HIGH = 1
CLASS_LOW = 2
CLASS_SEALED = 3
CLASS_WATER = 4
CLASS_BARE = 5
CLASS_BY_TARGET = {"high": CLASS_HIGH, "sealed": CLASS_SEALED}
TARGET_BY_CLASS = {
    CLASS_HIGH: "high", CLASS_LOW: "low", CLASS_SEALED: "sealed", CLASS_BARE: "bare",
}
COEFFICIENTS = {
    CLASS_HIGH: -7.42,
    CLASS_LOW: -2.07,
    CLASS_SEALED: 3.20,
    # Green Map's non-green class is broader than the paper's pure bare-soil
    # class. After water, agriculture and sealed ground are removed, it is the
    # only defensible local proxy that lets a user vegetate verified unsealed
    # ground without creating arbitrary holes in a painted polygon.
    CLASS_BARE: 6.70,
}
RUNTIME_ROOT = CACHE_ROOT / DATASET_ID / "runtime"
BASELINE_AREA_STATS_PATH = CACHE_ROOT / DATASET_ID / "baseline-area-statistics.json"
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,80}$")

BROWSER_BASELINE_PATH = CACHE_ROOT / DATASET_ID / "scenario-baseline-1m.tif"
BROWSER_SCOPE_PATH = CACHE_ROOT / DATASET_ID / "scenario-output-scopes.bin.gz"
BROWSER_XGBOOST_GRID_PATH = CACHE_ROOT / DATASET_ID / "xgboost-inference-grid.bin.gz"
BROWSER_XGBOOST_MODEL_PATH = CACHE_ROOT / DATASET_ID / "xgboost-model.json"


def radoux_kernel(sigma_m=PSF_SIGMA_METERS, size=PSF_SIZE, resolution=MIXTURE_RESOLUTION):
    """Return the normalised Gaussian footprint described by Radoux et al."""
    if size < 1 or size % 2 == 0 or sigma_m <= 0 or resolution <= 0:
        raise ValueError("The Radoux kernel requires a positive odd grid and positive scale.")
    radius = size // 2
    offsets = np.arange(-radius, radius + 1, dtype=np.float64) * resolution
    x, y = np.meshgrid(offsets, offsets)
    kernel = np.exp(-(x * x + y * y) / (2.0 * sigma_m * sigma_m))
    return (kernel / np.sum(kernel)).astype(np.float64)


def conversion_delta(source_class, target_class):
    """Return the coefficient difference for one supported conversion."""
    if source_class not in COEFFICIENTS or target_class not in COEFFICIENTS:
        raise ValueError("Both scenario classes must have a Radoux coefficient.")
    return COEFFICIENTS[target_class] - COEFFICIENTS[source_class]


def stale_revision(active_session_id, active_revision, incoming_session_id, incoming_revision):
    """Reject old revisions only within the same browser page session."""
    return (active_session_id == incoming_session_id and active_revision is not None
            and incoming_revision < active_revision)


def baseline_surface_states(green, sealing, water=None, inside=None):
    """Compatibility name for the shared ground/canopy baseline contract."""
    ground, canopy, editable = baseline_land_cover(green, sealing, water, inside)
    return canopy, ground, editable


def upper_surface_class(canopy, ground, water=None, editable=None):
    """Derive the Radoux class from the shared exclusive upper surface."""
    canopy = np.asarray(canopy, dtype=bool)
    ground = np.asarray(ground, dtype=np.uint8)
    result = np.full(ground.shape, CLASS_LOCKED, dtype=np.uint8)
    surface = upper_surface_masks(ground, canopy)
    result[surface["low"]] = CLASS_LOW
    result[surface["sealed"]] = CLASS_SEALED
    result[surface["bare"]] = CLASS_BARE
    result[surface["water"]] = CLASS_WATER
    result[surface["high"]] = CLASS_HIGH
    if editable is not None:
        result[~(np.asarray(editable, dtype=bool) | (ground == GROUND_WATER))] = CLASS_LOCKED
    if water is not None:
        result[np.asarray(water, dtype=bool)] = CLASS_WATER
    return result


def radoux_effective_proportions(canopy, ground, editable=None):
    """Return mutually exclusive Radoux fractions over supported editable cells."""
    surface = upper_surface_class(canopy, ground, editable=editable)
    supported = np.isin(surface, tuple(COEFFICIENTS))
    count = int(np.count_nonzero(supported))
    if not count:
        return {int(class_code): 0.0 for class_code in COEFFICIENTS}
    proportions = {
        int(class_code): float(np.count_nonzero(surface[supported] == class_code) / count)
        for class_code in COEFFICIENTS
    }
    if not math.isclose(sum(proportions.values()), 1.0, rel_tol=0, abs_tol=1e-12):
        raise AssertionError("Effective Radoux class proportions must sum to one.")
    return proportions


def supported_baseline(green, sealing, water=None, inside=None):
    """Compatibility helper returning the derived Radoux baseline."""
    canopy, ground, editable = baseline_surface_states(green, sealing, water, inside)
    return upper_surface_class(canopy, ground, water, editable)


def apply_surface_operations(baseline_canopy, baseline_ground, editable, masks_and_operations):
    """Compatibility wrapper around the single shared transition function."""
    ground, canopy, touched = apply_land_cover_operations(
        baseline_ground, baseline_canopy, editable, masks_and_operations,
    )
    return canopy, ground, touched


def apply_operations(baseline, masks_and_operations):
    """Legacy single-state helper retained for focused conversion tests."""
    baseline = np.asarray(baseline, dtype=np.uint8)
    baseline_canopy = baseline == CLASS_HIGH
    baseline_ground = np.full(baseline.shape, GROUND_LOCKED, dtype=np.uint8)
    baseline_ground[np.isin(baseline, (CLASS_HIGH, CLASS_LOW))] = GROUND_LOW
    baseline_ground[baseline == CLASS_SEALED] = GROUND_SEALED
    baseline_ground[baseline == CLASS_BARE] = GROUND_BARE
    baseline_ground[baseline == CLASS_WATER] = GROUND_WATER
    editable = np.isin(baseline, tuple(COEFFICIENTS))
    canopy, ground, touched = apply_surface_operations(
        baseline_canopy, baseline_ground, editable, masks_and_operations,
    )
    return upper_surface_class(canopy, ground, baseline == CLASS_WATER, editable), touched


def _vertex_count(geometry):
    if isinstance(geometry, Polygon):
        return len(geometry.exterior.coords) + sum(len(ring.coords) for ring in geometry.interiors)
    if isinstance(geometry, MultiPolygon):
        return sum(_vertex_count(part) for part in geometry.geoms)
    return 0


def _empty_area_stats():
    return {
        "acceptedAreaHa": 0.0,
        "ignoredAreaHa": 0.0,
        "noChangeAreaHa": 0.0,
        "outsideScopeAreaHa": 0.0,
        "submittedAreaHa": 0.0,
        "transitions": {},
        "groundDeltaHa": {name: 0.0 for name in ("low", "sealed", "agriculture", "water", "bare")},
        "highCanopyDeltaHa": 0.0,
    }


def _merge_area_stats(target, source):
    for key in ("acceptedAreaHa", "ignoredAreaHa", "noChangeAreaHa", "outsideScopeAreaHa", "submittedAreaHa"):
        target[key] = round(float(target.get(key, 0)) + float(source.get(key, 0)), 4)
    transitions = target.setdefault("transitions", {})
    for key, value in source.get("transitions", {}).items():
        transitions[key] = round(float(transitions.get(key, 0)) + float(value), 4)
    ground_delta = target.setdefault(
        "groundDeltaHa", {name: 0.0 for name in ("low", "sealed", "agriculture", "water", "bare")},
    )
    for key, value in source.get("groundDeltaHa", {}).items():
        ground_delta[key] = round(float(ground_delta.get(key, 0)) + float(value), 4)
    target["highCanopyDeltaHa"] = round(
        float(target.get("highCanopyDeltaHa", 0)) + float(source.get("highCanopyDeltaHa", 0)), 4,
    )


def _baseline_area_statistics(green_path, sealing_path, water_context_path, sectors_path):
    """Precompute one exact 1 m class ledger for every authoritative scope."""
    sectors = gpd.read_file(sectors_path).to_crs(SOURCE_CRS).reset_index(drop=True)
    class_codes = (GROUND_LOW, GROUND_SEALED, GROUND_AGRICULTURE, GROUND_WATER, GROUND_BARE)
    class_names = tuple(GROUND_NAME_BY_CODE[int(code)] for code in class_codes)
    sector_counts = {
        index + 1: {"ground": {name: 0 for name in class_names}, "high": 0, "locked": 0}
        for index in range(len(sectors))
    }

    with rasterio.open(green_path) as green_source, rasterio.open(sealing_path) as sealing_source, \
            rasterio.open(water_context_path) as water_source:
        if water_source.shape != green_source.shape or water_source.transform != green_source.transform:
            raise ValueError("Scenario analysis water must share the native 1 m land-cover grid.")
        for row_offset in range(0, green_source.height, PROCESSING_TILE_SIZE):
            for column_offset in range(0, green_source.width, PROCESSING_TILE_SIZE):
                height = min(PROCESSING_TILE_SIZE, green_source.height - row_offset)
                width = min(PROCESSING_TILE_SIZE, green_source.width - column_offset)
                window = Window(column_offset, row_offset, width, height)
                transform = green_source.window_transform(window)
                bounds = window_bounds(window, green_source.transform)
                tile_box = box(*bounds)
                sector_indexes = list(sectors.sindex.query(tile_box, predicate="intersects"))
                if not sector_indexes:
                    continue
                sector_index = rasterize(
                    [(sectors.geometry.iloc[index], index + 1) for index in sector_indexes],
                    out_shape=(height, width), transform=transform, fill=0, dtype="uint16",
                )
                inside = sector_index > 0
                if not np.any(inside):
                    continue
                water = analysis_water_union(water_source.read(1, window=window))
                ground, canopy, _ = baseline_land_cover(
                    green_source.read(1, window=window), sealing_source.read(1, window=window),
                    water, inside,
                )
                for class_code, class_name in zip(class_codes, class_names):
                    counts = np.bincount(
                        sector_index[(ground == class_code) & inside], minlength=len(sectors) + 1,
                    )
                    for sector_number in np.flatnonzero(counts[1:]) + 1:
                        sector_counts[int(sector_number)]["ground"][class_name] += int(counts[sector_number])
                high_counts = np.bincount(sector_index[canopy & inside], minlength=len(sectors) + 1)
                locked_counts = np.bincount(
                    sector_index[(ground == GROUND_LOCKED) & inside], minlength=len(sectors) + 1,
                )
                for sector_number in np.flatnonzero((high_counts + locked_counts)[1:]) + 1:
                    sector_counts[int(sector_number)]["high"] += int(high_counts[sector_number])
                    sector_counts[int(sector_number)]["locked"] += int(locked_counts[sector_number])

    def encode(counts):
        ground = {name: round(value / 10_000, 4) for name, value in counts["ground"].items()}
        return {
            "groundBeforeHa": ground,
            "highCanopyBeforeHa": round(counts["high"] / 10_000, 4),
            "validAnalysedAreaHa": round(sum(counts["ground"].values()) / 10_000, 4),
            "lockedUnavailableAreaHa": round(counts["locked"] / 10_000, 4),
        }

    encoded_sectors = {
        str(record["sectorId"]): encode(sector_counts[index + 1])
        for index, record in sectors.iterrows()
    }

    def merge_scope(ids):
        merged = {"ground": {name: 0.0 for name in class_names}, "high": 0.0, "locked": 0.0}
        for sector_id in ids:
            stats = encoded_sectors[sector_id]
            for name in class_names:
                merged["ground"][name] += stats["groundBeforeHa"][name]
            merged["high"] += stats["highCanopyBeforeHa"]
            merged["locked"] += stats["lockedUnavailableAreaHa"]
        ground = {name: round(value, 4) for name, value in merged["ground"].items()}
        return {
            "groundBeforeHa": ground,
            "highCanopyBeforeHa": round(merged["high"], 4),
            "validAnalysedAreaHa": round(sum(ground.values()), 4),
            "lockedUnavailableAreaHa": round(merged["locked"], 4),
        }

    municipalities = {
        municipality: merge_scope([
            str(record["sectorId"]) for _, record in sectors.iterrows()
            if record["municipality"] == municipality
        ])
        for municipality in MUNICIPALITIES
    }
    return {
        "schemaVersion": 1,
        "region": merge_scope(list(encoded_sectors)),
        "municipalities": municipalities,
        "sectors": encoded_sectors,
    }


def rasterize_scope_index(sectors, output_crs, output_shape, output_transform):
    """Rasterise authoritative scopes only after projection to the output grid."""
    projected = sectors.to_crs(output_crs)
    shapes = [(geometry, index + 1) for index, geometry in enumerate(projected.geometry)]
    return rasterize(shapes, out_shape=output_shape, transform=output_transform, fill=0, dtype="uint16")


def web_display_grid(width, height, transform, crs, resolution=OUTPUT_RESOLUTION):
    """Return the true Web Mercator placement grid for a browser raster.

    A transformed UTM bounding box is not the transformed raster quadrilateral.
    Stretching a UTM image across that box visibly displaces its values.  A
    dedicated EPSG:3857 derivative aligns the ΔLST image with MapLibre.
    """
    left, bottom, right, top = array_bounds(height, width, transform)
    target_transform, target_width, target_height = calculate_default_transform(
        crs, "EPSG:3857", width, height, left, bottom, right, top, resolution=resolution,
    )
    target_bounds = array_bounds(target_height, target_width, target_transform)
    west, south, east, north = transform_bounds("EPSG:3857", "EPSG:4326", *target_bounds)
    return {
        "crs": "EPSG:3857", "transform": target_transform,
        "width": target_width, "height": target_height,
        "coordinates": [[west, north], [east, north], [east, south], [west, south]],
    }


def reproject_delta_for_display(delta, source_transform, source_crs, display_grid):
    """Reproject analytical ΔLST without changing the analytical grid or statistics."""
    output = np.zeros((display_grid["height"], display_grid["width"]), dtype=np.float32)
    reproject(
        delta, output, src_transform=source_transform, src_crs=source_crs,
        dst_transform=display_grid["transform"], dst_crs=display_grid["crs"],
        src_nodata=None, dst_nodata=0, resampling=Resampling.bilinear,
    )
    return output


def _prepare_analysis_water_browser_mask(water_context_path, destination_root):
    """Publish a non-rendered tile mask used only to suppress invalid edits."""
    water_context_path = Path(water_context_path)
    destination_root = Path(destination_root)
    archive = destination_root / f"analysis-water-landgebruik-{LAND_USE_YEAR}.pmtiles"
    marker = archive.with_suffix(".source.json")
    source_sha256 = file_hash(water_context_path)
    if archive.exists() and marker.exists():
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            _validate_pmtiles(archive, 10, 17)
            if metadata.get("sourceSha256") == source_sha256 \
                    and metadata.get("archiveSha256") == file_hash(archive):
                return {
                    "url": f"{DATASET_ID}/{archive.name}",
                    "sha256": metadata["archiveSha256"],
                    "sourceSha256": source_sha256,
                }
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            pass

    sectors = gpd.read_file(SECTORS_PATH)
    cutline = CACHE_ROOT / "cutlines" / "zennevallei.geojson"
    cutline.parent.mkdir(parents=True, exist_ok=True)
    _write_cutline(cutline, sectors.to_crs("EPSG:4326").geometry.union_all())
    visual = destination_root / f"analysis-water-landgebruik-{LAND_USE_YEAR}-visual.tif"
    visual.unlink(missing_ok=True)
    with rasterio.open(water_context_path) as source:
        region = sectors.to_crs(source.crs).geometry.union_all()
        source_window = raster_window_from_bounds(*region.bounds, transform=source.transform)
        source_window = source_window.round_offsets().round_lengths().intersection(
            Window(0, 0, source.width, source.height),
        )
        profile = source.profile.copy()
        profile.update(
            width=int(source_window.width), height=int(source_window.height),
            transform=source.window_transform(source_window), count=4, dtype="uint8",
            nodata=None, photometric="RGB", tiled=True, blockxsize=512, blockysize=512,
            compress="DEFLATE",
        )
        with rasterio.open(visual, "w", **profile) as output:
            for _, output_window in output.block_windows(1):
                input_window = Window(
                    source_window.col_off + output_window.col_off,
                    source_window.row_off + output_window.row_off,
                    output_window.width, output_window.height,
                )
                flanders = land_use_water(source.read(1, window=input_window))
                inside = rasterize(
                    [(region, 1)], out_shape=(int(output_window.height), int(output_window.width)),
                    transform=source.window_transform(input_window), fill=0, dtype="uint8",
                ).astype(bool)
                selected = flanders & inside
                rgba = np.zeros((4, int(output_window.height), int(output_window.width)), dtype=np.uint8)
                rgba[0][selected] = 255
                rgba[3][selected] = 255
                output.write(rgba, window=output_window)
    _pmtiles(visual, archive, cutline, "10..17")
    _validate_pmtiles(archive, 10, 17)
    visual.unlink(missing_ok=True)
    metadata = {
        "schemaVersion": 1,
        "sourceSha256": source_sha256,
        "archiveSha256": file_hash(archive),
        "meaning": "non-rendered Landgebruik 2025 water edit lock",
    }
    temporary = marker.with_suffix(".partial.json")
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(marker)
    return {
        "url": f"{DATASET_ID}/{archive.name}",
        "sha256": metadata["archiveSha256"],
        "sourceSha256": source_sha256,
    }


def _write_deterministic_gzip(path, payload):
    """Write a reproducible gzip member for immutable Pages assets."""
    temporary = Path(path).with_suffix(Path(path).suffix + ".partial")
    with temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as stream:
            stream.write(payload)
    temporary.replace(path)


def _prepare_browser_scenario_assets(
        green_path, sealing_path, water_context_path, urban_path, sectors_path,
        landsat_path, model_root):
    """Prepare the exact static inputs consumed by the public Web Worker.

    Band 1 packs the ground code, canopy and editability into one byte. Band 2
    stores the authoritative Statbel sector index and band 3 the Urban Atlas
    class index. Keeping these values on the common native 1 m grid makes the
    browser calculation use the same state transition as the Python oracle.
    """
    destination = CACHE_ROOT / DATASET_ID
    destination.mkdir(parents=True, exist_ok=True)
    sectors = gpd.read_file(sectors_path).to_crs(SOURCE_CRS).reset_index(drop=True)
    urban = gpd.read_file(urban_path).to_crs(SOURCE_CRS)
    class_codes = sorted(str(value) for value in urban["classCode"].dropna().unique())
    class_indexes = {code: index + 1 for index, code in enumerate(class_codes)}

    with rasterio.open(green_path) as green, rasterio.open(sealing_path) as sealing, \
            rasterio.open(water_context_path) as water_source:
        profile = green.profile.copy()
        profile.update(
            driver="GTiff", count=3, dtype="uint8", nodata=None,
            tiled=True, blockxsize=512, blockysize=512, compress="DEFLATE",
            predictor=1, BIGTIFF="IF_SAFER",
        )
        temporary = BROWSER_BASELINE_PATH.with_suffix(".partial.tif")
        with rasterio.open(temporary, "w", **profile) as output:
            output.set_band_description(1, "ground-3bit canopy-bit3 editable-bit4")
            output.set_band_description(2, "statbel-sector-index")
            output.set_band_description(3, "urban-atlas-class-index")
            for _, window in output.block_windows(1):
                height, width = int(window.height), int(window.width)
                transform = green.window_transform(window)
                tile_bounds = window_bounds(window, green.transform)
                tile = box(*tile_bounds)
                sector_candidates = list(sectors.sindex.query(tile, predicate="intersects"))
                sector_index = rasterize(
                    [(sectors.geometry.iloc[index], index + 1) for index in sector_candidates],
                    out_shape=(height, width), transform=transform, fill=0, dtype="uint8",
                )
                urban_candidates = list(urban.sindex.query(tile, predicate="intersects"))
                urban_index = rasterize(
                    [(urban.geometry.iloc[index], class_indexes[str(urban.iloc[index]["classCode"])])
                     for index in urban_candidates],
                    out_shape=(height, width), transform=transform, fill=0, dtype="uint8",
                )
                inside = sector_index > 0
                water = analysis_water_union(water_source.read(1, window=window))
                ground, canopy, editable = baseline_land_cover(
                    green.read(1, window=window), sealing.read(1, window=window), water, inside,
                )
                packed = ground.astype(np.uint8) \
                    | (canopy.astype(np.uint8) << np.uint8(3)) \
                    | (editable.astype(np.uint8) << np.uint8(4))
                output.write(packed, 1, window=window)
                output.write(sector_index, 2, window=window)
                output.write(urban_index, 3, window=window)
        temporary.replace(BROWSER_BASELINE_PATH)

    with rasterio.open(landsat_path) as landsat:
        scope_index = rasterize_scope_index(
            sectors, landsat.crs, landsat.shape, landsat.transform,
        ).astype(np.uint8)
        scope_header = struct.pack(
            "<8sIII", b"GWSCOPE1", landsat.height, landsat.width, len(sectors),
        )
        _write_deterministic_gzip(BROWSER_SCOPE_PATH, scope_header + scope_index.tobytes(order="C"))
        transformer = Transformer.from_crs(landsat.crs, "EPSG:4326", always_xy=True)
        left, bottom, right, top = landsat.bounds
        output_coordinates = [
            list(transformer.transform(left, top)), list(transformer.transform(right, top)),
            list(transformer.transform(right, bottom)), list(transformer.transform(left, bottom)),
        ]

    report_path = Path(model_root) / "report.json"
    model_path = Path(model_root) / "model.json"
    inference_path = Path(model_root) / "baseline-inference-grid.npz"
    xgboost_browser = None
    if report_path.exists() and model_path.exists() and inference_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        model = json.loads(model_path.read_text(encoding="utf-8"))
        learner = model["learner"]
        trees = learner["gradient_booster"]["model"]["trees"]
        compact_model = {
            "schemaVersion": 1,
            "baseScore": float(learner["learner_model_param"]["base_score"].strip("[]")),
            "featureNames": learner["feature_names"],
            "trees": [{
                "left": tree["left_children"], "right": tree["right_children"],
                "feature": tree["split_indices"], "threshold": tree["split_conditions"],
                "defaultLeft": tree["default_left"],
            } for tree in trees],
        }
        BROWSER_XGBOOST_MODEL_PATH.write_text(
            json.dumps(compact_model, ensure_ascii=False, separators=(",", ":")), encoding="utf-8",
        )
        with np.load(inference_path, allow_pickle=False) as inference:
            positions = np.asarray(inference["positions"], dtype="<i4")
            features = np.asarray(inference["features"], dtype="<f4")
            raw_predictions = np.asarray(inference["raw_predictions"], dtype="<f4")
            names = tuple(inference["feature_names"].tolist())
        header = struct.pack(
            "<8sIIII", b"GWXGB001", len(positions), features.shape[1],
            int(report["final"]["ringWidthMeters"]), int(report["final"]["smoothingSigmaMeters"]),
        )
        _write_deterministic_gzip(
            BROWSER_XGBOOST_GRID_PATH,
            header + positions.tobytes(order="C") + features.tobytes(order="C")
            + raw_predictions.tobytes(order="C"),
        )
        xgboost_browser = {
            "modelUrl": f"{DATASET_ID}/{BROWSER_XGBOOST_MODEL_PATH.name}",
            "modelSha256": file_hash(BROWSER_XGBOOST_MODEL_PATH),
            "inferenceGridUrl": f"{DATASET_ID}/{BROWSER_XGBOOST_GRID_PATH.name}",
            "inferenceGridSha256": file_hash(BROWSER_XGBOOST_GRID_PATH),
            "validCentreCount": len(positions), "featureCount": features.shape[1],
            "featureNames": list(names), "ringWidthMeters": int(report["final"]["ringWidthMeters"]),
            "smoothingSigmaMeters": int(report["final"]["smoothingSigmaMeters"]),
            "trainingRanges": report["final"].get("trainingRanges", {}),
        }

    return {
        "baseline": {
            "url": f"{DATASET_ID}/{BROWSER_BASELINE_PATH.name}",
            "sha256": file_hash(BROWSER_BASELINE_PATH), "bands": {
                "state": 1, "sectorIndex": 2, "urbanAtlasClassIndex": 3,
            },
        },
        "outputScopes": {
            "url": f"{DATASET_ID}/{BROWSER_SCOPE_PATH.name}",
            "sha256": file_hash(BROWSER_SCOPE_PATH),
        },
        "sectorIndex": {
            str(index + 1): {
                "sectorId": str(row["sectorId"]), "sectorName": str(row["sectorName"]),
                "municipality": str(row["municipality"]),
            } for index, row in sectors.iterrows()
        },
        "urbanAtlasClassIndexes": class_indexes,
        "outputCoordinates": output_coordinates,
        "xgboost": xgboost_browser,
    }


class ScenarioEngine:
    """Persistent worker state for exact, sparse scenario calculations."""

    def __init__(self):
        self.green_path = CACHE_ROOT / "density-source" / "groenkaart" / "groenkaart-2021-halo.tif"
        self.sealing_path = CACHE_ROOT / "density-source" / "jaarbak" / "jaarbak-2024-halo.tif"
        self.water_context_path = DEFAULT_ANALYSIS_WATER_PATH
        self.urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
        self.landsat_path = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{EXPECTED_SELECTED_OBSERVATIONS[-1]}.tif"
        for path in (
                self.green_path, self.sealing_path, self.water_context_path,
                self.urban_path, self.landsat_path,
                SECTORS_PATH, BASELINE_AREA_STATS_PATH):
            if not path.exists():
                raise FileNotFoundError(f"Prepare the required local source first: {path}")

        self.sectors = gpd.read_file(SECTORS_PATH).to_crs(SOURCE_CRS)
        self.sectors = self.sectors.reset_index(drop=True)
        self.sector_union = self.sectors.geometry.union_all()
        self.urban = gpd.read_file(self.urban_path).to_crs(SOURCE_CRS)
        self.to_source = Transformer.from_crs("EPSG:4326", SOURCE_CRS, always_xy=True).transform
        self.to_wgs84 = Transformer.from_crs(SOURCE_CRS, "EPSG:4326", always_xy=True).transform
        self.output_to_source = None
        self.baseline_area_stats = json.loads(BASELINE_AREA_STATS_PATH.read_text(encoding="utf-8"))

        with rasterio.open(self.green_path) as source:
            self.source_transform = source.transform
            self.source_width = source.width
            self.source_height = source.height
            self.source_bounds = source.bounds
        with rasterio.open(self.landsat_path) as source:
            self.output_transform = source.transform
            self.output_width = source.width
            self.output_height = source.height
            self.output_crs = str(source.crs)
        self.output_to_source = Transformer.from_crs(self.output_crs, SOURCE_CRS, always_xy=True)

        # The analytical output follows Landsat's UTM grid. Rasterising Belgian
        # Lambert geometries directly on that transform silently creates an
        # empty scope index, so project the same authoritative boundaries first.
        self.sector_index_30m = rasterize_scope_index(
            self.sectors, self.output_crs, (self.output_height, self.output_width), self.output_transform,
        )
        self.session_id = None
        self.last_revision = None
        self.last_delta = None
        self.last_deltas_by_method = {}
        self.last_diagnostics_by_method = {}
        self.last_outside_range_by_method = {}
        self.last_operations = []
        self.last_result = None
        self.model_registry = {}

        def register_model(method_id, booster, report, catalog, inference_path):
            if report.get("modelContractVersion") != XGBOOST_MODEL_CONTRACT_VERSION:
                raise ValueError(f"The cached {method_id} model uses an obsolete land-cover contract.")
            if report.get("inferenceGrid", {}).get("sha256") != file_hash(inference_path):
                raise ValueError(f"The cached {method_id} inference-grid hash does not match its report.")
            if report.get("catalogManifestSha256") != file_hash(catalog.cache_dir / "manifest.json"):
                raise ValueError(f"The cached {method_id} catalog does not match its model report.")
            feature_path = DEFAULT_ARTIFACTS.features
            if report.get("featureArtifactSha256") != file_hash(feature_path):
                raise ValueError(f"The cached {method_id} feature artifact does not match its report.")
            with np.load(inference_path, allow_pickle=False) as cached:
                inference = {
                    "positions": cached["positions"].copy(),
                    "features": cached["features"].copy(),
                    "predictions": cached["predictions"].copy(),
                    "rawPredictions": (
                        cached["raw_predictions"].copy()
                        if "raw_predictions" in cached.files else cached["predictions"].copy()
                    ),
                    "featureNames": tuple(cached["feature_names"].tolist()),
                }
            if inference["featureNames"] != tuple(report["final"]["retainedFeatures"]):
                raise ValueError(f"The cached {method_id} inference features do not match its report.")
            if self.model_registry:
                reference = next(iter(self.model_registry.values()))["inference"]["positions"]
                if not np.array_equal(reference, inference["positions"]):
                    raise ValueError(f"The cached {method_id} inference centres do not share the scenario grid.")
            self.model_registry[method_id] = {
                "model": booster, "report": report, "catalog": catalog,
                "inference": inference,
            }

        try:
            from .image_regression import load_regression_catalog
            from .image_regression_xgboost_pipeline import (
                DEFAULT_ARTIFACTS, load_scenario_model,
            )
            loaded = load_scenario_model()
            if loaded is not None and DEFAULT_ARTIFACTS.inference_grid.exists():
                booster, report = loaded
                register_model(
                    "xgboost", booster, report, load_regression_catalog(),
                    DEFAULT_ARTIFACTS.inference_grid,
                )
        except (ImportError, FileNotFoundError, ValueError, OSError):
            # The literature model remains usable when the optional local ML
            # environment or a verified model artifact is unavailable.
            self.model_registry.pop("xgboost", None)
        production = self.model_registry.get("xgboost", {})
        self.xgboost_model = production.get("model")
        self.xgboost_report = production.get("report")
        self.xgboost_catalog = production.get("catalog")
        self.xgboost_inference = production.get("inference")

    def _validate_payload(self, payload):
        if payload.get("schemaVersion") != 1:
            raise ValueError("Unsupported scenario schema.")
        session_id = str(payload.get("sessionId", ""))
        if not SESSION_ID_PATTERN.fullmatch(session_id):
            raise ValueError("Invalid scenario session.")
        revision = int(payload.get("revision", -1))
        if revision < 0:
            raise ValueError("Scenario revision must be non-negative.")
        if stale_revision(self.session_id, self.last_revision, session_id, revision):
            raise ValueError("Scenario revision is stale.")
        raw_operations = payload.get("operations")
        if not isinstance(raw_operations, list) or len(raw_operations) > MAX_OPERATIONS:
            raise ValueError(f"A scenario supports at most {MAX_OPERATIONS} polygon operations.")

        operations = []
        vertex_total = 0
        submitted_area = 0.0
        for raw in raw_operations:
            action = raw.get("action")
            target = raw.get("target")
            valid_action = action in ("convert", "restore", "convert-to-low", "remove-high")
            valid_target = (
                (action == "convert" and target in CLASS_BY_TARGET)
                or (action == "convert-to-low" and target == "low")
                or (action in ("restore", "remove-high") and target is None)
            )
            if not valid_action or not valid_target:
                raise ValueError("Invalid scenario operation.")
            geometry = shape(raw.get("geometry"))
            if not isinstance(geometry, (Polygon, MultiPolygon)) or geometry.is_empty or not geometry.is_valid:
                raise ValueError("Scenario operations require valid Polygon or MultiPolygon geometry.")
            vertex_total += _vertex_count(geometry)
            if vertex_total > MAX_VERTICES:
                raise ValueError(f"A scenario supports at most {MAX_VERTICES} vertices.")
            projected = shapely_transform(self.to_source, geometry)
            submitted_area += projected.area
            clipped = projected.intersection(self.sector_union)
            operations.append({
                "id": str(raw.get("id", ""))[:80],
                "action": action,
                "target": target if action in ("convert", "convert-to-low") else None,
                "geometry": clipped,
                "submittedGeometry": projected,
            })
        if submitted_area > MAX_SUBMITTED_AREA_HA * 10_000:
            raise ValueError(f"Scenario polygon area exceeds {MAX_SUBMITTED_AREA_HA:g} ha.")
        return session_id, revision, operations

    def _tile_keys(self, operations):
        keys = set()
        for operation in operations:
            geometry = operation["geometry"]
            if geometry.is_empty:
                continue
            left, bottom, right, top = geometry.bounds
            row_min, column_min = rowcol(self.source_transform, left, top)
            row_max, column_max = rowcol(self.source_transform, right, bottom)
            row_min = max(0, min(self.source_height - 1, row_min))
            row_max = max(0, min(self.source_height - 1, row_max))
            column_min = max(0, min(self.source_width - 1, column_min))
            column_max = max(0, min(self.source_width - 1, column_max))
            for tile_row in range(row_min // PROCESSING_TILE_SIZE, row_max // PROCESSING_TILE_SIZE + 1):
                for tile_column in range(column_min // PROCESSING_TILE_SIZE, column_max // PROCESSING_TILE_SIZE + 1):
                    keys.add((tile_row, tile_column))
        return sorted(keys)

    def _window_masks(self, transform, height, width, bounds, operations):
        tile_box = box(*bounds)
        matching = [(operation, operation["geometry"].intersection(tile_box)) for operation in operations
                    if not operation["geometry"].is_empty and operation["geometry"].intersects(tile_box)]
        operation_masks = [(
            rasterize([(geometry, 1)], out_shape=(height, width), transform=transform,
                      fill=0, dtype="uint8").astype(bool),
            operation,
        ) for operation, geometry in matching if not geometry.is_empty]
        water_window = raster_window_from_bounds(*bounds, transform=self.source_transform)
        water_window = water_window.round_offsets().round_lengths()
        with rasterio.open(self.water_context_path) as water_source:
            water_values = water_source.read(
                1, window=water_window, out_shape=(height, width),
                resampling=Resampling.nearest,
            )
        water = analysis_water_union(water_values)
        inside = rasterize([(self.sector_union.intersection(tile_box), 1)], out_shape=(height, width),
                           transform=transform, fill=0, dtype="uint8").astype(bool)
        sector_indexes = list(self.sectors.sindex.query(tile_box, predicate="intersects"))
        sector_shapes = [(self.sectors.geometry.iloc[index], index + 1) for index in sector_indexes]
        sector_index = rasterize(sector_shapes, out_shape=(height, width), transform=transform,
                                 fill=0, dtype="uint16")
        return operation_masks, water, inside, sector_index

    @staticmethod
    def _encode_delta(delta, affected, destination):
        code = np.clip(
            np.rint(delta * DELTA_ENCODING_SCALE) + DELTA_ENCODING_OFFSET, 0, 65535,
        ).astype(np.uint16)
        rgba = np.dstack([
            (code >> 8).astype(np.uint8), (code & 255).astype(np.uint8),
            np.zeros(code.shape, dtype=np.uint8), np.where(affected, 255, 0).astype(np.uint8),
        ])
        Image.fromarray(rgba).save(destination, optimize=True)

    def _xgboost_deltas(self, operations):
        """Extract each edited patch once and evaluate every verified ML model."""
        if not self.model_registry:
            return {}, {}, {}
        from .image_regression import (
            LAND_COVER_CHANNEL_NAMES, SUPPORT_MASK,
            _ground_valid, _read_ground_arrays, radial_band_fractions,
        )
        from .image_regression_xgboost_pipeline import outside_training_ranges, radial_band_edges
        from .prediction_smoothing import smooth_masked_predictions
        import xgboost as xgb

        active_geometries = [operation["geometry"] for operation in operations if not operation["geometry"].is_empty]
        empty_delta = lambda: np.zeros((self.output_height, self.output_width), dtype=np.float32)
        empty_outside = lambda: np.zeros((self.output_height, self.output_width), dtype=bool)
        if not active_geometries:
            return (
                {method_id: empty_delta() for method_id in self.model_registry},
                {method_id: {"outsideTrainingRangeCellCount": 0}
                 for method_id in self.model_registry},
                {method_id: empty_outside() for method_id in self.model_registry},
            )
        changed_area = gpd.GeoSeries(active_geometries, crs=SOURCE_CRS).union_all().buffer(100)
        cached_positions = next(iter(self.model_registry.values()))["inference"]["positions"]
        xs = self.source_transform.c + cached_positions[:, 3] * self.source_transform.a
        ys = self.source_transform.f + cached_positions[:, 2] * self.source_transform.e
        nearby = np.asarray([changed_area.covers(shape({"type": "Point", "coordinates": [x, y]}))
                             for x, y in zip(xs, ys)], dtype=bool)
        cached_indexes = np.flatnonzero(nearby)
        if not cached_indexes.size:
            return (
                {method_id: empty_delta() for method_id in self.model_registry},
                {method_id: {"outsideTrainingRangeCellCount": 0}
                 for method_id in self.model_registry},
                {method_id: empty_outside() for method_id in self.model_registry},
            )
        contracts = {}
        for method_id, entry in self.model_registry.items():
            report_final = entry["report"]["final"]
            band_edges = radial_band_edges(report_final.get("ringWidthMeters", 25))
            selected_names = tuple(report_final["retainedFeatures"])
            all_names = tuple(
                f"{channel}_{lower}_{upper}m"
                for channel in LAND_COVER_CHANNEL_NAMES
                for lower, upper in zip(band_edges[:-1], band_edges[1:])
            )
            contracts[method_id] = {
                "bandEdges": band_edges,
                "selectedNames": selected_names,
                "selectedColumns": [all_names.index(name) for name in selected_names],
                "modifiedFeatures": [],
                "baselinePredictions": [],
            }
        output_positions = []
        output_cached_indexes = []
        urban_path = next(iter(self.model_registry.values()))["catalog"].urban_context_path
        water_context_path = next(iter(self.model_registry.values()))["catalog"].water_context_path
        with rasterio.open(self.green_path) as green, rasterio.open(self.sealing_path) as sealing, \
                rasterio.open(urban_path) as urban, rasterio.open(water_context_path) as water_context:
            for cached_index in cached_indexes:
                output_row, output_column, source_row, source_column = cached_positions[cached_index]
                arrays = _read_ground_arrays(
                    (sealing, green, urban, water_context), source_row, source_column,
                )
                if arrays[0].shape != (200, 200) or not _ground_valid(*arrays[:3])[SUPPORT_MASK].all():
                    continue
                soil, green_values, _urban_values, water_values = arrays
                baseline_patch = xgboost_land_cover_channels(
                    green_values, soil, analysis_water_union(water_values),
                )
                modified_patch = baseline_patch.copy()
                patch_transform = sealing.window_transform(Window(source_column - 100, source_row - 100, 200, 200))
                patch_bounds = window_bounds(Window(source_column - 100, source_row - 100, 200, 200), sealing.transform)
                masks, water, inside, _ = self._window_masks(
                    patch_transform, 200, 200, patch_bounds, operations,
                )
                # Context outside Zennevallei remains part of the 100 m model
                # surroundings but is not editable. Masking it out of the
                # baseline would create a false land-cover change near the
                # regional boundary even when the submitted polygon is wholly
                # inside the project area.
                base_canopy, base_ground, editable = baseline_surface_states(
                    green_values, soil, water,
                )
                editable &= inside
                canopy_state, ground_state, _ = apply_surface_operations(
                    base_canopy, base_ground, editable, masks,
                )
                modified_patch = xgboost_channels_from_state(ground_state, canopy_state)
                for method_id, contract in contracts.items():
                    entry = self.model_registry[method_id]
                    contract["baselinePredictions"].append(
                        entry["inference"]["rawPredictions"][cached_index],
                    )
                    contract["modifiedFeatures"].append(radial_band_fractions(
                        modified_patch, SUPPORT_MASK, band_edges=contract["bandEdges"],
                    ).reshape(-1)[contract["selectedColumns"]])
                output_positions.append((output_row, output_column))
                output_cached_indexes.append(cached_index)
        if not output_positions:
            return (
                {method_id: empty_delta() for method_id in self.model_registry},
                {method_id: {"outsideTrainingRangeCellCount": 0}
                 for method_id in self.model_registry},
                {method_id: empty_outside() for method_id in self.model_registry},
            )
        deltas = {}
        diagnostics = {}
        outside_by_method = {}
        for method_id, contract in contracts.items():
            entry = self.model_registry[method_id]
            report_final = entry["report"]["final"]
            selected_names = contract["selectedNames"]
            modified_features = np.asarray(contract["modifiedFeatures"], dtype=np.float32)
            baseline_prediction = np.asarray(contract["baselinePredictions"], dtype=np.float32)
            modified_prediction = entry["model"].predict(
                xgb.DMatrix(modified_features, feature_names=list(selected_names)),
            )
            outside = outside_training_ranges(
                modified_features, selected_names, report_final["trainingRanges"],
            )
            raw_delta_by_cache = np.zeros(len(cached_positions), dtype=np.float32)
            raw_delta_by_cache[np.asarray(output_cached_indexes, dtype=np.int64)] = (
                modified_prediction - baseline_prediction
            )
            sigma_meters = int(report_final.get("smoothingSigmaMeters", 0))
            delta = empty_delta()
            if sigma_meters:
                smoothed = smooth_masked_predictions(
                    raw_delta_by_cache, cached_positions[:, 0], cached_positions[:, 1], sigma_meters,
                )
                for cached_index, (row, column, _, _) in enumerate(cached_positions):
                    delta[row, column] = smoothed[cached_index]
            else:
                for index, (row, column) in enumerate(output_positions):
                    delta[row, column] = modified_prediction[index] - baseline_prediction[index]
            outside_grid = empty_outside()
            for index, (row, column) in enumerate(output_positions):
                outside_grid[row, column] = outside[index]
            delta[self.sector_index_30m == 0] = 0
            deltas[method_id] = delta
            diagnostics[method_id] = {
                "outsideTrainingRangeCellCount": int(np.count_nonzero(outside)),
                "smoothingSigmaMeters": sigma_meters,
                "recalculationHaloMeters": 100 + 3 * sigma_meters,
            }
            outside_by_method[method_id] = outside_grid
        return deltas, diagnostics, outside_by_method

    def _xgboost_delta(self, operations):
        """Backward-compatible access to the production 2026 model."""
        deltas, diagnostics, outside = self._xgboost_deltas(operations)
        return deltas.get("xgboost"), diagnostics.get("xgboost"), outside.get("xgboost")

    def _scope_statistics(self, delta_30m, sector_areas):
        affected = np.abs(delta_30m) >= AFFECTED_THRESHOLD_C
        sectors = {}
        for index, record in self.sectors.iterrows():
            sector_id = str(record["sectorId"])
            mask = (self.sector_index_30m == index + 1) & affected
            sectors[sector_id] = {**sector_areas[index + 1], **_quantiles(delta_30m[mask])}
        municipalities = {}
        for municipality in MUNICIPALITIES:
            municipal = _empty_area_stats()
            ids = [str(row["sectorId"]) for _, row in self.sectors.iterrows() if row["municipality"] == municipality]
            for sector_id in ids:
                _merge_area_stats(municipal, sectors[sector_id])
            numbers = [index + 1 for index, row in self.sectors.iterrows() if row["municipality"] == municipality]
            municipalities[municipality] = {
                **municipal, **_quantiles(delta_30m[np.isin(self.sector_index_30m, numbers) & affected]),
            }
        region = _empty_area_stats()
        for stats in sectors.values():
            _merge_area_stats(region, stats)
        return {"region": {**region, **_quantiles(delta_30m[affected])},
                "municipalities": municipalities, "sectors": sectors}

    @staticmethod
    def _attach_land_cover_balance(stats, baseline):
        """Combine immutable baseline hectares with the final exact edit deltas."""
        before = baseline["groundBeforeHa"]
        change = stats.get("groundDeltaHa", {})
        ground = {}
        for name in ("low", "sealed", "agriculture", "water", "bare"):
            before_value = float(before.get(name, 0))
            change_value = float(change.get(name, 0))
            ground[name] = {
                "beforeHa": round(before_value, 4),
                "changeHa": round(change_value, 4),
                "afterHa": round(before_value + change_value, 4),
            }
        canopy_before = float(baseline.get("highCanopyBeforeHa", 0))
        canopy_change = float(stats.get("highCanopyDeltaHa", 0))
        stats["landCoverBalance"] = {
            "ground": ground,
            "highCanopy": {
                "beforeHa": round(canopy_before, 4),
                "changeHa": round(canopy_change, 4),
                "afterHa": round(canopy_before + canopy_change, 4),
            },
            "validAnalysedAreaHa": round(float(baseline.get("validAnalysedAreaHa", 0)), 4),
            "lockedUnavailableAreaHa": round(float(baseline.get("lockedUnavailableAreaHa", 0)), 4),
        }
        return stats

    def _attach_scope_balances(self, scope_stats):
        self._attach_land_cover_balance(scope_stats["region"], self.baseline_area_stats["region"])
        for municipality, stats in scope_stats["municipalities"].items():
            self._attach_land_cover_balance(
                stats, self.baseline_area_stats["municipalities"][municipality],
            )
        for sector_id, stats in scope_stats["sectors"].items():
            self._attach_land_cover_balance(stats, self.baseline_area_stats["sectors"][sector_id])
        return scope_stats

    @staticmethod
    def _copy_area_accounting(target, source):
        """Use one exact edit-area ledger for both temperature methods.

        Radoux and XGBoost differ only in the estimated thermal response. The
        accepted, locked, no-op and outside areas describe the edits themselves
        and must therefore remain identical when the legend method is switched.
        """
        area_keys = (
            "submittedAreaHa", "acceptedAreaHa", "ignoredAreaHa",
            "noChangeAreaHa", "outsideScopeAreaHa", "transitions",
            "groundDeltaHa", "highCanopyDeltaHa", "landCoverBalance",
        )
        for scope_name in ("region", "municipalities", "sectors"):
            target_scope = target[scope_name]
            source_scope = source[scope_name]
            if scope_name == "region":
                pairs = ((target_scope, source_scope),)
            else:
                pairs = ((target_scope[key], source_scope[key]) for key in target_scope)
            for target_stats, source_stats in pairs:
                for key in area_keys:
                    value = source_stats.get(key)
                    target_stats[key] = dict(value) if isinstance(value, dict) else value
        return target

    def simulate(self, payload):
        session_id, revision, operations = self._validate_payload(payload)
        runtime_id = f"r{revision}-{uuid.uuid4().hex[:10]}"
        output_root = RUNTIME_ROOT / runtime_id
        output_root.mkdir(parents=True, exist_ok=False)

        mixture_height = math.ceil(self.source_height / MIXTURE_RESOLUTION)
        mixture_width = math.ceil(self.source_width / MIXTURE_RESOLUTION)
        delta_mixture = np.zeros((mixture_height, mixture_width), dtype=np.float32)
        sector_areas = {index + 1: _empty_area_stats() for index in range(len(self.sectors))}
        with rasterio.open(self.green_path) as green_source, rasterio.open(self.sealing_path) as sealing_source:
            for tile_row, tile_column in self._tile_keys(operations):
                row_offset = tile_row * PROCESSING_TILE_SIZE
                column_offset = tile_column * PROCESSING_TILE_SIZE
                height = min(PROCESSING_TILE_SIZE, self.source_height - row_offset)
                width = min(PROCESSING_TILE_SIZE, self.source_width - column_offset)
                window = Window(column_offset, row_offset, width, height)
                transform = green_source.window_transform(window)
                bounds = window_bounds(window, green_source.transform)
                green = green_source.read(1, window=window)
                sealing = sealing_source.read(1, window=window)
                operation_masks, water, inside, sector_index = self._window_masks(
                    transform, height, width, bounds, operations,
                )
                if not operation_masks:
                    continue
                baseline_canopy, baseline_ground, editable = baseline_surface_states(
                    green, sealing, water, inside,
                )
                canopy_state, ground_state, touched = apply_surface_operations(
                    baseline_canopy, baseline_ground, editable, operation_masks,
                )
                baseline = upper_surface_class(baseline_canopy, baseline_ground, water, editable)
                simulated = upper_surface_class(canopy_state, ground_state, water, editable)
                if np.any(editable) and not np.all(np.isin(simulated[editable], tuple(COEFFICIENTS))):
                    raise AssertionError("Every editable cell needs one Radoux upper-surface class.")
                state_changed = (
                    (canopy_state != baseline_canopy) | (ground_state != baseline_ground)
                )
                changed = simulated != baseline
                ignored = touched & ~editable
                no_change = touched & editable & ~state_changed

                delta_1m = np.zeros((height, width), dtype=np.float32)
                for source_class, source_coefficient in COEFFICIENTS.items():
                    source = baseline == source_class
                    for target_class, target_coefficient in COEFFICIENTS.items():
                        selected = changed & source & (simulated == target_class)
                        delta_1m[selected] = target_coefficient - source_coefficient

                padded_height = math.ceil(height / MIXTURE_RESOLUTION) * MIXTURE_RESOLUTION
                padded_width = math.ceil(width / MIXTURE_RESOLUTION) * MIXTURE_RESOLUTION
                padded = np.zeros((padded_height, padded_width), dtype=np.float32)
                padded[:height, :width] = delta_1m
                aggregated = padded.reshape(
                    padded_height // MIXTURE_RESOLUTION, MIXTURE_RESOLUTION,
                    padded_width // MIXTURE_RESOLUTION, MIXTURE_RESOLUTION,
                ).mean(axis=(1, 3))
                mixture_row = row_offset // MIXTURE_RESOLUTION
                mixture_column = column_offset // MIXTURE_RESOLUTION
                delta_mixture[
                    mixture_row:mixture_row + aggregated.shape[0],
                    mixture_column:mixture_column + aggregated.shape[1],
                ] = aggregated

                for sector_id in np.unique(sector_index[touched]):
                    if not sector_id:
                        continue
                    selected_sector = sector_index == sector_id
                    final_changed = selected_sector & changed
                    final_state_changed = selected_sector & state_changed
                    stats = sector_areas[int(sector_id)]
                    stats["submittedAreaHa"] += float(np.count_nonzero(selected_sector & touched)) / 10_000
                    stats["acceptedAreaHa"] += float(np.count_nonzero(final_state_changed)) / 10_000
                    stats["ignoredAreaHa"] += float(np.count_nonzero(selected_sector & ignored)) / 10_000
                    stats["noChangeAreaHa"] += float(np.count_nonzero(selected_sector & no_change)) / 10_000
                    for ground_code in (
                            GROUND_LOW, GROUND_SEALED, GROUND_AGRICULTURE,
                            GROUND_WATER, GROUND_BARE):
                        name = GROUND_NAME_BY_CODE[int(ground_code)]
                        gained = np.count_nonzero(
                            final_state_changed & (ground_state == ground_code)
                        )
                        lost = np.count_nonzero(
                            final_state_changed & (baseline_ground == ground_code)
                        )
                        stats["groundDeltaHa"][name] += (gained - lost) / 10_000
                    stats["highCanopyDeltaHa"] += (
                        np.count_nonzero(final_state_changed & canopy_state)
                        - np.count_nonzero(final_state_changed & baseline_canopy)
                    ) / 10_000
                    for source_class in COEFFICIENTS:
                        for target_class in COEFFICIENTS:
                            count = np.count_nonzero(final_changed & (baseline == source_class)
                                                     & (simulated == target_class))
                            if count:
                                key = f"{TARGET_BY_CLASS[source_class]}-to-{TARGET_BY_CLASS[target_class]}"
                                stats["transitions"][key] = stats["transitions"].get(key, 0) + count / 10_000
                    hidden_soil_change = final_state_changed & ~changed \
                        & (baseline_ground != ground_state)
                    for source_value, target_value in ((GROUND_LOW, GROUND_SEALED),
                                                       (GROUND_BARE, GROUND_SEALED),
                                                       (GROUND_SEALED, GROUND_LOW),
                                                       (GROUND_BARE, GROUND_LOW)):
                        count = np.count_nonzero(
                            hidden_soil_change & (baseline_ground == source_value)
                            & (ground_state == target_value)
                        )
                        if count:
                            key = f"{GROUND_NAME_BY_CODE[int(source_value)]}-to-{GROUND_NAME_BY_CODE[int(target_value)]}"
                            stats["transitions"][key] = stats["transitions"].get(key, 0) + count / 10_000

        delta_15m = fftconvolve(delta_mixture, radoux_kernel(), mode="same").astype(np.float32)
        delta_30m = np.zeros((self.output_height, self.output_width), dtype=np.float32)
        mixture_transform = self.source_transform * rasterio.Affine.scale(MIXTURE_RESOLUTION)
        reproject(
            delta_15m,
            delta_30m,
            src_transform=mixture_transform,
            src_crs=SOURCE_CRS,
            dst_transform=self.output_transform,
            dst_crs=self.output_crs,
            src_nodata=None,
            dst_nodata=0,
            resampling=Resampling.bilinear,
        )
        delta_30m[self.sector_index_30m == 0] = 0

        affected = np.abs(delta_30m) >= AFFECTED_THRESHOLD_C
        display_grid = web_display_grid(
            self.output_width, self.output_height, self.output_transform, self.output_crs,
        )
        display_radoux = reproject_delta_for_display(
            delta_30m, self.output_transform, self.output_crs, display_grid,
        )
        delta_path = output_root / "delta-radoux.png"
        self._encode_delta(
            display_radoux, np.abs(display_radoux) >= AFFECTED_THRESHOLD_C, delta_path,
        )
        model_deltas, model_diagnostics, model_outside_range = self._xgboost_deltas(operations)
        model_paths = {}
        for method_id, model_delta in model_deltas.items():
            model_path = output_root / f"delta-{method_id}.png"
            display_model = reproject_delta_for_display(
                model_delta, self.output_transform, self.output_crs, display_grid,
            )
            self._encode_delta(
                display_model, np.abs(display_model) >= AFFECTED_THRESHOLD_C, model_path,
            )
            model_paths[method_id] = model_path

        sectors = {}
        for index, record in self.sectors.iterrows():
            sector_id = str(record["sectorId"])
            mask = (self.sector_index_30m == index + 1) & affected
            stats = sector_areas[index + 1]
            for key in ("acceptedAreaHa", "ignoredAreaHa", "noChangeAreaHa", "outsideScopeAreaHa", "submittedAreaHa"):
                stats[key] = round(float(stats[key]), 4)
            stats["transitions"] = {key: round(float(value), 4) for key, value in stats["transitions"].items()}
            stats["groundDeltaHa"] = {
                key: round(float(value), 4) for key, value in stats["groundDeltaHa"].items()
            }
            stats["highCanopyDeltaHa"] = round(float(stats["highCanopyDeltaHa"]), 4)
            sectors[sector_id] = {**stats, **_quantiles(delta_30m[mask])}

        municipalities = {}
        for municipality in MUNICIPALITIES:
            municipal = _empty_area_stats()
            ids = [str(row["sectorId"]) for _, row in self.sectors.iterrows() if row["municipality"] == municipality]
            for sector_id in ids:
                _merge_area_stats(municipal, sectors[sector_id])
            sector_numbers = [index + 1 for index, row in self.sectors.iterrows() if row["municipality"] == municipality]
            mask = np.isin(self.sector_index_30m, sector_numbers) & affected
            municipalities[municipality] = {**municipal, **_quantiles(delta_30m[mask])}

        region = _empty_area_stats()
        for stats in sectors.values():
            _merge_area_stats(region, stats)
        outside_geometries = [
            operation["submittedGeometry"].difference(self.sector_union)
            for operation in operations
        ]
        outside_union = gpd.GeoSeries(
            [geometry for geometry in outside_geometries if not geometry.is_empty], crs=SOURCE_CRS,
        ).union_all() if any(not geometry.is_empty for geometry in outside_geometries) else None
        region["outsideScopeAreaHa"] = round(
            0.0 if outside_union is None else outside_union.area / 10_000, 4,
        )
        region["submittedAreaHa"] = round(region["submittedAreaHa"] + region["outsideScopeAreaHa"], 4)
        region = {**region, **_quantiles(delta_30m[affected])}

        delta_rasters = {"radoux": {
            "url": f"{DATASET_ID}/runtime/{runtime_id}/{delta_path.name}",
            "sha256": file_hash(delta_path),
            "coordinates": display_grid["coordinates"],
            "width": display_grid["width"], "height": display_grid["height"],
            "encodingScale": DELTA_ENCODING_SCALE, "encodingOffset": DELTA_ENCODING_OFFSET,
            "affectedThresholdC": AFFECTED_THRESHOLD_C,
        }}
        for method_id, model_path in model_paths.items():
            delta_rasters[method_id] = {
                **delta_rasters["radoux"],
                "url": f"{DATASET_ID}/runtime/{runtime_id}/{model_path.name}",
                "sha256": file_hash(model_path),
            }
        radoux_scope_stats = self._attach_scope_balances({
            "region": region, "municipalities": municipalities, "sectors": sectors,
        })
        scope_stats_by_method = {"radoux": radoux_scope_stats}
        for method_id, model_delta in model_deltas.items():
            scope_stats_by_method[method_id] = self._copy_area_accounting(
                self._scope_statistics(model_delta, sector_areas),
                radoux_scope_stats,
            )
        diagnostics_by_method = {
            "radoux": {"method": "radoux-linear-mixture"},
            **model_diagnostics,
        }
        result = {
            "schemaVersion": 6,
            "sessionId": session_id,
            "revision": revision,
            "deltaRasters": delta_rasters,
            "scopeStats": radoux_scope_stats,
            "scopeStatsByMethod": scope_stats_by_method,
            "diagnosticsByMethod": diagnostics_by_method,
        }
        self.session_id = session_id
        self.last_revision = revision
        self.last_delta = delta_30m
        self.last_deltas_by_method = {"radoux": delta_30m, **model_deltas}
        self.last_diagnostics_by_method = diagnostics_by_method
        self.last_outside_range_by_method = model_outside_range
        self.last_operations = operations
        self.last_result = result
        return result

    def inspect(self, payload):
        session_id = str(payload.get("sessionId", ""))
        revision = int(payload.get("revision", -1))
        if session_id != self.session_id or revision != self.last_revision or self.last_delta is None:
            raise ValueError("The requested scenario revision is not active.")
        longitude = float(payload.get("lng"))
        latitude = float(payload.get("lat"))
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            raise ValueError("Invalid coordinates.")
        x, y = Transformer.from_crs("EPSG:4326", SOURCE_CRS, always_xy=True).transform(longitude, latitude)
        source_row, source_column = rowcol(self.source_transform, x, y)
        if source_row < 0 or source_column < 0 or source_row >= self.source_height or source_column >= self.source_width:
            return {"status": "outside"}
        point = shape({"type": "Point", "coordinates": [x, y]})
        if not self.sector_union.covers(point):
            return {"status": "outside"}
        with rasterio.open(self.green_path) as green, rasterio.open(self.sealing_path) as sealing, \
                rasterio.open(self.water_context_path) as water_source:
            window = Window(source_column, source_row, 1, 1)
            green_value = green.read(1, window=window)[0, 0]
            sealing_value = sealing.read(1, window=window)[0, 0]
            water = bool(analysis_water_union(water_source.read(1, window=window))[0, 0])
        baseline_canopy, baseline_ground, editable_grid = baseline_surface_states(
            np.asarray([[green_value]]), np.asarray([[sealing_value]]),
            np.asarray([[water]]), np.asarray([[True]]),
        )
        point_operations = [
            (np.ones((1, 1), dtype=bool), operation)
            for operation in self.last_operations if operation["geometry"].covers(point)
        ]
        canopy_state, ground_state, _ = apply_surface_operations(
            baseline_canopy, baseline_ground, editable_grid, point_operations,
        )
        editable = bool(editable_grid[0, 0])
        baseline = upper_surface_class(
            baseline_canopy, baseline_ground, np.asarray([[water]]), editable_grid,
        )[0, 0]
        simulated = upper_surface_class(
            canopy_state, ground_state, np.asarray([[water]]), editable_grid,
        )[0, 0]
        urban_indexes = list(self.urban.sindex.query(point, predicate="intersects"))
        urban_code = next((str(self.urban.iloc[index]["classCode"]) for index in urban_indexes
                           if self.urban.geometry.iloc[index].covers(point)), None)
        transformer = Transformer.from_crs("EPSG:4326", self.output_crs, always_xy=True)
        output_x, output_y = transformer.transform(longitude, latitude)
        output_row, output_column = rowcol(self.output_transform, output_x, output_y)
        delta_by_method = {method_id: None for method_id in self.last_deltas_by_method}
        if 0 <= output_row < self.output_height and 0 <= output_column < self.output_width:
            delta_by_method = {
                method_id: round(float(values[output_row, output_column]), 4)
                for method_id, values in self.last_deltas_by_method.items()
            }
        selected_method = str(payload.get("method") or "radoux")
        outside_grid = self.last_outside_range_by_method.get(selected_method)
        return {
            "status": "available",
            "baselineClass": TARGET_BY_CLASS.get(baseline, "water" if baseline == CLASS_WATER else "locked"),
            "simulatedClass": TARGET_BY_CLASS.get(simulated, "water" if simulated == CLASS_WATER else "locked"),
            "editable": editable,
            "baselineGround": GROUND_NAME_BY_CODE[int(baseline_ground[0, 0])],
            "simulatedGround": GROUND_NAME_BY_CODE[int(ground_state[0, 0])],
            "baselineHighCanopy": bool(baseline_canopy[0, 0]),
            "simulatedHighCanopy": bool(canopy_state[0, 0]),
            "changed": bool(
                canopy_state[0, 0] != baseline_canopy[0, 0]
                or ground_state[0, 0] != baseline_ground[0, 0]
            ),
            "deltaCByMethod": delta_by_method,
            "diagnosticsByMethod": self.last_diagnostics_by_method,
            "selectedMethod": selected_method,
            "outsideTrainingRange": bool(
                outside_grid is not None
                and 0 <= output_row < self.output_height and 0 <= output_column < self.output_width
                and outside_grid[output_row, output_column]
            ),
            "urbanAtlasClassCode": urban_code,
        }


def prepare_lst_scenario():
    """Validate dependencies and publish the local-only scenario descriptor."""
    from .image_regression import prepare_regression_catalog

    regression_catalog = prepare_regression_catalog()
    water_context_path = regression_catalog.water_context_path
    dependencies = [
        CACHE_ROOT / "density-source" / "groenkaart" / "groenkaart-2021-halo.tif",
        CACHE_ROOT / "density-source" / "jaarbak" / "jaarbak-2024-halo.tif",
        CACHE_ROOT / "landsat-temperature" / "analysis" / f"{EXPECTED_SELECTED_OBSERVATIONS[-1]}.tif",
        PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson",
        SECTORS_PATH,
        water_context_path,
    ]
    missing = [path for path in dependencies if not path.exists()]
    if missing:
        raise FileNotFoundError("Prepare Green Map, Soil sealing, Urban Atlas and Landsat grids first: "
                                + ", ".join(str(path) for path in missing))
    destination = CACHE_ROOT / DATASET_ID
    destination.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(RUNTIME_ROOT, ignore_errors=True)
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    baseline_area_stats = _baseline_area_statistics(
        dependencies[0], dependencies[1], water_context_path, dependencies[4],
    )
    BASELINE_AREA_STATS_PATH.write_text(
        json.dumps(baseline_area_stats, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    def verified_model_metadata(artifact_root, catalog_manifest, expected_observation):
        report_path = artifact_root / "report.json"
        model_path = artifact_root / "model.json"
        inference_path = artifact_root / "baseline-inference-grid.npz"
        feature_path = artifact_root / "features.npz"
        if not all(path.exists() for path in (
                report_path, model_path, feature_path, inference_path, catalog_manifest)):
            return False, None
        try:
            metadata = json.loads(report_path.read_text(encoding="utf-8"))
            available = (
                metadata.get("observationId") == expected_observation
                and metadata.get("modelContractVersion") == XGBOOST_MODEL_CONTRACT_VERSION
                and metadata.get("final", {}).get("modelSha256") == file_hash(model_path)
                and metadata.get("featureArtifactSha256") == file_hash(feature_path)
                and metadata.get("inferenceGrid", {}).get("sha256") == file_hash(inference_path)
                and metadata.get("catalogManifestSha256") == file_hash(catalog_manifest)
            )
            return available, metadata
        except (json.JSONDecodeError, OSError, ValueError):
            return False, None

    model_specs = {"xgboost": {
        "root": CACHE_ROOT / "image-regression" / "xgboost-2026",
        "catalog": CACHE_ROOT / "image-regression" / "landsat-2026-06-22" / "manifest.json",
        "observationId": "landsat-2026-06-22",
        "label": "2026 Heatwave XGBoost",
        "sourceName": "2026 Heatwave XGBoost training notebook",
    }}
    for spec in model_specs.values():
        spec["available"], spec["metadata"] = verified_model_metadata(
            spec["root"], spec["catalog"], spec["observationId"],
        )
    from .sealed_urban_comparisons import _prepare_urban_atlas_class_mask
    urban_class_mask = _prepare_urban_atlas_class_mask()
    browser_water_mask = _prepare_analysis_water_browser_mask(water_context_path, destination)
    water_metadata = analysis_water_metadata(water_context_path)
    browser_runtime = _prepare_browser_scenario_assets(
        dependencies[0], dependencies[1], water_context_path, dependencies[3],
        dependencies[4], dependencies[2], model_specs["xgboost"]["root"],
    )
    with rasterio.open(dependencies[0]) as source, rasterio.open(dependencies[2]) as landsat:
        manifest = {
            "schemaVersion": 7,
            "datasetId": DATASET_ID,
            "kind": "scenario",
            "baselineYears": {
                "greenMap": GREEN_BASELINE_YEAR, "urbanAtlas": 2021,
                "soilSealing": SOIL_BASELINE_YEAR, "landUseWater": LAND_USE_YEAR,
            },
            "available": True,
            "source": {
                "name": "Radoux et al. (2025) land-cover linear mixture model",
                "url": "https://doi.org/10.3390/rs17162815",
            },
            "coefficientsC": {"high": -7.42, "low": -2.07, "sealed": 3.20, "bareProxy": 6.70},
            "stateContract": {
                "ground": ["low", "sealed", "agriculture", "water", "bare", "locked"],
                "latentOverlap": "high-canopy-over-ground-for-editing-only",
                "analysisSurface": "mutually-exclusive-upper-surface-v5-landgebruik-water",
                "priority": ["water", "agriculture", "high", "sealed", "low", "bare", "locked"],
            },
            "baselineAreaStatistics": {
                "url": f"{DATASET_ID}/{BASELINE_AREA_STATS_PATH.name}",
                "sha256": file_hash(BASELINE_AREA_STATS_PATH),
                "resolutionMeters": SOURCE_RESOLUTION,
            },
            "browserRuntime": {
                "protocolVersion": 1,
                "engine": "web-worker-exact-area",
                "baseline": browser_runtime["baseline"],
                "outputScopes": browser_runtime["outputScopes"],
                "sectorIndex": browser_runtime["sectorIndex"],
                "xgboost": browser_runtime["xgboost"],
            },
            "urbanAtlasClassMaskUrl": urban_class_mask["url"],
            "urbanAtlasClassIndexes": urban_class_mask["classIndexes"],
            "analysisWaterMask": {
                **browser_water_mask,
                "rendered": False,
                "editable": False,
                "landUseYear": LAND_USE_YEAR,
                "landUseWaterCode": LAND_USE_WATER_CODE,
                "resampling": "nearest",
                "audit": water_metadata["audit"],
            },
            "psf": {
                "sigmaMeters": PSF_SIGMA_METERS,
                "gridResolutionMeters": MIXTURE_RESOLUTION,
                "kernelSize": PSF_SIZE,
                "haloMeters": PSF_HALO_METERS,
            },
            "maskResolutionMeters": SOURCE_RESOLUTION,
            "temperatureGridResolutionMeters": OUTPUT_RESOLUTION,
            "affectedThresholdC": AFFECTED_THRESHOLD_C,
            "displayRangeC": [-14.12, 14.12],
            "methodOrder": ["radoux", "xgboost"],
            "methods": {
                "radoux": {
                    "available": True, "label": "Radoux et al. model",
                    "productId": "radoux",
                    "source": {
                        "name": "Radoux et al. (2025) daylight LST model",
                        "url": "https://doi.org/10.3390/rs17162815",
                    },
                },
                **{
                    method_id: {
                        "available": spec["available"], "label": spec["label"],
                        "productId": method_id,
                        "source": {
                            "name": spec["sourceName"],
                            "url": XGBOOST_NOTEBOOK_URL,
                        },
                        "observationId": spec["observationId"],
                        "modelContractVersion": spec["metadata"].get("modelContractVersion")
                            if spec["metadata"] else None,
                        "target": spec["metadata"].get("target") if spec["metadata"] else None,
                        "modelSha256": spec["metadata"].get("final", {}).get("modelSha256")
                            if spec["metadata"] else None,
                        "reportSha256": file_hash(spec["root"] / "report.json")
                            if spec["available"] else None,
                        "catalogManifestSha256": spec["metadata"].get("catalogManifestSha256")
                            if spec["metadata"] else None,
                        "featureArtifactSha256": spec["metadata"].get("featureArtifactSha256")
                            if spec["metadata"] else None,
                        "inferenceGrid": {
                            key: value for key, value in spec["metadata"].get(
                                "inferenceGrid", {},
                            ).items() if key != "path"
                        } if spec["metadata"] else None,
                        "retainedFeatureCount": len(spec["metadata"].get("final", {}).get(
                            "retainedFeatures", (),
                        )) if spec["metadata"] else None,
                        "pooledOuterMetrics": spec["metadata"].get("pooledOuterMetrics")
                            if spec["metadata"] else None,
                        "smoothingSigmaMeters": spec["metadata"].get("final", {}).get(
                            "smoothingSigmaMeters", 0,
                        ) if spec["metadata"] else 0,
                    }
                    for method_id, spec in model_specs.items()
                },
            },
            "limits": {
                "operations": MAX_OPERATIONS,
                "vertices": MAX_VERTICES,
                "submittedAreaHa": MAX_SUBMITTED_AREA_HA,
            },
            "sourceGrid": {
                "crs": str(source.crs), "width": source.width, "height": source.height,
                "bounds": list(source.bounds),
                "transform": list(tuple(source.transform)[:6]),
            },
            "outputGrid": {
                "crs": str(landsat.crs), "width": landsat.width, "height": landsat.height,
                "bounds": list(landsat.bounds),
                "transform": list(tuple(landsat.transform)[:6]),
                "coordinates": browser_runtime["outputCoordinates"],
            },
            "provenance": {
                "greenMapSha256": file_hash(dependencies[0]),
                "soilSealingSha256": file_hash(dependencies[1]),
                "urbanAtlasSha256": file_hash(dependencies[3]),
                "analysisWaterSha256": file_hash(water_context_path),
                "landUseWaterSha256": water_metadata["landUseSha256"],
                "sectorsSha256": file_hash(dependencies[4]),
            },
        }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return manifest


def worker_loop():
    shutil.rmtree(RUNTIME_ROOT, ignore_errors=True)
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    engine = ScenarioEngine()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            command = request.get("command")
            payload = request.get("payload") or {}
            if command == "simulate":
                result = engine.simulate(payload)
            elif command == "inspect":
                result = engine.inspect(payload)
            else:
                raise ValueError("Unknown scenario worker command.")
            response = {"requestId": request.get("requestId"), "ok": True, "result": result}
        except Exception as error:  # keep the persistent worker recoverable
            response = {"requestId": request.get("requestId") if "request" in locals() else None,
                        "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    arguments = parser.parse_args(argv)
    if arguments.worker:
        worker_loop()
    else:
        prepare_lst_scenario()


if __name__ == "__main__":
    main()
