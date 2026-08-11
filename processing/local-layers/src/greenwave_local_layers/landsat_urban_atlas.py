"""Prepare the Landsat surface-temperature x Urban Atlas comparison.

Scientific distributions use exact 1 m Urban Atlas area within each native
30 m Landsat observation. The PNG files are compact, lossless browser
derivatives used only to update a MapLibre canvas; they never supply statistics.
"""

from __future__ import annotations

import gzip
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
from .exact_landsat_mask import prepare_exact_mask_table
from .pipeline import file_hash, update_index

URBAN_ATLAS_GEOJSON = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
URBAN_ATLAS_MANIFEST = PROJECT_ROOT / "public" / "data" / "urban-atlas.json"
OUTPUT_ROOT = CACHE_ROOT / "landsat-urban-atlas"
# The year selects an aligned native 1 m accounting grid only. Soil values are
# ignored by this comparison. Matching the observation's Soil-sealing edition
# lets all exact-area comparison products reuse the same cached intersections.
MASK_GRID_YEAR_BY_OBSERVATION = {
    "landsat-2020-08-07": 2020,
    "landsat-2022-08-14": 2022,
    "landsat-2023-06-13": 2023,
    "landsat-2023-09-09": 2023,
    "landsat-2025-08-13": 2024,
    "landsat-2026-06-22": 2024,
}
BIN_EDGES = np.arange(TEMPERATURE_MINIMUM, TEMPERATURE_MAXIMUM + 0.5, 0.5)
MINIMUM_MAJORITY = 18

# Analysis families are deliberately broader than the product legend groups.
# Each Urban Atlas class belongs to exactly one family so pooled distributions
# cannot double-count exact contributing surface.
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


def _weighted_percentile(values, weights, percentile):
    if not len(values):
        return None
    order = np.argsort(values, kind="stable")
    values, weights = values[order], weights[order]
    threshold = np.sum(weights) * percentile / 100
    return round(float(values[np.searchsorted(np.cumsum(weights), threshold, side="left")]), 3)


def _exact_distribution_values(temperature, status, landsat, area_m2, selected):
    """Summarise a pre-scoped exact table without rescanning other scopes."""
    clear = selected & (status == 1) & np.isfinite(temperature)
    cloud = selected & (status == 2)
    missing = selected & (status == 0)
    values = temperature[clear]
    weights = area_m2[clear].astype(np.float64)
    inside = (values >= BIN_EDGES[0]) & (values <= BIN_EDGES[-1])
    bins, _ = np.histogram(values[inside], bins=BIN_EDGES, weights=weights[inside])
    area = float(np.sum(weights))
    return {
        "clearObservedAreaHa": round(area / 10_000, 4),
        "cloudObservedAreaHa": round(float(np.sum(area_m2[cloud])) / 10_000, 4),
        "otherMissingAreaHa": round(float(np.sum(area_m2[missing])) / 10_000, 4),
        "contributingLandsatCount": int(np.unique(landsat[clear]).size),
        "underflowAreaM2": int(round(float(np.sum(weights[values < BIN_EDGES[0]])))),
        "overflowAreaM2": int(round(float(np.sum(weights[values > BIN_EDGES[-1]])))),
        "binAreaM2": np.rint(bins).astype(int).tolist(),
        "meanC": None if not area else round(float(np.average(values, weights=weights)), 3),
        "medianC": _weighted_percentile(values, weights, 50),
        "p10C": _weighted_percentile(values, weights, 10),
        "p90C": _weighted_percentile(values, weights, 90),
    }


def _exact_distribution(table, selected):
    return _exact_distribution_values(
        table.temperature[table.landsat - 1], table.status, table.landsat,
        table.area_m2, selected,
    )


def _exact_scope_distributions(table, sector_meta, series):
    class_lookup = {code: index + 1 for index, code in enumerate(table.urban_codes)}
    scopes = {"region:zennevallei": tuple(sector_meta)}
    scopes.update({f"sector:{item['sectorId']}": (index,) for index, item in sector_meta.items()})
    for municipality in MUNICIPALITIES:
        scopes[f"municipality:{municipality}"] = tuple(
            index for index, item in sector_meta.items() if item["municipality"] == municipality
        )
    output = {}
    for scope_id, sector_indexes in scopes.items():
        scope = np.isin(table.sector, sector_indexes)
        scoped_urban = table.urban_class[scope]
        scoped_landsat = table.landsat[scope]
        scoped_status = table.status[scope]
        scoped_area = table.area_m2[scope]
        scoped_temperature = table.temperature[scoped_landsat - 1]
        output[scope_id] = {
            "assignedAreaHa": round(float(np.sum(scoped_area)) / 10_000, 4),
            "series": {
                item["key"]: _exact_distribution_values(
                    scoped_temperature, scoped_status, scoped_landsat, scoped_area,
                    np.isin(scoped_urban, [
                        class_lookup[code] for code in item.get("codes", (item.get("code"),)) if code in class_lookup
                    ]),
                ) for item in series
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


def _write_png(path: Path, bands, alpha=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([*bands, np.full_like(bands[0], 255, dtype=np.uint8) if alpha is None else alpha])
    temporary = path.with_suffix(".partial.png")
    Image.fromarray(rgba, mode="RGBA").save(temporary, optimize=True)
    temporary.replace(path)


def prepare_landsat_urban_atlas():
    # Imported lazily to avoid a module cycle: the shared preparation module
    # reuses the 30 m majority helper defined above.
    from .sealed_urban_comparisons import _prepare_urban_atlas_class_mask

    class_mask = _prepare_urban_atlas_class_mask()
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
        exact = prepare_exact_mask_table(
            observation_id, MASK_GRID_YEAR_BY_OBSERVATION[observation_id],
        )
        distributions = _exact_scope_distributions(exact, sector_meta, series)
        distribution_path = OUTPUT_ROOT / "distributions" / f"{observation_id}.json.gz"
        distribution_path.parent.mkdir(parents=True, exist_ok=True)
        distribution_payload = json.dumps({
            "schemaVersion": 2, "observationId": observation_id, "scopes": distributions,
        }, separators=(",", ":")).encode("utf-8")
        distribution_path.write_bytes(gzip.compress(distribution_payload, compresslevel=9, mtime=0))

        clear = (status == 1) & np.isfinite(temperature)
        temperature_code = np.zeros(temperature.shape, dtype=np.uint16)
        temperature_code[clear] = np.rint(np.clip((temperature[clear] + 100) * 100, 1, 65535)).astype(np.uint16)
        web_high = _reproject_byte((temperature_code >> 8).astype(np.uint8), grid, web)
        web_low = _reproject_byte((temperature_code & 255).astype(np.uint8), grid, web)
        display_status = np.full(status.shape, 253, dtype=np.uint8)
        display_status[clear] = 255
        display_status[status == 2] = 254
        web_display_status = _reproject_byte(display_status, grid, web)
        display_path = OUTPUT_ROOT / "display" / f"{observation_id}.png"
        _write_png(display_path, (web_high, web_low, np.zeros_like(web_high)), alpha=web_display_status)
        observation_records[observation_id] = {
            "displayDataUrl": f"landsat-urban-atlas/display/{observation_id}.png",
            "distributionUrl": f"landsat-urban-atlas/distributions/{observation_id}.json.gz",
            "displayDataSha256": file_hash(display_path),
            "distributionSha256": file_hash(distribution_path),
        }

    manifest = {
        "schemaVersion": 3,
        "comparisonId": "landsat-urban-atlas",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "urban-atlas",
        "defaultSeries": ["family:greenUrbanAreas", "class:11100"],
        "maximumSeries": 4,
        "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
        "binEdges": BIN_EDGES.tolist(),
        "maskResolutionMeters": 1,
        "temperatureResolutionMeters": 30,
        "aggregation": "exact-masked-area",
        "minimumAnalysedAreaHa": 0.1,
        "urbanAtlasYear": 2021,
        "coordinates": web["coordinates"],
        "imageSize": [web["width"], web["height"]],
        "scopeIndexUrl": "landsat-urban-atlas/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
        "urbanAtlasClassMaskUrl": class_mask["url"],
        "urbanAtlasClassMaskSha256": class_mask["sha256"],
        "urbanAtlasClassIndexes": class_mask["classIndexes"],
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
