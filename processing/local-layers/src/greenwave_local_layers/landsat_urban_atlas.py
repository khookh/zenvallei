"""Prepare the local Landsat surface-temperature x Urban Atlas comparison.

Scientific distributions are calculated on the aligned 30 m Landsat grid.
The PNG files are compact, lossless browser derivatives used only to update a
MapLibre canvas; they are never used to calculate statistics.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds

from .constants import CACHE_ROOT, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .landsat import (
    EXPECTED_SELECTED_OBSERVATIONS, TEMPERATURE_MAXIMUM, TEMPERATURE_MINIMUM,
    _read_analysis,
)
from .pipeline import file_hash, update_index

URBAN_ATLAS_GEOJSON = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
URBAN_ATLAS_MANIFEST = PROJECT_ROOT / "public" / "data" / "urban-atlas.json"
OUTPUT_ROOT = CACHE_ROOT / "landsat-urban-atlas"
BIN_EDGES = np.arange(TEMPERATURE_MINIMUM, TEMPERATURE_MAXIMUM + 0.5, 0.5)
MINIMUM_MAJORITY = 18

# Analysis families are deliberately broader than the product legend groups.
# Each Urban Atlas class belongs to exactly one family so pooled distributions
# cannot double-count a Landsat pixel.
FAMILIES = (
    {
        "id": "artificialSurfaces",
        "codes": (
            "11100", "11210", "11220", "11230", "11240", "11300", "12100",
            "12210", "12220", "12230", "12300", "12400", "13100", "13300", "13400",
        ),
        "color": "#a51f3d",
    },
    {"id": "greenUrbanAreas", "codes": ("14110", "14120", "14130"), "color": "#4c7f00"},
    {"id": "agriculture", "codes": ("21000", "22000", "23000", "24000"), "color": "#9a7d00"},
    {"id": "forestSemiNatural", "codes": ("31000", "32000", "33000"), "color": "#007a4d"},
    {"id": "sportsLeisure", "codes": ("14200",), "color": "#5b8e7d"},
    {"id": "wetlands", "codes": ("40000",), "color": "#6657c9"},
    {"id": "water", "codes": ("50000",), "color": "#0077b6"},
)


def majority_from_subpixels(samples: np.ndarray, minimum: int = MINIMUM_MAJORITY) -> np.ndarray:
    """Return a unique majority value per row, or zero for ties/no majority."""
    values = np.sort(np.asarray(samples, dtype=np.uint16), axis=1)
    rows = values.shape[0]
    best_value = np.zeros(rows, dtype=np.uint16)
    best_count = np.zeros(rows, dtype=np.uint8)
    tied = np.zeros(rows, dtype=bool)
    current_count = np.zeros(rows, dtype=np.uint8)
    previous = np.zeros(rows, dtype=np.uint16)
    for column in range(values.shape[1]):
        candidate = values[:, column]
        same = (column > 0) & (candidate == previous)
        current_count = np.where(same, current_count + 1, 1).astype(np.uint8)
        valid = candidate != 0
        better = valid & (current_count > best_count)
        equal_other = valid & (current_count == best_count) & (candidate != best_value)
        best_value[better] = candidate[better]
        best_count[better] = current_count[better]
        tied[better] = False
        tied[equal_other] = True
        previous = candidate
    best_value[(best_count < minimum) | tied] = 0
    return best_value


def _subpixel_majority(shapes, grid, minimum=MINIMUM_MAJORITY):
    factor = 6
    transform = grid["transform"] * rasterio.Affine.scale(1 / factor)
    high = rasterize(
        shapes, out_shape=(grid["height"] * factor, grid["width"] * factor),
        transform=transform, fill=0, dtype="uint16",
    )
    samples = high.reshape(grid["height"], factor, grid["width"], factor)
    samples = samples.transpose(0, 2, 1, 3).reshape(-1, factor * factor)
    return majority_from_subpixels(samples, minimum).reshape(grid["height"], grid["width"])


def _percentile(values, percentile):
    return None if not len(values) else round(float(np.percentile(values, percentile)), 3)


def _distribution(temperature, status, selected):
    clear = selected & (status == 1) & np.isfinite(temperature)
    cloud = selected & (status == 2)
    missing = selected & (status == 0)
    values = temperature[clear]
    inside = values[(values >= BIN_EDGES[0]) & (values <= BIN_EDGES[-1])]
    counts, _ = np.histogram(inside, bins=BIN_EDGES)
    return {
        "clearPixelCount": int(len(values)),
        "cloudPixelCount": int(np.count_nonzero(cloud)),
        "otherMissingPixelCount": int(np.count_nonzero(missing)),
        "underflowCount": int(np.count_nonzero(values < BIN_EDGES[0])),
        "overflowCount": int(np.count_nonzero(values > BIN_EDGES[-1])),
        "binCounts": counts.astype(int).tolist(),
        "meanC": None if not len(values) else round(float(np.mean(values)), 3),
        "medianC": _percentile(values, 50),
        "p10C": _percentile(values, 10),
        "p90C": _percentile(values, 90),
    }


def _scope_distributions(temperature, status, class_index, sector_index, sector_meta, series):
    flat_temperature = temperature.ravel()
    flat_status = status.ravel()
    flat_class = class_index.ravel()
    flat_sector = sector_index.ravel()
    scopes = {"region:zennevallei": np.flatnonzero(flat_sector > 0)}
    for index, metadata in sector_meta.items():
        scopes[f"sector:{metadata['sectorId']}"] = np.flatnonzero(flat_sector == index)
    for municipality in MUNICIPALITIES:
        indexes = [index for index, metadata in sector_meta.items() if metadata["municipality"] == municipality]
        scopes[f"municipality:{municipality}"] = np.flatnonzero(np.isin(flat_sector, indexes))

    output = {}
    for scope_id, indexes in scopes.items():
        local_class = flat_class[indexes]
        output[scope_id] = {
            "assignedPixelCount": int(len(indexes)),
            "series": {
                item["key"]: _distribution(
                    flat_temperature[indexes], flat_status[indexes], np.isin(local_class, item["classIndexes"]),
                )
                for item in series
            },
        }
    return output


def _web_grid(grid):
    left, bottom, right, top = array_bounds(grid["height"], grid["width"], grid["transform"])
    transform, width, height = calculate_default_transform(
        grid["crs"], "EPSG:3857", grid["width"], grid["height"], left, bottom, right, top,
        resolution=30,
    )
    target_bounds = array_bounds(height, width, transform)
    west, south, east, north = transform_bounds("EPSG:3857", "EPSG:4326", *target_bounds)
    return {
        "crs": "EPSG:3857", "transform": transform, "width": width, "height": height,
        "coordinates": [[west, north], [east, north], [east, south], [west, south]],
    }


def _reproject_byte(values, grid, web):
    output = np.zeros((web["height"], web["width"]), dtype=np.uint8)
    reproject(
        source=values, destination=output, src_transform=grid["transform"], src_crs=grid["crs"],
        dst_transform=web["transform"], dst_crs=web["crs"], resampling=Resampling.nearest,
    )
    return output


def _write_png(path: Path, bands):
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([*bands, np.full_like(bands[0], 255, dtype=np.uint8)])
    temporary = path.with_suffix(".partial.png")
    Image.fromarray(rgba, mode="RGBA").save(temporary, optimize=True)
    temporary.replace(path)


def prepare_landsat_urban_atlas():
    landsat_manifest_path = CACHE_ROOT / "landsat-temperature" / "manifest.json"
    if not landsat_manifest_path.exists():
        raise FileNotFoundError("Prepare Landsat surface temperature before preparing the comparison.")
    landsat = json.loads(landsat_manifest_path.read_text(encoding="utf-8"))
    selected_ids = tuple(item["value"] for item in landsat["timelineItems"])
    if selected_ids != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("Regenerate Landsat data so the six clearest heatwave observations are selected first.")

    urban = json.loads(URBAN_ATLAS_MANIFEST.read_text(encoding="utf-8"))
    classes = [item for item in urban["classes"] if item.get("present")]
    class_lookup = {item["code"]: index + 1 for index, item in enumerate(classes)}
    first_analysis = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{selected_ids[0]}.tif"
    _, _, _, grid = _read_analysis(first_analysis)

    ua = gpd.read_file(URBAN_ATLAS_GEOJSON).to_crs(grid["crs"])
    ua_shapes = ((geometry, class_lookup.get(str(code), 0)) for geometry, code in zip(ua.geometry, ua["classCode"]))
    class_index = _subpixel_majority(ua_shapes, grid)

    sectors = gpd.read_file(SECTORS_PATH).to_crs(grid["crs"])
    sector_meta = {
        index + 1: {"sectorId": row.sectorId, "municipality": row.municipality}
        for index, row in sectors.iterrows()
    }
    sector_shapes = ((row.geometry, index + 1) for index, row in sectors.iterrows())
    sector_index = _subpixel_majority(sector_shapes, grid)
    municipality_lookup = {name: index + 1 for index, name in enumerate(MUNICIPALITIES)}
    municipality_index = np.zeros_like(sector_index, dtype=np.uint8)
    for index, metadata in sector_meta.items():
        municipality_index[sector_index == index] = municipality_lookup[metadata["municipality"]]

    family_records = [{
        "key": f"family:{family['id']}", "type": "family", "id": family["id"],
        "codes": [code for code in family["codes"] if code in class_lookup], "color": family["color"],
        "classIndexes": [class_lookup[code] for code in family["codes"] if code in class_lookup],
    } for family in FAMILIES if any(code in class_lookup for code in family["codes"])]
    class_records = [{
        "key": f"class:{item['code']}", "type": "class", "code": item["code"],
        "color": item["color"], "groupKey": item["groupKey"],
        "index": class_lookup[item["code"]],
        "classIndexes": [class_lookup[item["code"]]],
    } for item in classes]
    series = family_records + class_records

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    web = _web_grid(grid)
    web_class = _reproject_byte(class_index.astype(np.uint8), grid, web)
    web_sector = _reproject_byte(sector_index.astype(np.uint8), grid, web)
    web_municipality = _reproject_byte(municipality_index, grid, web)
    scope_path = OUTPUT_ROOT / "scope-index.png"
    _write_png(scope_path, (web_sector, web_municipality, np.zeros_like(web_sector)))

    observation_records = {}
    for observation_id in selected_ids:
        analysis = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        temperature, status, _, observation_grid = _read_analysis(analysis)
        if observation_grid != grid:
            raise ValueError(f"{observation_id}: analytical grid is not aligned.")
        distributions = _scope_distributions(
            temperature, status, class_index, sector_index, sector_meta, series,
        )
        distribution_path = OUTPUT_ROOT / "distributions" / f"{observation_id}.json"
        distribution_path.parent.mkdir(parents=True, exist_ok=True)
        distribution_path.write_text(json.dumps({
            "schemaVersion": 1, "observationId": observation_id, "scopes": distributions,
        }, separators=(",", ":")), encoding="utf-8")

        encoded_temperature = np.zeros(temperature.shape, dtype=np.uint8)
        clear = (status == 1) & np.isfinite(temperature)
        encoded_temperature[clear] = np.round(
            np.clip((temperature[clear] - TEMPERATURE_MINIMUM)
                    / (TEMPERATURE_MAXIMUM - TEMPERATURE_MINIMUM), 0, 1) * 255,
        ).astype(np.uint8)
        web_temperature = _reproject_byte(encoded_temperature, grid, web)
        web_status = _reproject_byte(status.astype(np.uint8), grid, web)
        data_path = OUTPUT_ROOT / "pixels" / f"{observation_id}.png"
        _write_png(data_path, (web_temperature, web_class, web_status))
        observation_records[observation_id] = {
            "pixelDataUrl": f"landsat-urban-atlas/pixels/{observation_id}.png",
            "distributionUrl": f"landsat-urban-atlas/distributions/{observation_id}.json",
            "pixelDataSha256": file_hash(data_path),
            "distributionSha256": file_hash(distribution_path),
        }

    manifest = {
        "schemaVersion": 1,
        "comparisonId": "landsat-urban-atlas",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "urban-atlas",
        "defaultSeries": ["family:greenUrbanAreas", "class:11100"],
        "maximumSeries": 4,
        "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
        "binEdges": BIN_EDGES.tolist(),
        "pixelAssignment": {"subpixels": 36, "subpixelSizeMetres": 5, "minimumMajority": 18, "ties": "excluded"},
        "urbanAtlasYear": 2021,
        "coordinates": web["coordinates"],
        "imageSize": [web["width"], web["height"]],
        "scopeIndexUrl": "landsat-urban-atlas/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
        "municipalityIndexes": municipality_lookup,
        "sectorIndexes": {metadata["sectorId"]: index for index, metadata in sector_meta.items()},
        "classes": [{key: value for key, value in item.items() if key != "classIndexes"} for item in class_records],
        "families": [{key: value for key, value in item.items() if key != "classIndexes"} for item in family_records],
        "observations": observation_records,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "landsatManifestSha256": file_hash(landsat_manifest_path),
            "urbanAtlasGeojsonSha256": file_hash(URBAN_ATLAS_GEOJSON),
            "urbanAtlasManifestSha256": file_hash(URBAN_ATLAS_MANIFEST),
        },
    }
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    update_index()
    return manifest
