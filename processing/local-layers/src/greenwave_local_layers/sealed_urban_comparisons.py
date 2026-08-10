"""Prepare the three sealed-urban comparison products.

Urban Atlas supplies the urban-fabric mask, JaarBAK supplies the sealed-surface
mask, Green Map supplies 100 m focal density, and Landsat supplies clear-sky
surface temperature. Browser PNGs are lossless analytical indexes; all area,
mean and regression values are calculated from the floating-point grids here.
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
from rasterio.warp import Resampling, reproject, transform_bounds

from .constants import CACHE_ROOT, GROENKAART_CLASSES, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .density import ANALYSIS_RESOLUTION, _fraction_grid, circular_kernel, focal_density
from .landsat import EXPECTED_SELECTED_OBSERVATIONS, _read_analysis
from .landsat_jaarbak import YEAR_BY_OBSERVATION, _classify_jaarbak, display_scope_indexes
from .landsat_urban_atlas import _subpixel_majority
from .pipeline import file_hash, update_index

COMPARISON_IDS = ("landsat-groenkaart", "groenkaart-income", "landsat-income")
URBAN_FABRIC_CODES = ("11100", "11210", "11220", "11230", "11240")
EXCLUDED_URBAN_CODE = "11300"
GREEN_CLASS_CODES = (1, 2, 3, 4)
DEFAULT_GREEN_CLASSES = (1, 2)
INCOME_YEAR = 2023
MINIMUM_LANDSAT_JAARBAK_COVERAGE = 0.50
MINIMUM_LANDSAT_GREEN_COVERAGE = 0.80
MINIMUM_NATIVE_JAARBAK_COVERAGE = 0.95
MINIMUM_SECTOR_LANDSAT_PIXELS = 10
POINT_CLEAR = 255
POINT_CLOUD = 254
POINT_OTHER_MISSING = 253


def ordinary_least_squares(x_values, y_values):
    """Return a deterministic descriptive OLS summary, or None if undefined."""
    x = np.asarray(x_values, dtype=np.float64)
    y = np.asarray(y_values, dtype=np.float64)
    valid = np.isfinite(x) & np.isfinite(y)
    x = x[valid]
    y = y[valid]
    if len(x) < 3:
        return None
    x_mean = float(np.mean(x))
    y_mean = float(np.mean(y))
    denominator = float(np.sum((x - x_mean) ** 2))
    if denominator <= 0:
        return None
    slope = float(np.sum((x - x_mean) * (y - y_mean)) / denominator)
    intercept = y_mean - slope * x_mean
    fitted = intercept + slope * x
    total = float(np.sum((y - y_mean) ** 2))
    residual = float(np.sum((y - fitted) ** 2))
    r_squared = None if total <= 0 else max(0.0, min(1.0, 1.0 - residual / total))
    return {
        "count": int(len(x)),
        "slope": round(slope, 8),
        "intercept": round(intercept, 8),
        "rSquared": None if r_squared is None else round(r_squared, 8),
        "xMinimum": round(float(np.min(x)), 4),
        "xMaximum": round(float(np.max(x)), 4),
        "yMinimum": round(float(np.min(y)), 4),
        "yMaximum": round(float(np.max(y)), 4),
    }


def _green_combinations():
    return tuple(
        tuple(code for code in GREEN_CLASS_CODES if mask & (1 << (code - 1)))
        for mask in range(1, 1 << len(GREEN_CLASS_CODES))
    )


def _combination_key(codes):
    return "+".join(str(code) for code in codes)


def _coordinates(grid):
    bounds = array_bounds(grid["height"], grid["width"], grid["transform"])
    west, south, east, north = transform_bounds(grid["crs"], "EPSG:4326", *bounds, densify_pts=21)
    return [[west, north], [east, north], [east, south], [west, south]]


def _write_rgba(path: Path, channels):
    path.parent.mkdir(parents=True, exist_ok=True)
    values = np.dstack(channels).astype(np.uint8)
    temporary = path.with_suffix(".partial.png")
    Image.fromarray(values, mode="RGBA").save(temporary, optimize=True)
    temporary.replace(path)


def _encode_density(densities):
    output = []
    for values in densities:
        encoded = np.zeros(values.shape, dtype=np.uint8)
        valid = np.isfinite(values)
        encoded[valid] = np.rint(np.clip(values[valid], 0, 100) * 2.55).astype(np.uint8)
        output.append(encoded)
    return output


def _green_density_10m():
    """Recreate the exact scientific 10 m focal-density grid from cached 1 m data."""
    source_path = CACHE_ROOT / "density-source" / "groenkaart" / "groenkaart-2021-halo.tif"
    if not source_path.exists():
        raise FileNotFoundError(f"Missing cached Green Map halo: {source_path}")
    fractions, valid = _fraction_grid(source_path, GREEN_CLASS_CODES)
    densities, coverage = focal_density(fractions, valid, circular_kernel())
    radius_cells = 100 // ANALYSIS_RESOLUTION
    densities = densities[:, radius_cells:-radius_cells, radius_cells:-radius_cells]
    coverage = coverage[radius_cells:-radius_cells, radius_cells:-radius_cells]
    with rasterio.open(source_path) as source:
        transform = source.transform * rasterio.Affine.scale(ANALYSIS_RESOLUTION)
        transform = transform * rasterio.Affine.translation(radius_cells, radius_cells)
    return densities, coverage, {
        "crs": "EPSG:31370", "transform": transform,
        "height": densities.shape[1], "width": densities.shape[2],
    }


def _reproject_green_to_grid(densities, coverage, density_grid, target_grid):
    projected = np.zeros((4, target_grid["height"], target_grid["width"]), dtype=np.float32)
    projected_coverage = np.zeros(projected.shape[1:], dtype=np.float32)
    valid = np.isfinite(coverage).astype(np.float32)
    reproject(
        valid, projected_coverage,
        src_transform=density_grid["transform"], src_crs=density_grid["crs"],
        dst_transform=target_grid["transform"], dst_crs=target_grid["crs"],
        resampling=Resampling.average,
    )
    for index, values in enumerate(densities):
        weighted = np.nan_to_num(values, nan=0.0) * valid
        total = np.zeros(projected.shape[1:], dtype=np.float32)
        reproject(
            weighted, total,
            src_transform=density_grid["transform"], src_crs=density_grid["crs"],
            dst_transform=target_grid["transform"], dst_crs=target_grid["crs"],
            resampling=Resampling.average,
        )
        projected[index] = np.divide(
            total, projected_coverage,
            out=np.full(total.shape, np.nan, dtype=np.float32),
            where=projected_coverage > 0,
        )
    return projected, projected_coverage


def _sector_grid(sectors, grid, majority=False):
    shapes = ((row.geometry, index + 1) for index, row in sectors.iterrows())
    if majority:
        return _subpixel_majority(shapes, grid)
    return rasterize(
        list(shapes), out_shape=(grid["height"], grid["width"]),
        transform=grid["transform"], fill=0, dtype="uint16",
    )


def _urban_grid(grid, majority=False):
    urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
    urban = gpd.read_file(urban_path).to_crs(grid["crs"])
    shapes = ((geometry, 1 if str(code) in URBAN_FABRIC_CODES else 0)
              for geometry, code in zip(urban.geometry, urban["classCode"]))
    if majority:
        return _subpixel_majority(shapes, grid) == 1
    return rasterize(
        list(shapes), out_shape=(grid["height"], grid["width"]),
        transform=grid["transform"], fill=0, dtype="uint8",
    ).astype(bool)


def _native_jaarbak_mask(grid):
    source_path = CACHE_ROOT / "density-source" / "jaarbak" / "jaarbak-2021-halo.tif"
    fractions, valid = _fraction_grid(source_path, (1,))
    radius_cells = 100 // ANALYSIS_RESOLUTION
    sealed = fractions[0, radius_cells:-radius_cells, radius_cells:-radius_cells]
    valid = valid[radius_cells:-radius_cells, radius_cells:-radius_cells]
    sealed_ratio = np.divide(sealed, valid, out=np.zeros_like(sealed), where=valid > 0)
    if sealed.shape != (grid["height"], grid["width"]):
        raise ValueError("The Green Map and JaarBAK 10 m grids are not aligned.")
    return (valid >= MINIMUM_NATIVE_JAARBAK_COVERAGE) & (sealed_ratio > 0.5)


def _income_records():
    payload = json.loads((PROJECT_ROOT / "public" / "data" / "income.json").read_text(encoding="utf-8"))
    return payload, payload["years"][str(INCOME_YEAR)]["sectorStats"]


def _sector_metadata(sectors):
    return {
        index + 1: {
            "sectorId": row.sectorId,
            "sectorName": row.sectorName,
            "municipality": row.municipality,
        }
        for index, row in sectors.iterrows()
    }


def _scope_indexes(sector_meta):
    scopes = {"region:zennevallei": tuple(sector_meta)}
    for municipality in MUNICIPALITIES:
        scopes[f"municipality:{municipality}"] = tuple(
            index for index, item in sector_meta.items() if item["municipality"] == municipality
        )
    for index, item in sector_meta.items():
        scopes[f"sector:{item['sectorId']}"] = (index,)
    return scopes


def _sector_regressions(sector_stats, x_key, y_value):
    """Store exact area-scoped OLS summaries used by sector scatter plots."""
    output = {}
    scopes = {"region:zennevallei": None, **{f"municipality:{name}": name for name in MUNICIPALITIES}}
    for scope_id, municipality in scopes.items():
        records = [record for record in sector_stats.values()
                   if municipality is None or record["municipality"] == municipality]
        output[scope_id] = y_value(records, x_key)
    return output


def _display_scopes_10m(sectors, grid):
    """Return dissolved display masks without analytical sector boundaries."""
    municipality_lookup = {name: index + 1 for index, name in enumerate(MUNICIPALITIES)}
    region = rasterize(
        [(sectors.geometry.union_all(), 1)], out_shape=(grid["height"], grid["width"]),
        transform=grid["transform"], fill=0, dtype="uint8",
    )
    municipality = rasterize(
        [(sectors.loc[sectors["municipality"] == name].geometry.union_all(), index)
         for name, index in municipality_lookup.items()],
        out_shape=(grid["height"], grid["width"]), transform=grid["transform"],
        fill=0, dtype="uint8",
    )
    return region, municipality, municipality_lookup


def _green_income_product(densities, coverage, density_grid, sectors, sector_index, urban, sealed, income):
    output_root = CACHE_ROOT / "groenkaart-income"
    eligible = urban & sealed & np.isfinite(coverage)
    encoded = _encode_density(np.where(eligible[None, ...], densities, np.nan))
    opaque = np.full_like(encoded[0], 255)
    empty = np.zeros_like(encoded[0])
    grid_path = output_root / "density-grid.png"
    _write_rgba(grid_path, [encoded[0], encoded[1], encoded[2], opaque])
    non_green_path = output_root / "density-non-green.png"
    _write_rgba(non_green_path, [encoded[3], empty, empty, opaque])
    region, municipality, municipality_lookup = _display_scopes_10m(sectors, density_grid)
    scope_path = output_root / "scope-index.png"
    _write_rgba(scope_path, [region, municipality, np.zeros_like(region), np.full_like(region, 255)])

    sector_meta = _sector_metadata(sectors)
    sector_stats = {}
    for index, metadata in sector_meta.items():
        selected = eligible & (sector_index == index)
        count = int(np.count_nonzero(selected))
        fiscal = income.get(metadata["sectorId"], {})
        sector_stats[metadata["sectorId"]] = {
            **metadata,
            "validCellCount": count,
            "analysedAreaHa": round(count * 0.01, 4),
            "meanDensityByGreenClass": {
                str(code): None if not count else round(float(np.mean(densities[band][selected])), 5)
                for band, code in enumerate(GREEN_CLASS_CODES)
            },
            "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
        }
    regressions = {}
    for codes in _green_combinations():
        key = _combination_key(codes)
        def calculate(records, x_key, selected_codes=codes):
            valid = [record for record in records if record["validCellCount"] >= 10
                     and record.get(x_key) is not None
                     and all(record["meanDensityByGreenClass"].get(str(code)) is not None for code in selected_codes)]
            return ordinary_least_squares(
                [record[x_key] for record in valid],
                [sum(record["meanDensityByGreenClass"][str(code)] for code in selected_codes) for record in valid],
            )
        regressions[key] = _sector_regressions(sector_stats, "income", calculate)
    stats_path = output_root / "statistics.json"
    stats_path.write_text(json.dumps({
        "schemaVersion": 1, "sectorStats": sector_stats, "regressions": regressions,
    }, separators=(",", ":")), encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "comparisonId": "groenkaart-income",
        "primaryLayerId": "groenkaart",
        "secondaryLayerId": "income",
        "greenMapYear": 2021,
        "urbanAtlasYear": 2021,
        "jaarbakYear": 2021,
        "incomeYear": INCOME_YEAR,
        "analysisResolutionMeters": 10,
        "minimumJaarbakCoverage": MINIMUM_NATIVE_JAARBAK_COVERAGE,
        "urbanFabricCodes": list(URBAN_FABRIC_CODES),
        "excludedUrbanAtlasCodes": [EXCLUDED_URBAN_CODE],
        "defaultGreenClasses": list(DEFAULT_GREEN_CLASSES),
        "greenClasses": list(GROENKAART_CLASSES),
        "coordinates": _coordinates(density_grid),
        "imageSize": [density_grid["width"], density_grid["height"]],
        "sectorIndexes": {item["sectorId"]: index for index, item in sector_meta.items()},
        "sectorMunicipalities": {item["sectorId"]: item["municipality"] for item in sector_meta.values()},
        "municipalityIndexes": municipality_lookup,
        "densityGridUrl": "groenkaart-income/density-grid.png",
        "densityNonGreenUrl": "groenkaart-income/density-non-green.png",
        "scopeIndexUrl": "groenkaart-income/scope-index.png",
        "statisticsUrl": "groenkaart-income/statistics.json",
        "densityGridSha256": file_hash(grid_path),
        "densityNonGreenSha256": file_hash(non_green_path),
        "scopeIndexSha256": file_hash(scope_path),
        "statisticsSha256": file_hash(stats_path),
    }
    (output_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _temperature_code(temperature):
    encoded = np.zeros(temperature.shape, dtype=np.uint16)
    valid = np.isfinite(temperature)
    encoded[valid] = np.rint(np.clip((temperature[valid] + 100.0) * 100.0, 1, 65535)).astype(np.uint16)
    return encoded


def _scope_regressions(temperature, densities, clear, sector_index, sector_meta):
    output = {}
    for scope_id, indexes in _scope_indexes(sector_meta).items():
        scope = clear & np.isin(sector_index, indexes)
        y = temperature[scope]
        output[scope_id] = {
            _combination_key(codes): ordinary_least_squares(np.sum(densities[np.array(codes) - 1], axis=0)[scope], y)
            for codes in _green_combinations()
        }
    return output


def _landsat_products(densities10, coverage10, density_grid, sectors, income_payload, income):
    landsat_manifest_path = CACHE_ROOT / "landsat-temperature" / "manifest.json"
    landsat = json.loads(landsat_manifest_path.read_text(encoding="utf-8"))
    selected_ids = tuple(item["value"] for item in landsat["timelineItems"])
    if selected_ids != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("The six selected Landsat observations are not current.")
    first = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{selected_ids[0]}.tif"
    _, _, _, grid = _read_analysis(first)
    sectors_projected = sectors.to_crs(grid["crs"])
    sector_index = _sector_grid(sectors_projected, grid, majority=True)
    sector_meta = _sector_metadata(sectors_projected)
    display_region, display_municipality, municipality_lookup = display_scope_indexes(sectors_projected, grid)
    scope_path = CACHE_ROOT / "landsat-groenkaart" / "scope-index.png"
    _write_rgba(scope_path, [display_region, display_municipality, np.zeros_like(display_region),
                             np.full_like(display_region, 255)])
    urban = _urban_grid(grid, majority=True)
    density30, density_coverage = _reproject_green_to_grid(densities10, coverage10, density_grid, grid)
    density_path = CACHE_ROOT / "landsat-groenkaart" / "green-density-grid.png"
    encoded_density = _encode_density(density30)
    opaque = np.full_like(encoded_density[0], 255)
    empty = np.zeros_like(encoded_density[0])
    _write_rgba(density_path, [encoded_density[0], encoded_density[1], encoded_density[2], opaque])
    density_non_green_path = CACHE_ROOT / "landsat-groenkaart" / "green-density-non-green.png"
    _write_rgba(density_non_green_path, [encoded_density[3], empty, empty, opaque])

    class_cache = {}
    green_observations = {}
    income_observations = {}
    for observation_id in selected_ids:
        year = YEAR_BY_OBSERVATION[observation_id]
        if year not in class_cache:
            source = CACHE_ROOT / "raw" / "jaarbak" / f"jaarbak-{year}.tif"
            class_cache[year] = _classify_jaarbak(source, grid)[0]
        soil = class_cache[year]
        temperature, status, _, observation_grid = _read_analysis(
            CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        )
        if observation_grid != grid:
            raise ValueError(f"{observation_id}: Landsat analytical grids differ.")
        eligible = urban & (soil == 1) & (density_coverage >= MINIMUM_LANDSAT_GREEN_COVERAGE)
        clear = eligible & (status == 1) & np.isfinite(temperature)
        encoded_temperature = _temperature_code(temperature)
        point_status = np.zeros(status.shape, dtype=np.uint8)
        # PNG alpha is premultiplied by browsers. Opaque status codes preserve
        # the temperature and sector channels exactly through Canvas decoding.
        point_status[eligible & (status == 1)] = POINT_CLEAR
        point_status[eligible & (status == 2)] = POINT_CLOUD
        point_status[eligible & (status != 1) & (status != 2)] = POINT_OTHER_MISSING
        point_path = CACHE_ROOT / "landsat-groenkaart" / "points" / f"{observation_id}.png"
        _write_rgba(point_path, [
            (encoded_temperature >> 8).astype(np.uint8),
            (encoded_temperature & 255).astype(np.uint8),
            sector_index.astype(np.uint8),
            point_status,
        ])

        sector_stats = {}
        for index, metadata in sector_meta.items():
            selected = clear & (sector_index == index)
            count = int(np.count_nonzero(selected))
            fiscal = income.get(metadata["sectorId"], {})
            sector_stats[metadata["sectorId"]] = {
                **metadata,
                "clearPixelCount": count,
                "analysedAreaHa": round(count * 0.09, 4),
                "meanTemperatureC": None if not count else round(float(np.mean(temperature[selected])), 5),
                "meanDensityByGreenClass": {
                    str(code): None if not count else round(float(np.mean(density30[band][selected])), 5)
                    for band, code in enumerate(GREEN_CLASS_CODES)
                },
                "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
            }
        green_stats_path = CACHE_ROOT / "landsat-groenkaart" / "statistics" / f"{observation_id}.json"
        green_stats_path.parent.mkdir(parents=True, exist_ok=True)
        green_stats_path.write_text(json.dumps({
            "schemaVersion": 1,
            "observationId": observation_id,
            "secondaryYear": year,
            "sectorStats": sector_stats,
            "regressions": _scope_regressions(temperature, density30, clear, sector_index, sector_meta),
        }, separators=(",", ":")), encoding="utf-8")

        income_stats_path = CACHE_ROOT / "landsat-income" / "statistics" / f"{observation_id}.json"
        income_stats_path.parent.mkdir(parents=True, exist_ok=True)
        def temperature_regression(records, x_key):
            valid = [record for record in records if record["clearPixelCount"] >= MINIMUM_SECTOR_LANDSAT_PIXELS
                     and record.get(x_key) is not None and record["meanTemperatureC"] is not None]
            return ordinary_least_squares(
                [record[x_key] for record in valid], [record["meanTemperatureC"] for record in valid],
            )
        income_stats_path.write_text(json.dumps({
            "schemaVersion": 1,
            "observationId": observation_id,
            "secondaryYear": year,
            "sectorStats": sector_stats,
            "regressions": _sector_regressions(sector_stats, "income", temperature_regression),
        }, separators=(",", ":")), encoding="utf-8")
        green_observations[observation_id] = {
            "jaarbakYear": year,
            "pointDataUrl": f"landsat-groenkaart/points/{observation_id}.png",
            "statisticsUrl": f"landsat-groenkaart/statistics/{observation_id}.json",
            "pointDataSha256": file_hash(point_path),
            "statisticsSha256": file_hash(green_stats_path),
        }
        income_observations[observation_id] = {
            "jaarbakYear": year,
            "pointDataUrl": f"landsat-groenkaart/points/{observation_id}.png",
            "statisticsUrl": f"landsat-income/statistics/{observation_id}.json",
            "statisticsSha256": file_hash(income_stats_path),
        }

    common = {
        "schemaVersion": 1,
        "urbanAtlasYear": 2021,
        "urbanFabricCodes": list(URBAN_FABRIC_CODES),
        "excludedUrbanAtlasCodes": [EXCLUDED_URBAN_CODE],
        "minimumJaarbakCoverage": MINIMUM_LANDSAT_JAARBAK_COVERAGE,
        "minimumGreenCoverage": MINIMUM_LANDSAT_GREEN_COVERAGE,
        "analysisResolutionMeters": 30,
        "coordinates": _coordinates(grid),
        "imageSize": [grid["width"], grid["height"]],
        "sectorIndexes": {item["sectorId"]: index for index, item in sector_meta.items()},
        "sectorMunicipalities": {item["sectorId"]: item["municipality"] for item in sector_meta.values()},
        "municipalityIndexes": municipality_lookup,
        "scopeIndexUrl": "landsat-groenkaart/scope-index.png",
        "scopeIndexSha256": file_hash(scope_path),
    }
    green_manifest = {
        **common,
        "comparisonId": "landsat-groenkaart",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "groenkaart",
        "greenMapYear": 2021,
        "defaultGreenClasses": list(DEFAULT_GREEN_CLASSES),
        "greenClasses": list(GROENKAART_CLASSES),
        "densityGridUrl": "landsat-groenkaart/green-density-grid.png",
        "densityNonGreenUrl": "landsat-groenkaart/green-density-non-green.png",
        "densityGridSha256": file_hash(density_path),
        "densityNonGreenSha256": file_hash(density_non_green_path),
        "observations": green_observations,
    }
    income_manifest = {
        **common,
        "comparisonId": "landsat-income",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "income",
        "incomeYear": INCOME_YEAR,
        "minimumSectorPixels": MINIMUM_SECTOR_LANDSAT_PIXELS,
        "observations": income_observations,
        "incomeSourceSha256": income_payload["source"]["sourceSha256"],
    }
    for comparison_id, manifest in (("landsat-groenkaart", green_manifest), ("landsat-income", income_manifest)):
        root = CACHE_ROOT / comparison_id
        root.mkdir(parents=True, exist_ok=True)
        (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return green_manifest, income_manifest


def prepare_sealed_urban_comparisons():
    """Generate all three products from verified local caches only."""
    densities, coverage, density_grid = _green_density_10m()
    sectors = gpd.read_file(SECTORS_PATH).to_crs(density_grid["crs"])
    sector_index = _sector_grid(sectors, density_grid)
    urban = _urban_grid(density_grid)
    sealed = _native_jaarbak_mask(density_grid)
    income_payload, income = _income_records()
    _green_income_product(densities, coverage, density_grid, sectors, sector_index, urban, sealed, income)
    _landsat_products(densities, coverage, density_grid, sectors, income_payload, income)
    for comparison_id in COMPARISON_IDS:
        manifest_path = CACHE_ROOT / comparison_id / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()
        manifest["sources"] = {
            "urbanAtlas": file_hash(PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"),
            "greenMapDensity": file_hash(CACHE_ROOT / "groenkaart" / "density" / "groenkaart-2021-density.tif"),
            "income": income_payload["source"]["sourceSha256"],
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return {comparison_id: json.loads((CACHE_ROOT / comparison_id / "manifest.json").read_text(encoding="utf-8"))
            for comparison_id in COMPARISON_IDS}
