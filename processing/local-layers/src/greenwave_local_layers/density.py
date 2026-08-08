"""Prepare browser-ready 100 m focal surface-density rasters.

The official 1 m categorical rasters remain the analytical authority. They are
aggregated to fractional 10 m cells before an area-weighted circular focal sum
is applied. A 100 m source halo prevents administrative boundaries from
biasing values whose display centre lies inside Zennevallei.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.io import MemoryFile
from rasterio.shutil import copy as rio_copy
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from scipy.signal import fftconvolve

from .constants import ANB_WCS, CACHE_ROOT, JAARBAK_LAYERS, MERCATOR_WCS, MUNICIPALITIES
from .sources import file_hash, request_wcs_tiff


RADIUS_METERS = 100
ANALYSIS_RESOLUTION = 10
BROWSER_RESOLUTION = 20
VALID_COVERAGE_THRESHOLD = 0.95
ENCODING_SCALE = 100
ENCODING_NODATA = 65535
DENSITY_CODES = {"jaarbak": (1,), "groenkaart": (1, 2, 3, 4)}


def aligned_bounds(bounds, resolution=ANALYSIS_RESOLUTION):
    """Expand bounds to complete analysis cells."""
    minx, miny, maxx, maxy = bounds
    return (
        math.floor(minx / resolution) * resolution,
        math.floor(miny / resolution) * resolution,
        math.ceil(maxx / resolution) * resolution,
        math.ceil(maxy / resolution) * resolution,
    )


def circular_kernel(radius_m=RADIUS_METERS, resolution=ANALYSIS_RESOLUTION, samples=20):
    """Return fractional 10 m-cell intersections with a circular buffer."""
    cell_radius = math.ceil(radius_m / resolution)
    offsets = np.arange(-cell_radius, cell_radius + 1, dtype=np.float64)
    sub = (np.arange(samples, dtype=np.float64) + 0.5) / samples - 0.5
    kernel = np.zeros((offsets.size, offsets.size), dtype=np.float32)
    for row, dy in enumerate(offsets):
        ys = (dy + sub[:, None]) * resolution
        for column, dx in enumerate(offsets):
            xs = (dx + sub[None, :]) * resolution
            kernel[row, column] = np.count_nonzero(xs * xs + ys * ys <= radius_m * radius_m) / (samples * samples)
    return kernel


def focal_density(class_fractions, valid_fraction, kernel=None, valid_threshold=VALID_COVERAGE_THRESHOLD):
    """Calculate complete-circle class percentages and valid coverage."""
    classes = np.asarray(class_fractions, dtype=np.float32)
    valid = np.asarray(valid_fraction, dtype=np.float32)
    if classes.ndim != 3 or valid.shape != classes.shape[1:]:
        raise ValueError("Density fractions must have shape (classes, rows, columns).")
    weights = circular_kernel() if kernel is None else np.asarray(kernel, dtype=np.float32)
    denominator = float(np.sum(weights))
    if denominator <= 0:
        raise ValueError("Density kernel has no area.")
    coverage = fftconvolve(valid, weights, mode="same") / denominator
    densities = np.stack([
        fftconvolve(values, weights, mode="same") / denominator * 100.0
        for values in classes
    ]).astype(np.float32)
    unavailable = coverage < valid_threshold
    densities[:, unavailable] = np.nan
    coverage = np.clip(coverage * 100.0, 0.0, 100.0).astype(np.float32)
    coverage[unavailable] = np.nan
    return densities, coverage


def encode_percentage(values):
    """Encode percentage values as hundredths with a dedicated no-data code."""
    array = np.asarray(values, dtype=np.float32)
    encoded = np.full(array.shape, ENCODING_NODATA, dtype=np.uint16)
    valid = np.isfinite(array)
    encoded[valid] = np.rint(np.clip(array[valid], 0.0, 100.0) * ENCODING_SCALE).astype(np.uint16)
    return encoded


def _coverage_request(dataset_id, year):
    if dataset_id == "jaarbak":
        return MERCATOR_WCS, JAARBAK_LAYERS[year]
    return ANB_WCS, f"Grnkrt{str(year)[-2:]}"


def _missing_rectangles(source_bounds, target_bounds):
    left, bottom, right, top = target_bounds
    source_left, source_bottom, source_right, source_top = source_bounds
    rectangles = []
    if source_top < top:
        rectangles.append((left, max(source_top, bottom), right, top))
    if source_bottom > bottom:
        rectangles.append((left, bottom, right, min(source_bottom, top)))
    middle_bottom = max(bottom, source_bottom)
    middle_top = min(top, source_top)
    if middle_top > middle_bottom and source_left > left:
        rectangles.append((left, middle_bottom, min(source_left, right), middle_top))
    if middle_top > middle_bottom and source_right < right:
        rectangles.append((max(source_right, left), middle_bottom, right, middle_top))
    return [item for item in rectangles if item[2] > item[0] and item[3] > item[1]]


def ensure_halo_source(source_path, dataset_id, year, target_bounds, destination):
    """Cache the small Zennevallei source window plus the required 100 m halo."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_sha = file_hash(source_path)
    if destination.exists():
        with rasterio.open(destination) as cached:
            if (
                tuple(cached.bounds) == tuple(target_bounds)
                and cached.tags().get("source_sha256") == source_sha
                and cached.width == int(target_bounds[2] - target_bounds[0])
                and cached.height == int(target_bounds[3] - target_bounds[1])
            ):
                return destination, source_sha
    nodata = 255 if dataset_id == "jaarbak" else 0
    width = int(target_bounds[2] - target_bounds[0])
    height = int(target_bounds[3] - target_bounds[1])
    # A process can be interrupted while GDAL still owns its temporary file on
    # Windows. A process-specific name keeps a later preparation run usable;
    # completed files are still moved atomically to the stable cache path.
    temporary = destination.with_name(f".{destination.stem}-{os.getpid()}.partial.tif")
    temporary.unlink(missing_ok=True)
    with rasterio.open(source_path) as source, rasterio.open(
        temporary,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="uint8",
        crs="EPSG:31370",
        transform=from_origin(target_bounds[0], target_bounds[3], 1, 1),
        nodata=nodata,
        tiled=True,
        blockxsize=512,
        blockysize=512,
        compress="DEFLATE",
    ) as output:
        for _, block_window in output.block_windows(1):
            output.write(
                np.full((int(block_window.height), int(block_window.width)), nodata, dtype=np.uint8),
                1,
                window=block_window,
            )
        reproject(
            source=rasterio.band(source, 1),
            destination=rasterio.band(output, 1),
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=output.transform,
            dst_crs=output.crs,
            dst_nodata=nodata,
            resampling=Resampling.nearest,
        )
        rectangles = _missing_rectangles(source.bounds, target_bounds)
        if rectangles:
            url, coverage = _coverage_request(dataset_id, year)
            for index, bounds in enumerate(rectangles, start=1):
                part_width = int(round(bounds[2] - bounds[0]))
                part_height = int(round(bounds[3] - bounds[1]))
                print(f"  {dataset_id} {year}: downloading density halo {index}/{len(rectangles)}", flush=True)
                payload = request_wcs_tiff(url, coverage, bounds, part_width, part_height)
                with MemoryFile(payload) as memory, memory.open() as part:
                    values = part.read(
                        1,
                        out_shape=(part_height, part_width),
                        resampling=Resampling.nearest,
                    ).astype(np.uint8)
                window = rasterio.windows.from_bounds(*bounds, transform=output.transform).round_offsets().round_lengths()
                output.write(values, 1, window=window)
        output.update_tags(source_sha256=source_sha, radius_halo_m=str(RADIUS_METERS))
    temporary.replace(destination)
    return destination, source_sha


def _fraction_grid(source_path, codes):
    """Aggregate native 1 m classes into exact 10 m fractional cells."""
    with rasterio.open(source_path) as source:
        if source.width % ANALYSIS_RESOLUTION or source.height % ANALYSIS_RESOLUTION:
            raise ValueError("Density halo grid must be divisible by the 10 m analysis resolution.")
        target_width = source.width // ANALYSIS_RESOLUTION
        target_height = source.height // ANALYSIS_RESOLUTION
        fractions = np.zeros((len(codes), target_height, target_width), dtype=np.float32)
        valid_fraction = np.zeros((target_height, target_width), dtype=np.float32)
        rows_per_chunk = 1000
        for target_row in range(0, target_height, rows_per_chunk // ANALYSIS_RESOLUTION):
            target_rows = min(rows_per_chunk // ANALYSIS_RESOLUTION, target_height - target_row)
            window = rasterio.windows.Window(
                0,
                target_row * ANALYSIS_RESOLUTION,
                source.width,
                target_rows * ANALYSIS_RESOLUTION,
            )
            values = source.read(1, window=window)
            masks = source.read_masks(1, window=window) > 0
            reshaped_valid = masks.reshape(target_rows, ANALYSIS_RESOLUTION, target_width, ANALYSIS_RESOLUTION)
            valid_fraction[target_row:target_row + target_rows] = reshaped_valid.mean(axis=(1, 3))
            for band, code in enumerate(codes):
                selected = masks & (values == code)
                fractions[band, target_row:target_row + target_rows] = selected.reshape(
                    target_rows, ANALYSIS_RESOLUTION, target_width, ANALYSIS_RESOLUTION
                ).mean(axis=(1, 3))
    return fractions, valid_fraction


def _browser_grid(display_bounds, sectors):
    source_width = int((display_bounds[2] - display_bounds[0]) / ANALYSIS_RESOLUTION)
    source_height = int((display_bounds[3] - display_bounds[1]) / ANALYSIS_RESOLUTION)
    projected = transform_bounds("EPSG:31370", "EPSG:3857", *display_bounds, densify_pts=21)
    # The scientific focal calculation stays on the exact 10 m grid. The
    # browser derivative is 20 m to keep every published year comfortably
    # inside the agreed bundle budget while retaining far more detail than the
    # 100 m neighbourhood being visualised.
    bounds = aligned_bounds(projected, BROWSER_RESOLUTION)
    transform = from_origin(bounds[0], bounds[3], BROWSER_RESOLUTION, BROWSER_RESOLUTION)
    width = int((bounds[2] - bounds[0]) / BROWSER_RESOLUTION)
    height = int((bounds[3] - bounds[1]) / BROWSER_RESOLUTION)
    return {
        "sourceTransform": from_origin(display_bounds[0], display_bounds[3], ANALYSIS_RESOLUTION, ANALYSIS_RESOLUTION),
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "bounds": bounds,
        "transform": transform,
        "width": width,
        "height": height,
    }


def _write_density_cog(destination, densities, coverage, browser_grid, codes, dataset_id, year, source_sha):
    radius_cells = RADIUS_METERS // ANALYSIS_RESOLUTION
    cropped = densities[:, radius_cells:-radius_cells, radius_cells:-radius_cells]
    cropped_coverage = coverage[radius_cells:-radius_cells, radius_cells:-radius_cells]
    bands = []
    for values in [*cropped, cropped_coverage]:
        projected = np.full((browser_grid["height"], browser_grid["width"]), np.nan, dtype=np.float32)
        reproject(
            source=values,
            destination=projected,
            src_transform=browser_grid["sourceTransform"],
            src_crs="EPSG:31370",
            src_nodata=np.nan,
            dst_transform=browser_grid["transform"],
            dst_crs="EPSG:3857",
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        bands.append(encode_percentage(projected))
    temporary = destination.with_suffix(".working.tif")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        temporary,
        "w",
        driver="GTiff",
        width=browser_grid["width"],
        height=browser_grid["height"],
        count=len(bands),
        dtype="uint16",
        crs="EPSG:3857",
        transform=browser_grid["transform"],
        nodata=ENCODING_NODATA,
        tiled=True,
        blockxsize=512,
        blockysize=512,
        compress="DEFLATE",
        predictor=2,
    ) as output:
        for index, values in enumerate(bands, start=1):
            output.write(values, index)
            output.set_band_description(index, f"class-{codes[index - 1]}" if index <= len(codes) else "valid-coverage")
        output.update_tags(
            dataset_id=dataset_id,
            year=str(year),
            radius_m=str(RADIUS_METERS),
            encoding_scale=str(ENCODING_SCALE),
            denominator="complete-circle",
            source_sha256=source_sha,
        )
    destination.unlink(missing_ok=True)
    rio_copy(
        temporary,
        destination,
        driver="COG",
        compress="DEFLATE",
        predictor="YES",
        blocksize=512,
        overview_resampling="average",
    )
    temporary.unlink(missing_ok=True)


def _write_scope_index(path, sectors, municipalities, browser_grid):
    municipality_indexes = {name: index for index, name in enumerate(MUNICIPALITIES, start=1)}
    projected = municipalities.to_crs("EPSG:3857")
    municipality = rasterize(
        [(row.geometry, municipality_indexes[row.municipality]) for _, row in projected.iterrows()],
        out_shape=(browser_grid["height"], browser_grid["width"]),
        transform=browser_grid["transform"],
        fill=0,
        dtype="uint8",
    )
    inside = rasterize(
        [(sectors.to_crs("EPSG:3857").geometry.union_all(), 255)],
        out_shape=municipality.shape,
        transform=browser_grid["transform"],
        fill=0,
        dtype="uint8",
    )
    rgba = np.zeros((*municipality.shape, 4), dtype=np.uint8)
    rgba[..., 0] = municipality
    rgba[..., 1] = inside
    rgba[..., 3] = 255
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)
    return municipality_indexes


def _coordinates(bounds_3857):
    west, south, east, north = transform_bounds("EPSG:3857", "EPSG:4326", *bounds_3857)
    return [[west, north], [east, north], [east, south], [west, south]]


def prepare_density_dataset(dataset_id, years, sectors, municipalities, source_paths):
    """Prepare all density years and return the manifest density contract."""
    if dataset_id not in DENSITY_CODES:
        return None
    projected = sectors.to_crs("EPSG:31370")
    display_bounds = aligned_bounds(projected.total_bounds)
    padded_bounds = (
        display_bounds[0] - RADIUS_METERS,
        display_bounds[1] - RADIUS_METERS,
        display_bounds[2] + RADIUS_METERS,
        display_bounds[3] + RADIUS_METERS,
    )
    browser_grid = _browser_grid(display_bounds, sectors)
    output_root = CACHE_ROOT / dataset_id / "density"
    source_root = CACHE_ROOT / "density-source" / dataset_id
    scope_path = output_root / "scope-index.png"
    municipality_indexes = _write_scope_index(scope_path, sectors, municipalities, browser_grid)
    contract = {
        "schemaVersion": 1,
        "radiusMeters": RADIUS_METERS,
        "circleAreaHa": math.pi * RADIUS_METERS * RADIUS_METERS / 10000.0,
        "analysisResolutionMeters": ANALYSIS_RESOLUTION,
        "browserResolutionMeters": BROWSER_RESOLUTION,
        "encodingScale": ENCODING_SCALE,
        "noDataValue": ENCODING_NODATA,
        "validCoverageThreshold": VALID_COVERAGE_THRESHOLD * 100.0,
        "denominator": "complete-circle",
        "includeBeyondZennevallei": True,
        "coordinates": _coordinates(browser_grid["bounds"]),
        "boundsEpsg3857": list(browser_grid["bounds"]),
        "imageSize": [browser_grid["width"], browser_grid["height"]],
        "scopeIndexUrl": f"{dataset_id}/density/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
        "municipalityIndexes": municipality_indexes,
        "bands": [
            *[{"code": int(code), "index": index} for index, code in enumerate(DENSITY_CODES[dataset_id], start=1)],
            {"code": "validCoverage", "index": len(DENSITY_CODES[dataset_id]) + 1},
        ],
        "years": {},
    }
    kernel = circular_kernel()
    for year in years:
        source_path = Path(source_paths[year])
        halo, source_sha = ensure_halo_source(
            source_path,
            dataset_id,
            year,
            padded_bounds,
            source_root / f"{dataset_id}-{year}-halo.tif",
        )
        destination = output_root / f"{dataset_id}-{year}-density.tif"
        reuse = False
        if destination.exists():
            try:
                with rasterio.open(destination) as existing:
                    reuse = (
                        existing.tags().get("source_sha256") == source_sha
                        and existing.tags().get("radius_m") == str(RADIUS_METERS)
                        and existing.width == browser_grid["width"]
                        and existing.height == browser_grid["height"]
                    )
            except (OSError, rasterio.errors.RasterioIOError):
                reuse = False
        if not reuse:
            print(f"{dataset_id} {year}: calculating 100 m density", flush=True)
            fractions, valid = _fraction_grid(halo, DENSITY_CODES[dataset_id])
            densities, coverage = focal_density(fractions, valid, kernel)
            _write_density_cog(
                destination,
                densities,
                coverage,
                browser_grid,
                DENSITY_CODES[dataset_id],
                dataset_id,
                year,
                source_sha,
            )
        else:
            print(f"{dataset_id} {year}: reusing 100 m density", flush=True)
        contract["years"][str(year)] = {
            "dataUrl": f"{dataset_id}/density/{destination.name}",
            "sha256": file_hash(destination),
            "bytes": destination.stat().st_size,
            "sourceSha256": source_sha,
        }
    contract["totalBytes"] = sum(entry["bytes"] for entry in contract["years"].values()) + scope_path.stat().st_size
    if contract["totalBytes"] > 80 * 1024 * 1024:
        raise ValueError(f"{dataset_id}: density derivatives exceed the 80 MiB budget.")
    return contract
