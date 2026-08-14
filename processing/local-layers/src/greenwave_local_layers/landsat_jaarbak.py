"""Prepare exact-area Landsat temperature distributions by Soil sealing class.

Each native 1 m Soil sealing cell inherits its parent 30 m Landsat temperature
and contributes one square metre to the distribution. It never becomes a new
temperature observation. Browser PNGs are visual indexes, never statistics.
"""

from __future__ import annotations

import json
import gzip
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from scipy.stats import rankdata
from PIL import Image
from affine import Affine
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds

from .constants import CACHE_ROOT, MUNICIPALITIES, SECTORS_PATH
from .landsat import EXPECTED_SELECTED_OBSERVATIONS, _read_analysis
from .landsat_urban_atlas import (
    BIN_EDGES, _reproject_byte, _subpixel_majority, _web_grid, _write_png,
)
from .pipeline import file_hash, update_index
from .density import _fraction_grid, focal_density
from .exact_landsat_mask import SOIL_SEALED, SOIL_UNSEALED, prepare_exact_mask_table
from .spatial_inference import spatial_modified_t_test_lattice

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


def ordinary_least_squares(x_values, y_values):
    """Return a descriptive unweighted OLS fit, or ``None`` when undefined."""
    x = np.asarray(x_values, dtype=np.float64)
    y = np.asarray(y_values, dtype=np.float64)
    valid = np.isfinite(x) & np.isfinite(y)
    x, y = x[valid], y[valid]
    if x.size < 2 or np.ptp(x) == 0:
        return None
    slope, intercept = np.polyfit(x, y, 1)
    predicted = intercept + slope * x
    denominator = np.sum((y - np.mean(y)) ** 2)
    r_squared = 0.0 if denominator == 0 else 1 - np.sum((y - predicted) ** 2) / denominator
    x_scale = np.sqrt(np.sum((x - np.mean(x)) ** 2))
    y_scale = np.sqrt(np.sum((y - np.mean(y)) ** 2))
    pearson = None if x_scale == 0 or y_scale == 0 else np.sum((x - np.mean(x)) * (y - np.mean(y))) / (x_scale * y_scale)
    ranked_x, ranked_y = rankdata(x, method="average"), rankdata(y, method="average")
    rank_x_scale = np.sqrt(np.sum((ranked_x - np.mean(ranked_x)) ** 2))
    rank_y_scale = np.sqrt(np.sum((ranked_y - np.mean(ranked_y)) ** 2))
    spearman = None if rank_x_scale == 0 or rank_y_scale == 0 else np.sum(
        (ranked_x - np.mean(ranked_x)) * (ranked_y - np.mean(ranked_y))
    ) / (rank_x_scale * rank_y_scale)
    return {
        "n": int(x.size), "slope": round(float(slope), 10),
        "intercept": round(float(intercept), 8), "rSquared": round(float(r_squared), 8),
        "pearsonR": None if pearson is None else round(float(pearson), 8),
        "spearmanRho": None if spearman is None else round(float(spearman), 8),
        "analysedAreaHa": round(float(x.size) * 0.09, 4),
    }


def _density_on_landsat(year, grid):
    """Sample the existing analytical 100 m JaarBAK density at Landsat centres."""
    halo_path = CACHE_ROOT / "density-source" / "jaarbak" / f"jaarbak-{year}-halo.tif"
    if not halo_path.exists():
        raise FileNotFoundError(f"Prepare JaarBAK density first: {halo_path}")
    fractions, valid = _fraction_grid(halo_path, (1,))
    densities, coverage = focal_density(fractions, valid)
    with rasterio.open(halo_path) as source:
        source_transform = source.transform * Affine.scale(10, 10)
    destination = np.full((grid["height"], grid["width"]), np.nan, dtype=np.float32)
    destination_coverage = np.full(destination.shape, np.nan, dtype=np.float32)
    reproject(
        source=densities[0], destination=destination,
        src_transform=source_transform, src_crs="EPSG:31370", src_nodata=np.nan,
        dst_transform=grid["transform"], dst_crs=grid["crs"], dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    reproject(
        source=coverage, destination=destination_coverage,
        src_transform=source_transform, src_crs="EPSG:31370", src_nodata=np.nan,
        dst_transform=grid["transform"], dst_crs=grid["crs"], dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    eligible = np.isfinite(destination) & np.isfinite(destination_coverage) & (destination_coverage >= 95)
    destination[~eligible] = np.nan
    return destination, destination_coverage


def _density_scope_analysis(temperature, status, density, sector_index, region_index,
                            municipality_index, sector_meta, municipality_lookup, transform):
    clear = (status == 1) & np.isfinite(temperature) & np.isfinite(density)
    scopes = {}

    def add(key, selected):
        regression = ordinary_least_squares(density[selected], temperature[selected])
        if regression is not None:
            regression["inference"] = spatial_modified_t_test_lattice(
                density, temperature, selected, transform,
            )
        scopes[key] = regression

    add("region:zennevallei", clear & (region_index > 0))
    for name, index in municipality_lookup.items():
        add(f"municipality:{name}", clear & (municipality_index == index))
    for index, metadata in sector_meta.items():
        add(f"sector:{metadata['sectorId']}", clear & (sector_index == index))
    return scopes


def _write_rgba(path, bands):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial.png")
    Image.fromarray(np.dstack(bands), mode="RGBA").save(temporary, optimize=True)
    temporary.replace(path)


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


def _weighted_percentile(values, weights, percentile):
    if not len(values):
        return None
    order = np.argsort(values, kind="stable")
    values, weights = values[order], weights[order]
    threshold = float(np.sum(weights)) * percentile / 100
    return round(float(values[np.searchsorted(np.cumsum(weights), threshold, side="left")]), 3)


def _exact_soil_distribution(table, selected):
    temperature = table.temperature[table.landsat - 1]
    clear = selected & (table.status == 1) & np.isfinite(temperature)
    cloud = selected & (table.status == 2)
    missing = selected & (table.status == 0)
    values = temperature[clear]
    weights = table.area_m2[clear].astype(np.float64)
    inside = (values >= BIN_EDGES[0]) & (values <= BIN_EDGES[-1])
    bins, _ = np.histogram(values[inside], bins=BIN_EDGES, weights=weights[inside])
    area = float(np.sum(weights))
    return {
        "clearObservedAreaHa": round(area / 10_000, 4),
        "cloudObservedAreaHa": round(float(np.sum(table.area_m2[cloud])) / 10_000, 4),
        "otherMissingAreaHa": round(float(np.sum(table.area_m2[missing])) / 10_000, 4),
        "contributingLandsatCount": int(np.unique(table.landsat[clear]).size),
        "underflowAreaM2": int(round(float(np.sum(weights[values < BIN_EDGES[0]])))),
        "overflowAreaM2": int(round(float(np.sum(weights[values > BIN_EDGES[-1]])))),
        "binAreaM2": np.rint(bins).astype(int).tolist(),
        "meanC": None if not area else round(float(np.average(values, weights=weights)), 3),
        "medianC": _weighted_percentile(values, weights, 50),
        "p10C": _weighted_percentile(values, weights, 10),
        "p90C": _weighted_percentile(values, weights, 90),
    }


def _exact_soil_scope_distributions(table, sector_meta):
    scopes = {"region:zennevallei": tuple(sector_meta)}
    scopes.update({f"sector:{item['sectorId']}": (index,) for index, item in sector_meta.items()})
    for municipality in MUNICIPALITIES:
        scopes[f"municipality:{municipality}"] = tuple(
            index for index, item in sector_meta.items() if item["municipality"] == municipality
        )
    result = {}
    for scope_id, indexes in scopes.items():
        scope = np.isin(table.sector, indexes)
        result[scope_id] = {
            "assignedAreaHa": round(float(np.sum(table.area_m2[scope])) / 10_000, 4),
            "series": {
                "class:sealed": _exact_soil_distribution(table, scope & (table.soil == SOIL_SEALED)),
                "class:unsealed": _exact_soil_distribution(table, scope & (table.soil == SOIL_UNSEALED)),
            },
        }
    return result


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
    analytical_scope_path = OUTPUT_ROOT / "analysis-scope-index.png"
    _write_rgba(analytical_scope_path, (
        region_index.astype(np.uint8), municipality_index.astype(np.uint8),
        sector_index.astype(np.uint8), np.full_like(region_index, 255, dtype=np.uint8),
    ))

    density_cache = {}
    observations = {}
    for observation_id in selected_ids:
        year = YEAR_BY_OBSERVATION[observation_id]
        if year not in density_cache:
            print(f"JaarBAK {year}: sampling 100 m density on the Landsat grid", flush=True)
            density_cache[year] = _density_on_landsat(year, grid)[0]
        sealing_density = density_cache[year]

        analysis = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        temperature, status, _, observation_grid = _read_analysis(analysis)
        if observation_grid != grid:
            raise ValueError(f"{observation_id}: analytical grid is not aligned.")
        exact = prepare_exact_mask_table(observation_id, year)
        distributions = _exact_soil_scope_distributions(exact, sector_meta)
        distribution_path = OUTPUT_ROOT / "distributions" / f"{observation_id}.json.gz"
        distribution_path.parent.mkdir(parents=True, exist_ok=True)
        density_analysis = _density_scope_analysis(
            temperature, status, sealing_density, sector_index, region_index,
            municipality_index, sector_meta, municipality_lookup, grid["transform"],
        )
        distribution_payload = json.dumps({
            "schemaVersion": 4,
            "observationId": observation_id,
            "secondaryYear": year,
            "secondaryStatus": jaarbak["years"][str(year)]["status"],
            "scopes": distributions,
            "surfaceStats": _surface_stats(jaarbak, year),
            "densityAnalysis": density_analysis,
        }, separators=(",", ":")).encode("utf-8")
        distribution_path.write_bytes(gzip.compress(distribution_payload, compresslevel=9, mtime=0))

        temperature_code = np.rint(np.clip(np.nan_to_num(temperature, nan=-100) + 100, 0, 655.35) * 100).astype(np.uint16)
        density_code = np.rint(np.clip(np.nan_to_num(sealing_density), 0, 100) * 100).astype(np.uint16)
        density_valid = np.isfinite(sealing_density)
        point_path = OUTPUT_ROOT / "density-points" / f"{observation_id}.png"
        _write_rgba(point_path, (
            (temperature_code >> 8).astype(np.uint8),
            (temperature_code & 255).astype(np.uint8),
            np.zeros_like(status, dtype=np.uint8),
            np.where((status == 1) & np.isfinite(temperature), 255, 0).astype(np.uint8),
        ))
        density_path = OUTPUT_ROOT / "density-values" / f"{observation_id}.png"
        _write_rgba(density_path, (
            (density_code >> 8).astype(np.uint8),
            (density_code & 255).astype(np.uint8),
            np.where(density_valid, 255, 0).astype(np.uint8),
            np.full_like(status, 255, dtype=np.uint8),
        ))
        observations[observation_id] = {
            "secondaryYear": year,
            "secondaryStatus": jaarbak["years"][str(year)]["status"],
            "distributionUrl": f"landsat-jaarbak/distributions/{observation_id}.json.gz",
            "densityPointDataUrl": f"landsat-jaarbak/density-points/{observation_id}.png",
            "densityDataUrl": f"landsat-jaarbak/density-values/{observation_id}.png",
            "distributionSha256": file_hash(distribution_path),
            "densityPointDataSha256": file_hash(point_path),
            "densityDataSha256": file_hash(density_path),
        }

    manifest = {
        "schemaVersion": 4,
        "comparisonId": "landsat-jaarbak",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "jaarbak",
        "defaultSeries": ["class:sealed", "class:unsealed"],
        "maximumSeries": 2,
        "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
        "binEdges": BIN_EDGES.tolist(),
        "maskResolutionMeters": 1,
        "temperatureResolutionMeters": 30,
        "aggregation": "exact-masked-area",
        "minimumAnalysedAreaHa": 0.1,
        "classification": {
            "sourceResolutionMetres": 1,
            "temperatureResolutionMetres": 30,
            "aggregation": "exact-masked-area",
            "minimumAnalysedAreaHa": 0.1,
            "areaContributionSquareMetres": 1,
        },
        "yearByObservation": YEAR_BY_OBSERVATION,
        "coordinates": web["coordinates"],
        "imageSize": [web["width"], web["height"]],
        "scopeIndexUrl": "landsat-jaarbak/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
        "analysisImageSize": [grid["width"], grid["height"]],
        "analysisScopeIndexUrl": "landsat-jaarbak/analysis-scope-index.png",
        "analysisScopeIndexSha256": file_hash(analytical_scope_path),
        "municipalityIndexes": municipality_lookup,
        "sectorIndexes": {metadata["sectorId"]: index for index, metadata in sector_meta.items()},
        "sectorIdsByIndex": {index: metadata["sectorId"] for index, metadata in sector_meta.items()},
        "sectorMunicipalities": {metadata["sectorId"]: metadata["municipality"] for metadata in sector_meta.values()},
        "densityAnalysis": {
            "radiusMeters": 100, "validCoverageThreshold": 95,
            "points": "all-clear-valid-density-landsat-pixels", "sampling": "none",
        },
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
