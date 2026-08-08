"""Prepare local Landsat 8/9 surface-temperature observations.

The analytical GeoTIFFs preserve temperature, observation status and product
uncertainty on one aligned 30 m grid. PMTiles are presentation derivatives;
all sector and municipality statistics come from the analytical grid.
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import planetary_computer
import rasterio
from pystac_client import Client
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from shapely.geometry import mapping

from .constants import CACHE_ROOT, MUNICIPALITIES
from .pipeline import (
    _pmtiles, _validate_pmtiles, _write_cutline, file_hash, load_areas, slug,
    update_index,
)

COLLECTION = "landsat-c2-l2"
STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
TEMPERATURE_SCALE = 0.00341802
TEMPERATURE_OFFSET_K = 149.0
KELVIN_OFFSET = 273.15
CLOUD_BITS = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5)
# QA_RADSAT carries the Level-1 detector saturation flags into Level 2. Mask
# every Landsat 8/9 spectral saturation bit, while leaving terrain occlusion
# (bit 11) as a distinct condition rather than calling it saturation.
RADIOMETRIC_SATURATION_BITS = sum(1 << bit for bit in (0, 1, 2, 3, 4, 5, 6, 8))
GRID_CRS = "EPSG:32631"
GRID_RESOLUTION = 30.0
MINIMUM_HEATWAVE_COVERAGE = 10.0
TEMPERATURE_MINIMUM = 15.0
TEMPERATURE_MAXIMUM = 50.0

INFERNO_STOPS = (
    (0.00, "#000004"), (0.14, "#1b0c41"), (0.29, "#4a0c6b"),
    (0.43, "#781c6d"), (0.57, "#a52c60"), (0.71, "#cf4446"),
    (0.86, "#ed6925"), (1.00, "#fcffa4"),
)

HEATWAVES = (
    {"id": "2020-08", "start": "2020-08-05", "end": "2020-08-16", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2016-2020/2020/augustus"},
    {"id": "2022-08", "start": "2022-08-09", "end": "2022-08-16", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2022/augustus"},
    {"id": "2023-06", "start": "2023-06-08", "end": "2023-06-17", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2023/jaar"},
    {"id": "2023-09", "start": "2023-09-04", "end": "2023-09-11", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2023/jaar"},
    {"id": "2025-06", "start": "2025-06-28", "end": "2025-07-02", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2025/zomer"},
    {"id": "2025-08", "start": "2025-08-10", "end": "2025-08-15", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2025/zomer"},
    {"id": "2026-06", "start": "2026-06-17", "end": "2026-06-28", "sourceUrl": "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2026/juni"},
)

EXPECTED_SELECTED_OBSERVATIONS = (
    "landsat-2020-08-07",
    "landsat-2022-08-14",
    "landsat-2023-06-13",
    "landsat-2023-09-09",
    "landsat-2025-08-13",
    "landsat-2026-06-22",
)

# A discovered scene can be deliberately withdrawn from the user-facing
# timeline without rewriting the authoritative RMI heatwave period. Keep these
# decisions explicit so regenerating the cache cannot silently restore them.
EXCLUDED_OBSERVATION_DATES = {
    "2020-08-16": "excluded-from-timeline",
}


def scale_surface_temperature(digital_numbers):
    """Convert Collection 2 Level-2 ST digital numbers to degrees Celsius."""
    return np.asarray(digital_numbers, dtype=np.float32) * TEMPERATURE_SCALE + TEMPERATURE_OFFSET_K - KELVIN_OFFSET


def classify_quality(st, qa_pixel, qa_radsat):
    """Return 0 for missing, 1 for clear temperature and 2 for cloud-obscured."""
    st = np.asarray(st)
    qa_pixel = np.asarray(qa_pixel, dtype=np.uint16)
    qa_radsat = np.asarray(qa_radsat, dtype=np.uint16)
    status = np.zeros(st.shape, dtype=np.uint8)
    footprint = (qa_pixel & 1) == 0
    cloud = footprint & ((qa_pixel & CLOUD_BITS) != 0)
    saturated = (qa_radsat & RADIOMETRIC_SATURATION_BITS) != 0
    clear = footprint & (st >= 293) & (st <= 65535) & ~cloud & ~saturated
    status[cloud] = 2
    status[clear] = 1
    return status


def _period_dates(period):
    return date.fromisoformat(period["start"]), date.fromisoformat(period["end"])


def _catalog():
    return Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)


def _search(catalog, geometry, start: date, end: date):
    items = catalog.search(
        collections=[COLLECTION], intersects=mapping(geometry),
        datetime=f"{start.isoformat()}/{end.isoformat()}",
    ).item_collection()
    return [item for item in items if (
        item.properties.get("platform") in ("landsat-8", "landsat-9")
        and item.properties.get("landsat:collection_category") == "T1"
        and item.properties.get("landsat:correction") == "L2SP"
        and all(key in item.assets for key in ("lwir11", "qa_pixel", "qa_radsat", "qa"))
    )]


def group_items_by_date(items):
    groups = {}
    for item in items:
        key = item.datetime.date().isoformat()
        groups.setdefault(key, []).append(item)
    return groups


def is_observation_excluded(day: str) -> bool:
    """Return whether an acquisition date is intentionally omitted."""
    return day in EXCLUDED_OBSERVATION_DATES


def select_clearest_candidate(period, candidates):
    """Select one acquisition by coverage, midpoint proximity and timestamp."""
    if not candidates:
        return None, []
    start, end = _period_dates(period)
    midpoint = start + (end - start) / 2
    ordered = sorted(candidates, key=lambda candidate: (
        -candidate["coveragePercentage"],
        abs((date.fromisoformat(candidate["date"]) - midpoint).total_seconds()),
        candidate["acquiredAt"],
    ))
    return ordered[0], ordered[1:]


def _grid(sectors):
    bounds = sectors.to_crs(GRID_CRS).total_bounds
    minx = math.floor(bounds[0] / GRID_RESOLUTION) * GRID_RESOLUTION
    miny = math.floor(bounds[1] / GRID_RESOLUTION) * GRID_RESOLUTION
    maxx = math.ceil(bounds[2] / GRID_RESOLUTION) * GRID_RESOLUTION
    maxy = math.ceil(bounds[3] / GRID_RESOLUTION) * GRID_RESOLUTION
    width = int(round((maxx - minx) / GRID_RESOLUTION))
    height = int(round((maxy - miny) / GRID_RESOLUTION))
    return {"crs": GRID_CRS, "transform": from_origin(minx, maxy, GRID_RESOLUTION, GRID_RESOLUTION), "width": width, "height": height}


def _read_reprojected(item, asset_key, grid, dtype, fill, cache_path: Path | None = None):
    if cache_path and cache_path.exists():
        with rasterio.open(cache_path) as cached:
            if (str(cached.crs) == grid["crs"] and cached.transform == grid["transform"]
                    and cached.width == grid["width"] and cached.height == grid["height"]):
                return cached.read(1).astype(dtype, copy=False)
    output = np.full((grid["height"], grid["width"]), fill, dtype=dtype)
    with rasterio.Env(GDAL_HTTP_MULTIRANGE="YES", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(item.assets[asset_key].href) as source:
            reproject(
                source=rasterio.band(source, 1), destination=output,
                src_transform=source.transform, src_crs=source.crs,
                src_nodata=source.nodata, dst_transform=grid["transform"],
                dst_crs=grid["crs"], dst_nodata=fill,
                resampling=Resampling.nearest,
            )
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(".partial.tif")
        with rasterio.open(
            temporary, "w", driver="GTiff", width=grid["width"], height=grid["height"],
            count=1, dtype=np.dtype(dtype).name, crs=grid["crs"], transform=grid["transform"],
            nodata=fill, tiled=True, blockxsize=256, blockysize=256, compress="DEFLATE",
        ) as cached:
            cached.write(output, 1)
        temporary.replace(cache_path)
    return output


def _write_analysis(path: Path, temperature, status, uncertainty, grid):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial.tif")
    profile = {
        "driver": "GTiff", "width": grid["width"], "height": grid["height"],
        "count": 3, "dtype": "float32", "crs": grid["crs"],
        "transform": grid["transform"], "nodata": -9999.0,
        "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "DEFLATE",
    }
    with rasterio.open(temporary, "w", **profile) as output:
        output.write(np.where(status == 1, temperature, -9999).astype(np.float32), 1)
        output.write(status.astype(np.float32), 2)
        output.write(np.where(status == 1, uncertainty, -9999).astype(np.float32), 3)
        output.set_band_description(1, "land_surface_temperature_celsius")
        output.set_band_description(2, "observation_status_0_missing_1_clear_2_cloud")
        output.set_band_description(3, "surface_temperature_uncertainty_kelvin")
    temporary.replace(path)


def _read_analysis(path: Path):
    with rasterio.open(path) as source:
        temperature = source.read(1)
        status = source.read(2).astype(np.uint8)
        uncertainty = source.read(3)
        grid = {"crs": str(source.crs), "transform": source.transform, "width": source.width, "height": source.height}
    temperature[temperature == -9999] = np.nan
    uncertainty[uncertainty == -9999] = np.nan
    return temperature, status, uncertainty, grid


def _create_observation(items, grid, cache: Path):
    observation_date = items[0].datetime.date().isoformat()
    path = cache / "analysis" / f"landsat-{observation_date}.tif"
    sidecar = path.with_suffix(".json")
    ids = sorted(item.id for item in items)
    if path.exists() and sidecar.exists():
        metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        if metadata.get("sceneIds") == ids:
            temperature, status, uncertainty, _ = _read_analysis(path)
            return metadata, temperature, status, uncertainty, path
    temperature = np.full((grid["height"], grid["width"]), np.nan, dtype=np.float32)
    uncertainty = np.full(temperature.shape, np.nan, dtype=np.float32)
    status = np.zeros(temperature.shape, dtype=np.uint8)
    raw_windows = []
    for item in items:
        asset_paths = {
            key: output_root for key, output_root in (
                (asset_key, cache / "raw" / observation_date / f"{item.id}-{asset_key}.tif")
                for asset_key in ("lwir11", "qa_pixel", "qa_radsat", "qa")
            )
        }
        st = _read_reprojected(item, "lwir11", grid, np.uint16, 0, asset_paths["lwir11"])
        qa_pixel = _read_reprojected(item, "qa_pixel", grid, np.uint16, 1, asset_paths["qa_pixel"])
        qa_radsat = _read_reprojected(item, "qa_radsat", grid, np.uint16, 0, asset_paths["qa_radsat"])
        st_qa = _read_reprojected(item, "qa", grid, np.uint16, 0, asset_paths["qa"]).astype(np.float32) * 0.01
        raw_windows.append({
            "sceneId": item.id,
            "assets": {
                key: {"path": str(path.relative_to(CACHE_ROOT)).replace("\\", "/"), "sha256": file_hash(path)}
                for key, path in asset_paths.items()
            },
        })
        candidate_status = classify_quality(st, qa_pixel, qa_radsat)
        candidate_temperature = scale_surface_temperature(st)
        replace = (candidate_status == 1) & ((status != 1) | ~np.isfinite(uncertainty) | (st_qa < uncertainty))
        temperature[replace] = candidate_temperature[replace]
        uncertainty[replace] = st_qa[replace]
        status[replace] = 1
        status[(candidate_status == 2) & (status == 0)] = 2
    _write_analysis(path, temperature, status, uncertainty, grid)
    metadata = {
        "date": observation_date,
        "acquiredAt": min(item.datetime for item in items).astimezone(timezone.utc).isoformat(),
        "sceneIds": ids,
        "satellites": sorted({item.properties.get("platform") for item in items}),
        "wrs": sorted({f"{item.properties.get('landsat:wrs_path')}/{item.properties.get('landsat:wrs_row')}" for item in items}),
        "analysisSha256": file_hash(path),
        "rawWindows": raw_windows,
    }
    sidecar.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata, temperature, status, uncertainty, path


def _fractional_weights(geometry, grid, window, factor=10):
    transform = rasterio.windows.transform(window, grid["transform"])
    high_transform = transform * rasterio.Affine.scale(1 / factor)
    high_shape = (int(window.height) * factor, int(window.width) * factor)
    inside = geometry_mask([geometry], out_shape=high_shape, transform=high_transform, invert=True)
    return inside.reshape(int(window.height), factor, int(window.width), factor).mean(axis=(1, 3)) * 0.09


def _weighted_percentile(values, weights, percentile):
    if not len(values):
        return None
    order = np.argsort(values)
    values = values[order]
    weights = weights[order]
    threshold = np.sum(weights) * percentile / 100.0
    return float(values[np.searchsorted(np.cumsum(weights), threshold, side="left")])


def _one_area_stats(temperature, status, uncertainty, grid, geometry, complete_area):
    minx, miny, maxx, maxy = geometry.bounds
    window = rasterio.windows.from_bounds(minx, miny, maxx, maxy, grid["transform"]).round_offsets().round_lengths()
    full = rasterio.windows.Window(0, 0, grid["width"], grid["height"])
    try:
        window = window.intersection(full)
    except rasterio.errors.WindowError:
        window = rasterio.windows.Window(0, 0, 1, 1)
    row = slice(int(window.row_off), int(window.row_off + window.height))
    col = slice(int(window.col_off), int(window.col_off + window.width))
    weights = _fractional_weights(geometry, grid, window)
    local_status = status[row, col]
    local_temperature = temperature[row, col]
    local_uncertainty = uncertainty[row, col]
    clear = (local_status == 1) & (weights > 0) & np.isfinite(local_temperature)
    cloud = (local_status == 2) & (weights > 0)
    clear_area = float(np.sum(weights[clear]))
    cloud_area = float(np.sum(weights[cloud]))
    missing_area = max(0.0, complete_area - clear_area - cloud_area)
    values = local_temperature[clear]
    value_weights = weights[clear]
    uncertainty_values = local_uncertainty[clear & np.isfinite(local_uncertainty)]
    uncertainty_weights = weights[clear & np.isfinite(local_uncertainty)]
    percentage = lambda area: 0.0 if complete_area <= 0 else area / complete_area * 100.0
    result = {
        "completeAreaHa": round(complete_area, 4),
        "clearAreaHa": round(clear_area, 4), "clearPercentage": round(percentage(clear_area), 4),
        "cloudAreaHa": round(cloud_area, 4), "cloudPercentage": round(percentage(cloud_area), 4),
        "otherNoDataAreaHa": round(missing_area, 4), "otherNoDataPercentage": round(percentage(missing_area), 4),
        "pixelCount": int(np.count_nonzero(clear)),
        "meanC": float(np.average(values, weights=value_weights)) if len(values) else None,
        "p10C": _weighted_percentile(values, value_weights, 10),
        "medianC": _weighted_percentile(values, value_weights, 50),
        "p90C": _weighted_percentile(values, value_weights, 90),
        "meanUncertaintyK": float(np.average(uncertainty_values, weights=uncertainty_weights)) if len(uncertainty_values) else None,
        "medianUncertaintyK": _weighted_percentile(uncertainty_values, uncertainty_weights, 50),
    }
    for key in ("meanC", "p10C", "medianC", "p90C", "meanUncertaintyK", "medianUncertaintyK"):
        if result[key] is not None:
            result[key] = round(result[key], 3)
    return result


def _area_statistics(temperature, status, uncertainty, grid, areas, key_field):
    projected = areas.to_crs(grid["crs"])
    equal_area = areas.to_crs("EPSG:3035")
    return {
        str(projected.iloc[index][key_field]): _one_area_stats(
            temperature, status, uncertainty, grid,
            projected.iloc[index].geometry, equal_area.iloc[index].geometry.area / 10000.0,
        )
        for index in range(len(projected))
    }


def validate_prepared_manifest(manifest):
    """Reject incomplete timelines or area statistics before publication."""
    if manifest.get("datasetId") != "landsat-temperature" or manifest.get("schemaVersion") != 2:
        raise ValueError("Invalid Landsat surface-temperature manifest identity.")
    timeline = manifest.get("timelineItems", [])
    observations = manifest.get("observations", {})
    if not timeline or [item["acquiredAt"] for item in timeline] != sorted(item["acquiredAt"] for item in timeline):
        raise ValueError("Landsat observations must form a non-empty chronological timeline.")
    if manifest.get("defaultObservation") not in observations:
        raise ValueError("The default Landsat observation is missing.")
    if tuple(item["value"] for item in timeline) != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("The Landsat timeline must contain the clearest acquisition for each observed heatwave.")
    periods = manifest.get("heatwaves", [])
    if [(item["start"], item["end"]) for item in periods] != [(item["start"], item["end"]) for item in HEATWAVES]:
        raise ValueError("The pinned KMI heatwave periods changed unexpectedly.")
    missing_2025 = next(item for item in periods if item["id"] == "2025-06")
    if missing_2025["status"] != "no-acquisition" or missing_2025["observationIds"]:
        raise ValueError("The June 2025 heatwave must remain an explicit no-acquisition period.")
    for timeline_item in timeline:
        observation = observations.get(timeline_item["value"])
        if not observation or observation["kind"] != "heatwave" or timeline_item["kind"] != "heatwave":
            raise ValueError(f"{timeline_item['value']}: timeline and observation disagree.")
        if observation["clearCoveragePercentage"] < MINIMUM_HEATWAVE_COVERAGE:
            raise ValueError(f"{observation['id']}: clear coverage is below the selection threshold.")
        if set(observation.get("pmtilesVariants", {})) != {"all", *MUNICIPALITIES}:
            raise ValueError(f"{observation['id']}: municipality PMTiles variants are incomplete.")
        for records, expected in ((observation.get("sectorStats", {}), 154), (observation.get("municipalityStats", {}), 7)):
            if len(records) != expected:
                raise ValueError(f"{observation['id']}: expected {expected} area summaries, received {len(records)}.")
            for area_id, stats in records.items():
                total = stats["clearAreaHa"] + stats["cloudAreaHa"] + stats["otherNoDataAreaHa"]
                tolerance = max(0.01, stats["completeAreaHa"] * 0.005)
                if abs(total - stats["completeAreaHa"]) > tolerance:
                    raise ValueError(f"{observation['id']} {area_id}: clear, cloud and missing areas do not reconcile.")
    return manifest


def _hex(value):
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def _colour_temperature(values):
    normalized = np.clip((values - TEMPERATURE_MINIMUM) / (TEMPERATURE_MAXIMUM - TEMPERATURE_MINIMUM), 0, 1)
    rgb = np.zeros((*values.shape, 3), dtype=np.uint8)
    for (left, left_color), (right, right_color) in zip(INFERNO_STOPS[:-1], INFERNO_STOPS[1:]):
        selected = (normalized >= left) & (normalized <= right)
        amount = np.where(selected, (normalized - left) / (right - left), 0)[..., None]
        interpolated = _hex(left_color) + amount * (_hex(right_color) - _hex(left_color))
        rgb[selected] = np.clip(interpolated[selected], 0, 255).astype(np.uint8)
    return rgb


def _visual_derivative(analysis_path: Path, destination: Path):
    temperature, status, _, grid = _read_analysis(analysis_path)
    rgba = np.zeros((4, grid["height"], grid["width"]), dtype=np.uint8)
    clear = status == 1
    colors = _colour_temperature(np.nan_to_num(temperature, nan=TEMPERATURE_MINIMUM))
    rgba[:3, clear] = colors[clear].T
    rgba[3, clear] = 255
    cloud = status == 2
    rows, columns = np.indices(status.shape)
    checker = (rows + columns) % 2 == 0
    for band, (dark, light) in enumerate(((126, 194), (135, 201), (139, 203))):
        rgba[band, cloud & checker] = dark
        rgba[band, cloud & ~checker] = light
    rgba[3, cloud] = 235
    profile = {
        "driver": "GTiff", "width": grid["width"], "height": grid["height"],
        "count": 4, "dtype": "uint8", "crs": grid["crs"], "transform": grid["transform"],
        "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "DEFLATE", "photometric": "RGB",
    }
    with rasterio.open(destination, "w", **profile) as output:
        output.write(rgba)


def _candidate_record(metadata, temperature, status, uncertainty, grid, union, complete_area):
    stats = _one_area_stats(temperature, status, uncertainty, grid, union, complete_area)
    return {**metadata, "coveragePercentage": stats["clearPercentage"], "coverage": stats}


def prepare_landsat_temperature():
    sectors, municipalities = load_areas()
    projected_union = sectors.to_crs(GRID_CRS).geometry.union_all()
    union_area = sectors.to_crs("EPSG:3035").geometry.union_all().area / 10000.0
    grid = _grid(sectors)
    output_root = CACHE_ROOT / "landsat-temperature"
    output_root.mkdir(parents=True, exist_ok=True)
    catalog = _catalog()
    analysis_cache = {}

    def evaluate(group):
        key = group[0].datetime.date().isoformat()
        if key not in analysis_cache:
            metadata, temperature, status, uncertainty, path = _create_observation(group, grid, output_root)
            analysis_cache[key] = (
                _candidate_record(metadata, temperature, status, uncertainty, grid, projected_union, union_area),
                temperature, status, uncertainty, path,
            )
        return analysis_cache[key]

    selected = {}
    heatwave_records = []
    rejected = []
    for period in HEATWAVES:
        start, end = _period_dates(period)
        groups = group_items_by_date(_search(catalog, sectors.geometry.union_all(), start, end))
        eligible = []
        for day, group in sorted(groups.items()):
            if is_observation_excluded(day):
                rejected.append({
                    "date": day,
                    "heatwaveId": period["id"],
                    "reason": EXCLUDED_OBSERVATION_DATES[day],
                })
                continue
            candidate, *_ = evaluate(group)
            if candidate["coveragePercentage"] >= MINIMUM_HEATWAVE_COVERAGE:
                eligible.append(candidate)
            else:
                rejected.append({**candidate, "heatwaveId": period["id"], "reason": "insufficient-clear-coverage"})
        observation_ids = []
        if eligible:
            chosen, not_selected = select_clearest_candidate(period, eligible)
            observation_id = f"landsat-{chosen['date']}"
            selected[observation_id] = {
                "kind": "heatwave", "heatwaveIds": [period["id"]], "candidate": chosen,
            }
            observation_ids.append(observation_id)
            rejected.extend({
                "date": candidate["date"],
                "acquiredAt": candidate["acquiredAt"],
                "heatwaveId": period["id"],
                "coveragePercentage": candidate["coveragePercentage"],
                "reason": "not-clearest-for-heatwave",
                "selectedObservationId": observation_id,
            } for candidate in not_selected)
        heatwave_records.append({
            **period,
            "status": "observed" if observation_ids else ("no-acquisition" if not groups else "cloud-obscured"),
            "observationIds": observation_ids,
        })

    # Browser derivatives are disposable. Keep every analytical GeoTIFF, but
    # remove PMTiles for acquisitions that are no longer selected.
    selected_ids = set(selected)
    for archive in output_root.glob("landsat-*.pmtiles"):
        if not any(archive.name.startswith(f"{observation_id}-") for observation_id in selected_ids):
            archive.unlink()

    cutline_root = CACHE_ROOT / "cutlines"
    cutline_root.mkdir(parents=True, exist_ok=True)
    all_cutline = cutline_root / "zennevallei.geojson"
    _write_cutline(all_cutline, sectors.geometry.union_all())
    municipality_cutlines = {}
    for _, row in municipalities.iterrows():
        cutline = cutline_root / f"{slug(row['municipality'])}.geojson"
        _write_cutline(cutline, row.geometry)
        municipality_cutlines[row["municipality"]] = cutline

    observations = {}
    timeline_items = []
    for observation_id, selection in sorted(selected.items(), key=lambda item: item[1]["candidate"]["acquiredAt"]):
        candidate, temperature, status, uncertainty, analysis_path = analysis_cache[selection["candidate"]["date"]]
        sector_stats = _area_statistics(temperature, status, uncertainty, grid, sectors, "sectorId")
        municipality_stats = _area_statistics(temperature, status, uncertainty, grid, municipalities, "municipality")
        visual = output_root / f"{observation_id}-visual.tif"
        if not visual.exists():
            _visual_derivative(analysis_path, visual)
        variants = {}
        hashes = {}
        for name, cutline in {"all": all_cutline, **municipality_cutlines}.items():
            key = "all" if name == "all" else name
            filename = f"{observation_id}-{slug(key)}.pmtiles"
            archive = output_root / filename
            try:
                _validate_pmtiles(archive, 9, 14)
            except (FileNotFoundError, ValueError, OSError):
                archive.unlink(missing_ok=True)
                _pmtiles(visual, archive, cutline, "9..14")
                _validate_pmtiles(archive, 9, 14)
            variants[key] = f"landsat-temperature/{filename}"
            hashes[key] = file_hash(archive)
        visual.unlink(missing_ok=True)
        observation = {
            "id": observation_id, "kind": selection["kind"],
            "heatwaveIds": selection["heatwaveIds"], "date": candidate["date"],
            "acquiredAt": candidate["acquiredAt"], "satellites": candidate["satellites"],
            "sceneIds": candidate["sceneIds"], "wrs": candidate["wrs"],
            "clearCoveragePercentage": candidate["coveragePercentage"],
            "analysisSha256": candidate["analysisSha256"],
            "rawWindows": candidate["rawWindows"],
            "collectionCategory": "T1", "correction": "L2SP",
            "pmtilesVariants": variants, "pmtilesSha256": hashes,
            "sectorStats": sector_stats, "municipalityStats": municipality_stats,
        }
        observations[observation_id] = observation
        timeline_items.append({
            "value": observation_id, "acquiredAt": candidate["acquiredAt"],
            "kind": selection["kind"], "heatwaveIds": selection["heatwaveIds"],
            "status": "available",
        })

    heatwave_items = [item for item in timeline_items if item["kind"] == "heatwave"]
    default_observation = max(heatwave_items, key=lambda item: item["acquiredAt"])["value"]
    manifest = {
        "schemaVersion": 2, "datasetId": "landsat-temperature", "kind": "continuous-temporal",
        "timelineItems": timeline_items, "defaultObservation": default_observation,
        "opacity": 0.76, "bounds": list(sectors.total_bounds),
        "scale": {"minimum": TEMPERATURE_MINIMUM, "maximum": TEMPERATURE_MAXIMUM, "unit": "°C", "stops": [{"position": position, "color": color} for position, color in INFERNO_STOPS]},
        "cloudStyle": {"type": "checker-grid", "dark": "#7e878b", "light": "#c2c9cb"},
        "heatwaves": heatwave_records, "observations": observations, "rejectedObservations": rejected,
        "source": {
            "name": "Landsat 8/9 Collection 2 Level-2 Surface Temperature",
            "producer": "NASA/USGS Landsat",
            "catalogue": STAC_URL, "collection": COLLECTION,
            "productUrl": "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature",
            "accessService": "Microsoft Planetary Computer",
            "attribution": {"en": "NASA/USGS Landsat, accessed through Microsoft Planetary Computer", "nl": "NASA/USGS Landsat, geraadpleegd via Microsoft Planetary Computer"},
        },
        "kmi": {
            "definitionUrl": "https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel",
            "definition": "At least five consecutive days at 25°C or more in Uccle, including at least three days at 30°C or more.",
        },
        "processing": {
            "crs": GRID_CRS, "pixelSizeMetres": GRID_RESOLUTION,
            "platforms": ["landsat-8", "landsat-9"], "collectionCategory": "T1", "correction": "L2SP",
            "temperatureFormula": "DN * 0.00341802 + 149.0 - 273.15",
            "cloudBits": [1, 2, 3, 4, 5], "minimumHeatwaveCoveragePercentage": MINIMUM_HEATWAVE_COVERAGE,
            "excludedObservationDates": EXCLUDED_OBSERVATION_DATES,
            "statisticsGrid": "aligned 30 m Landsat grid with 10 x 10 fractional boundary weights",
            "resampling": "nearest", "gapFilling": False,
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sectorGeometrySha256": file_hash(Path(__file__).resolve().parents[4] / "public" / "data" / "sectors.geojson"),
    }
    validate_prepared_manifest(manifest)
    (output_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return manifest


def open_cached_observation(observation_id: str):
    """Return the three analytical arrays for notebook verification."""
    path = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
    if not path.exists():
        raise FileNotFoundError(f"Prepare Landsat temperature data first: {path}")
    return _read_analysis(path)
