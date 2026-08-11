"""Prepare the three sealed-urban comparison products.

Urban Atlas supplies the urban-fabric mask, JaarBAK supplies the sealed-surface
mask, Green Map supplies 100 m focal density, and Landsat supplies clear-sky
surface temperature. Browser PNGs are lossless analytical indexes; all area,
mean and regression values are calculated from the floating-point grids here.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from scipy.stats import rankdata
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import array_bounds
from rasterio.windows import Window, bounds as window_bounds, from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds
from shapely.geometry import box

from .constants import CACHE_ROOT, GROENKAART_CLASSES, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .density import ANALYSIS_RESOLUTION, _fraction_grid, circular_kernel, focal_density
from .exact_landsat_mask import MINIMUM_ANALYSED_AREA_M2, SOIL_SEALED, prepare_exact_mask_table
from .landsat import EXPECTED_SELECTED_OBSERVATIONS, _read_analysis
from .landsat_jaarbak import YEAR_BY_OBSERVATION, _classify_jaarbak, display_scope_indexes
from .pipeline import _pmtiles, _validate_pmtiles, _write_cutline, file_hash, update_index

COMPARISON_IDS = ("landsat-groenkaart", "groenkaart-income", "landsat-income")
URBAN_FABRIC_CODES = ("11100", "11210", "11220", "11230", "11240")
EXCLUDED_URBAN_CODE = "11300"
GREEN_CLASS_CODES = (1, 2, 3, 4)
DEFAULT_GREEN_CLASSES = (1, 2)
LANDSAT_GREEN_SURFACE_GROUPS = (
    {"id": "residential", "codes": URBAN_FABRIC_CODES, "color": "#b84242"},
    {"id": "employmentInstitutional", "codes": ("12100",), "color": "#9147b7"},
)
INCOME_YEAR = 2023
MINIMUM_LANDSAT_JAARBAK_COVERAGE = 0.50
MINIMUM_NATIVE_JAARBAK_COVERAGE = 0.95
POINT_CLEAR = 255
POINT_CLOUD = 254
POINT_OTHER_MISSING = 253
URBAN_FABRIC_MASK_URL = "shared/urban-fabric-2021.pmtiles"
URBAN_CLASS_MASK_URL = "shared/urban-atlas-classes-2021.pmtiles"
MINIMUM_GREEN_INCOME_AREA_HA = 0.10
EXACT_MASK_SCHEMA_VERSION = 6


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
    x_scale = float(np.sqrt(np.sum((x - x_mean) ** 2)))
    y_scale = float(np.sqrt(np.sum((y - y_mean) ** 2)))
    pearson = None if x_scale <= 0 or y_scale <= 0 else float(np.sum((x - x_mean) * (y - y_mean)) / (x_scale * y_scale))
    ranked_x = rankdata(x, method="average")
    ranked_y = rankdata(y, method="average")
    rank_x_scale = float(np.sqrt(np.sum((ranked_x - np.mean(ranked_x)) ** 2)))
    rank_y_scale = float(np.sqrt(np.sum((ranked_y - np.mean(ranked_y)) ** 2)))
    spearman = None if rank_x_scale <= 0 or rank_y_scale <= 0 else float(
        np.sum((ranked_x - np.mean(ranked_x)) * (ranked_y - np.mean(ranked_y)))
        / (rank_x_scale * rank_y_scale)
    )
    return {
        "count": int(len(x)),
        "slope": round(slope, 8),
        "intercept": round(intercept, 8),
        "rSquared": None if r_squared is None else round(r_squared, 8),
        "pearsonR": None if pearson is None else round(pearson, 8),
        "spearmanRho": None if spearman is None else round(spearman, 8),
        "xMinimum": round(float(np.min(x)), 4),
        "xMaximum": round(float(np.max(x)), 4),
        "yMinimum": round(float(np.min(y)), 4),
        "yMaximum": round(float(np.max(y)), 4),
    }


def exact_area_weighted_sums(density_values, pixel_counts):
    """Weight parent-cell densities by their exact eligible 1 m pixel counts."""
    values = np.asarray(density_values, dtype=np.float64)
    weights = np.asarray(pixel_counts, dtype=np.float64)
    if values.ndim == 1:
        values = values[None, :]
    if values.shape[1] != weights.size or np.any(weights < 0):
        raise ValueError("Density values and exact pixel weights are incompatible.")
    return np.sum(values * weights, axis=1)


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


def _prepare_urban_fabric_mask():
    """Create one exact 1 m Urban Atlas mask used only for browser clipping."""
    source_path = CACHE_ROOT / "raw" / "jaarbak" / "jaarbak-2021.tif"
    if not source_path.exists():
        raise FileNotFoundError(f"Missing cached JaarBAK 2021 raster: {source_path}")
    urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
    urban = gpd.read_file(urban_path)
    urban = urban.loc[urban["classCode"].astype(str).isin(URBAN_FABRIC_CODES)].copy()
    sectors = gpd.read_file(SECTORS_PATH)
    output_root = CACHE_ROOT / "shared"
    output_root.mkdir(parents=True, exist_ok=True)
    mask_tif = output_root / "urban-fabric-2021-mask.tif"
    archive = output_root / "urban-fabric-2021.pmtiles"
    cutline = output_root / "zennevallei-cutline.geojson"
    urban_sha = file_hash(urban_path)
    if mask_tif.exists() and archive.exists():
        with rasterio.open(mask_tif) as prepared:
            tags = prepared.tags()
        if tags.get("urban_atlas_sha256") == urban_sha \
                and tags.get("urban_fabric_codes") == ",".join(URBAN_FABRIC_CODES):
            _validate_pmtiles(archive, 10, 17)
            return {"url": URBAN_FABRIC_MASK_URL, "sha256": file_hash(archive)}

    with rasterio.open(source_path) as source:
        urban = urban.to_crs(source.crs)
        sector_union = sectors.to_crs(source.crs).geometry.union_all()
        window = from_bounds(*sector_union.bounds, transform=source.transform)
        window = window.round_offsets().round_lengths().intersection(Window(0, 0, source.width, source.height))
        profile = source.profile.copy()
        profile.update(
            width=int(window.width), height=int(window.height), transform=source.window_transform(window),
            count=4, dtype="uint8", nodata=None, photometric="RGB", tiled=True,
            blockxsize=512, blockysize=512, compress="DEFLATE",
        )
        spatial_index = urban.sindex
        with rasterio.open(mask_tif, "w", **profile) as output:
            for _, output_window in output.block_windows(1):
                transform = output.window_transform(output_window)
                bounds = window_bounds(output_window, output.transform)
                indexes = list(spatial_index.query(box(*bounds), predicate="intersects"))
                shapes = [(geometry, 1) for geometry in urban.iloc[indexes].geometry if not geometry.is_empty]
                selected = rasterize(
                    shapes,
                    out_shape=(int(output_window.height), int(output_window.width)),
                    transform=transform,
                    fill=0,
                    dtype="uint8",
                ) if shapes else np.zeros((int(output_window.height), int(output_window.width)), dtype=np.uint8)
                rgba = np.zeros((4, *selected.shape), dtype=np.uint8)
                rgba[:3, selected == 1] = 255
                rgba[3, selected == 1] = 255
                output.write(rgba, window=output_window)
            output.update_tags(
                urban_atlas_sha256=urban_sha,
                urban_fabric_codes=",".join(URBAN_FABRIC_CODES),
                excluded_code=EXCLUDED_URBAN_CODE,
            )

    _write_cutline(cutline, sectors.geometry.union_all())
    _pmtiles(mask_tif, archive, cutline, "10..17")
    _validate_pmtiles(archive, 10, 17)
    return {"url": URBAN_FABRIC_MASK_URL, "sha256": file_hash(archive)}


def _prepare_urban_atlas_class_mask():
    """Rasterise the original Urban Atlas polygons to one indexed browser mask."""
    source_path = CACHE_ROOT / "raw" / "jaarbak" / "jaarbak-2021.tif"
    if not source_path.exists():
        raise FileNotFoundError(f"Missing cached JaarBAK 2021 raster: {source_path}")
    urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
    manifest_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.json"
    urban_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    present_codes = [str(item["code"]) for item in urban_manifest["classes"] if item.get("present")]
    if not present_codes or len(present_codes) > 254:
        raise ValueError("Urban Atlas class indexes must fit in one lossless byte.")
    class_indexes = {code: index for index, code in enumerate(present_codes, start=1)}
    urban = gpd.read_file(urban_path)
    urban = urban.loc[urban["classCode"].astype(str).isin(class_indexes)].copy()
    sectors = gpd.read_file(SECTORS_PATH)
    output_root = CACHE_ROOT / "shared"
    output_root.mkdir(parents=True, exist_ok=True)
    mask_tif = output_root / "urban-atlas-classes-2021-mask.tif"
    archive = output_root / "urban-atlas-classes-2021.pmtiles"
    cutline = output_root / "zennevallei-cutline.geojson"
    source_sha = file_hash(urban_path)
    index_tag = json.dumps(class_indexes, sort_keys=True, separators=(",", ":"))
    if mask_tif.exists() and archive.exists():
        with rasterio.open(mask_tif) as prepared:
            tags = prepared.tags()
        if tags.get("urban_atlas_sha256") == source_sha and tags.get("class_indexes") == index_tag:
            _validate_pmtiles(archive, 10, 17)
            return {"url": URBAN_CLASS_MASK_URL, "sha256": file_hash(archive), "classIndexes": class_indexes}

    with rasterio.open(source_path) as source:
        urban = urban.to_crs(source.crs)
        sector_union = sectors.to_crs(source.crs).geometry.union_all()
        window = from_bounds(*sector_union.bounds, transform=source.transform)
        window = window.round_offsets().round_lengths().intersection(Window(0, 0, source.width, source.height))
        profile = source.profile.copy()
        profile.update(
            width=int(window.width), height=int(window.height), transform=source.window_transform(window),
            count=4, dtype="uint8", nodata=None, photometric="RGB", tiled=True,
            blockxsize=512, blockysize=512, compress="DEFLATE",
        )
        spatial_index = urban.sindex
        with rasterio.open(mask_tif, "w", **profile) as output:
            for _, output_window in output.block_windows(1):
                transform = output.window_transform(output_window)
                bounds = window_bounds(output_window, output.transform)
                indexes = list(spatial_index.query(box(*bounds), predicate="intersects"))
                shapes = [
                    (row.geometry, class_indexes[str(row.classCode)])
                    for _, row in urban.iloc[indexes].iterrows() if not row.geometry.is_empty
                ]
                selected = rasterize(
                    shapes,
                    out_shape=(int(output_window.height), int(output_window.width)),
                    transform=transform, fill=0, dtype="uint8",
                ) if shapes else np.zeros((int(output_window.height), int(output_window.width)), dtype=np.uint8)
                rgba = np.zeros((4, *selected.shape), dtype=np.uint8)
                rgba[0] = selected
                rgba[3, selected > 0] = 255
                output.write(rgba, window=output_window)
            output.update_tags(
                urban_atlas_sha256=source_sha,
                class_indexes=index_tag,
                source_geometry="Urban Atlas 2021 polygons",
            )
    _write_cutline(cutline, sectors.geometry.union_all())
    _pmtiles(mask_tif, archive, cutline, "10..17")
    _validate_pmtiles(archive, 10, 17)
    return {"url": URBAN_CLASS_MASK_URL, "sha256": file_hash(archive), "classIndexes": class_indexes}


def _exact_green_income_statistics(densities, coverage, density_grid, sectors, income):
    """Area-weight focal density separately for both exact sealed UA groups."""
    source_path = CACHE_ROOT / "density-source" / "jaarbak" / "jaarbak-2021-halo.tif"
    if not source_path.exists():
        raise FileNotFoundError(f"Missing cached JaarBAK halo: {source_path}")
    urban = gpd.read_file(PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson").to_crs("EPSG:31370")
    code_to_group = {
        code: index for index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS, start=1)
        for code in group["codes"]
    }
    urban = urban.loc[urban["classCode"].astype(str).isin(code_to_group)].copy()
    sector_meta = _sector_metadata(sectors)
    sector_shapes = [(row.geometry, index + 1) for index, row in sectors.iterrows()]
    group_count = len(LANDSAT_GREEN_SURFACE_GROUPS)
    pixels = np.zeros((group_count, len(sector_meta) + 1), dtype=np.int64)
    density_cells = np.zeros((group_count, len(sector_meta) + 1), dtype=np.int64)
    weighted = np.zeros((group_count, len(sector_meta) + 1, len(GREEN_CLASS_CODES)), dtype=np.float64)
    flat_density = densities.reshape(len(GREEN_CLASS_CODES), -1)
    flat_valid = np.isfinite(coverage).ravel()
    cell_count = density_grid["height"] * density_grid["width"]

    with rasterio.open(source_path) as source:
        column_offset = int(round((density_grid["transform"].c - source.transform.c) / source.res[0]))
        row_offset = int(round((source.transform.f - density_grid["transform"].f) / abs(source.res[1])))
        native_width = density_grid["width"] * ANALYSIS_RESOLUTION
        native_height = density_grid["height"] * ANALYSIS_RESOLUTION
        if column_offset < 0 or row_offset < 0 or column_offset + native_width > source.width \
                or row_offset + native_height > source.height:
            raise ValueError("The exact JaarBAK window does not cover the Green Map density grid.")
        urban_index = urban.sindex
        rows_per_chunk = 100
        for target_row in range(0, density_grid["height"], rows_per_chunk):
            target_rows = min(rows_per_chunk, density_grid["height"] - target_row)
            window = Window(
                column_offset,
                row_offset + target_row * ANALYSIS_RESOLUTION,
                native_width,
                target_rows * ANALYSIS_RESOLUTION,
            )
            values = source.read(1, window=window)
            transform = source.window_transform(window)
            bounds = window_bounds(window, source.transform)
            urban_indexes = list(urban_index.query(box(*bounds), predicate="intersects"))
            urban_shapes = [
                (row.geometry, code_to_group[str(row.classCode)])
                for _, row in urban.iloc[urban_indexes].iterrows() if not row.geometry.is_empty
            ]
            urban_mask = rasterize(
                urban_shapes, out_shape=values.shape, transform=transform, fill=0, dtype="uint8",
            ) if urban_shapes else np.zeros(values.shape, dtype=np.uint8)
            sector_mask = rasterize(
                sector_shapes, out_shape=values.shape, transform=transform, fill=0, dtype="uint16",
            )
            for group_index in range(1, group_count + 1):
                rows, columns = np.nonzero(
                    (values == 1) & (urban_mask == group_index) & (sector_mask > 0)
                )
                if not len(rows):
                    continue
                parent_rows = target_row + rows // ANALYSIS_RESOLUTION
                parent_columns = columns // ANALYSIS_RESOLUTION
                parent_cells = parent_rows * density_grid["width"] + parent_columns
                valid = flat_valid[parent_cells]
                if not np.any(valid):
                    continue
                parent_cells = parent_cells[valid]
                sector_values = sector_mask[rows[valid], columns[valid]].astype(np.int64)
                combined = sector_values * cell_count + parent_cells
                keys, counts = np.unique(combined, return_counts=True)
                key_sectors = keys // cell_count
                key_cells = keys % cell_count
                for sector_index in np.unique(key_sectors):
                    selected = key_sectors == sector_index
                    weights = counts[selected].astype(np.float64)
                    cells = key_cells[selected]
                    slot = group_index - 1
                    pixels[slot, sector_index] += int(np.sum(weights))
                    density_cells[slot, sector_index] += int(len(cells))
                    weighted[slot, sector_index] += exact_area_weighted_sums(flat_density[:, cells], weights)

    sector_stats = {}
    for index, metadata in sector_meta.items():
        pixel_count = int(np.sum(pixels[:, index]))
        fiscal = income.get(metadata["sectorId"], {})
        group_stats = {}
        for group_index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS):
            group_pixels = int(pixels[group_index, index])
            group_stats[group["id"]] = {
                "eligibleDensityCellCount": int(density_cells[group_index, index]),
                "analysedAreaHa": round(group_pixels * 0.0001, 4),
                "meanDensityByGreenClass": {
                    str(code): None if not group_pixels else round(
                        float(weighted[group_index, index, band] / group_pixels), 5
                    )
                    for band, code in enumerate(GREEN_CLASS_CODES)
                },
            }
        sector_stats[metadata["sectorId"]] = {
            **metadata,
            "eligibleDensityCellCount": int(np.sum(density_cells[:, index])),
            "analysedAreaHa": round(pixel_count * 0.0001, 4),
            "meanDensityByGreenClass": {
                str(code): None if not pixel_count else round(float(np.sum(weighted[:, index, band]) / pixel_count), 5)
                for band, code in enumerate(GREEN_CLASS_CODES)
            },
            "urbanSurfaceGroups": group_stats,
            "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
        }
    return sector_stats


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


def _income_category(value):
    if value is None or not np.isfinite(value):
        return None
    if value < 30_000:
        return "low"
    if value < 40_000:
        return "middle"
    return "high"


def _distribution_summary(values):
    values = np.asarray(values, dtype=np.float64)
    values = values[np.isfinite(values)]
    if not values.size:
        return None
    q1, median, q3 = np.quantile(values, [.25, .5, .75])
    spread = q3 - q1
    low_fence, high_fence = q1 - 1.5 * spread, q3 + 1.5 * spread
    inside = values[(values >= low_fence) & (values <= high_fence)]
    return {
        "count": int(values.size), "mean": round(float(np.mean(values)), 5),
        "q1": round(float(q1), 5), "median": round(float(median), 5), "q3": round(float(q3), 5),
        "whiskerLow": round(float(np.min(inside)), 5), "whiskerHigh": round(float(np.max(inside)), 5),
        "p10": round(float(np.quantile(values, .1)), 5), "p90": round(float(np.quantile(values, .9)), 5),
    }


def _surface_selection_keys():
    """The two explicit UA groups have only three valid non-empty selections."""
    return (
        ("residential",),
        ("employmentInstitutional",),
        ("residential", "employmentInstitutional"),
    )


def _surface_selection_key(ids):
    return "+".join(ids)


def _exact_group_indexes(table):
    """Map exact Urban Atlas class indexes to the two explicit UI groups."""
    code_to_group = {
        code: index for index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS, start=1)
        for code in group["codes"]
    }
    lookup = np.asarray(
        [0, *(code_to_group.get(code, 0) for code in table.urban_codes)], dtype=np.uint8,
    )
    return lookup[table.urban_class]


def _aggregate_exact_green_points(table):
    """Return exact masked records keyed by native Landsat cell and scope."""
    groups = _exact_group_indexes(table)
    temperatures = table.temperature[table.landsat - 1]
    selected = (
        (table.status == 1) & (table.soil == SOIL_SEALED) & (groups > 0)
        & (table.green_area_m2 > 0) & np.isfinite(temperatures)
    )
    if not np.any(selected):
        return []
    land = table.landsat[selected].astype(np.int64)
    sector = table.sector[selected].astype(np.int64)
    group = groups[selected].astype(np.int64)
    key = (sector * (table.temperature.size + 1) + land) * 3 + group
    unique, inverse = np.unique(key, return_inverse=True)
    first = np.unique(inverse, return_index=True)[1]
    area = np.bincount(inverse, weights=table.green_area_m2[selected], minlength=len(unique))
    sums = np.stack([
        np.bincount(inverse, weights=np.nan_to_num(table.green_sums[selected, band]), minlength=len(unique))
        for band in range(4)
    ], axis=1)
    return [
        [int(sector[source]), int(land[source]), int(group[source]), int(round(area[index])),
         *[round(float(value), 5) for value in sums[index]],
         round(float(temperatures[selected][source]), 5)]
        for index, source in enumerate(first)
    ]


def _aggregate_exact_income_sectors(table, sector_meta, income):
    """Area-weight Landsat temperature over exact sealed Urban Atlas surface."""
    groups = _exact_group_indexes(table)
    temperature = table.temperature[table.landsat - 1]
    selected = (
        (table.status == 1) & (table.soil == SOIL_SEALED) & (groups > 0)
        & np.isfinite(temperature)
    )
    selected_sector = table.sector[selected].astype(np.int64)
    selected_group = groups[selected].astype(np.int64)
    selected_land = table.landsat[selected].astype(np.int64)
    keys = selected_sector * 3 + selected_group
    size = (len(sector_meta) + 1) * 3
    areas = np.bincount(keys, weights=table.area_m2[selected], minlength=size)
    temperature_sums = np.bincount(
        keys, weights=temperature[selected] * table.area_m2[selected], minlength=size,
    )
    unique_pairs = np.unique(keys * (table.temperature.size + 1) + selected_land)
    pair_keys = unique_pairs // (table.temperature.size + 1)
    pair_landsat = unique_pairs % (table.temperature.size + 1)
    landsat_counts = np.bincount(pair_keys, minlength=size)
    unique_sector_landsat = np.unique(
        selected_sector * (table.temperature.size + 1) + selected_land,
    )
    sector_landsat_counts = np.bincount(
        unique_sector_landsat // (table.temperature.size + 1), minlength=len(sector_meta) + 1,
    )
    output = {}
    for sector_index, metadata in sector_meta.items():
        group_stats = {}
        for group_index, group in enumerate(LANDSAT_GREEN_SURFACE_GROUPS, start=1):
            key = sector_index * 3 + group_index
            area_m2 = int(round(areas[key]))
            temperature_sum = float(temperature_sums[key])
            group_stats[group["id"]] = {
                "analysedAreaHa": round(area_m2 / 10_000, 4),
                "temperatureAreaSum": round(temperature_sum, 6),
                "contributingLandsatCount": int(landsat_counts[key]),
                "landsatIndexes": pair_landsat[pair_keys == key].astype(int).tolist(),
                "meanTemperatureC": None if not area_m2 else round(temperature_sum / area_m2, 5),
            }
        area_m2 = int(round(sum(item["analysedAreaHa"] * 10_000 for item in group_stats.values())))
        temperature_sum = float(sum(item["temperatureAreaSum"] for item in group_stats.values()))
        fiscal = income.get(metadata["sectorId"], {})
        output[metadata["sectorId"]] = {
            **metadata,
            "analysedAreaHa": round(area_m2 / 10_000, 4),
            "temperatureAreaSum": round(temperature_sum, 6),
            "contributingLandsatCount": int(sector_landsat_counts[sector_index]),
            "meanTemperatureC": None if not area_m2 else round(temperature_sum / area_m2, 5),
            "urbanSurfaceGroups": group_stats,
            "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
        }
    return output


def _selected_income_sector_stats(sector_stats, selected_ids):
    output = {}
    for sector_id, record in sector_stats.items():
        groups = [record["urbanSurfaceGroups"][group_id] for group_id in selected_ids]
        area_m2 = sum(group["analysedAreaHa"] * 10_000 for group in groups)
        temperature_sum = sum(group["temperatureAreaSum"] for group in groups)
        output[sector_id] = {
            **record,
            "analysedAreaHa": round(area_m2 / 10_000, 4),
            "temperatureAreaSum": round(temperature_sum, 6),
            "contributingLandsatCount": len({
                index for group in groups for index in group.get("landsatIndexes", [])
            }),
            "meanTemperatureC": None if not area_m2 else round(temperature_sum / area_m2, 5),
        }
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


def _green_income_product(densities, coverage, density_grid, sectors, income, urban_class_mask):
    output_root = CACHE_ROOT / "groenkaart-income"
    sector_meta = _sector_metadata(sectors)
    encoded = _encode_density(densities)
    validity = np.where(np.isfinite(coverage), 255, 0).astype(np.uint8)
    empty = np.zeros_like(encoded[0])
    grid_path = output_root / "density-grid.png"
    _write_rgba(grid_path, [encoded[0], encoded[1], encoded[2], validity])
    non_green_path = output_root / "density-non-green.png"
    _write_rgba(non_green_path, [encoded[3], empty, empty, validity])
    region, municipality, municipality_lookup = _display_scopes_10m(sectors, density_grid)
    scope_path = output_root / "scope-index.png"
    _write_rgba(scope_path, [region, municipality, np.zeros_like(region), np.full_like(region, 255)])

    sector_stats = _exact_green_income_statistics(densities, coverage, density_grid, sectors, income)
    regressions = {}
    for codes in _green_combinations():
        key = _combination_key(codes)
        def calculate(records, x_key, selected_codes=codes):
            valid = [record for record in records if record["analysedAreaHa"] >= MINIMUM_GREEN_INCOME_AREA_HA
                     and record.get(x_key) is not None
                     and all(record["meanDensityByGreenClass"].get(str(code)) is not None for code in selected_codes)]
            return ordinary_least_squares(
                [record[x_key] for record in valid],
                [sum(record["meanDensityByGreenClass"][str(code)] for code in selected_codes) for record in valid],
            )
        regressions[key] = _sector_regressions(sector_stats, "income", calculate)
    stats_path = output_root / "statistics.json"
    stats_path.write_text(json.dumps({
        "schemaVersion": 3, "sectorStats": sector_stats, "regressions": regressions,
    }, separators=(",", ":")), encoding="utf-8")
    manifest = {
        "schemaVersion": 4,
        "comparisonId": "groenkaart-income",
        "primaryLayerId": "groenkaart",
        "secondaryLayerId": "income",
        "greenMapYear": 2021,
        "urbanAtlasYear": 2021,
        "jaarbakYear": 2021,
        "incomeYear": INCOME_YEAR,
        "analysisResolutionMeters": 10,
        "maskResolutionMeters": 1,
        "displayResolutionMeters": 1,
        "minimumEligibleAreaHa": MINIMUM_GREEN_INCOME_AREA_HA,
        "minimumAnalysedAreaHa": MINIMUM_GREEN_INCOME_AREA_HA,
        "aggregation": "exact-masked-area",
        "statisticWeighting": "exact-sealed-urban-area",
        "minimumJaarbakCoverage": MINIMUM_NATIVE_JAARBAK_COVERAGE,
        "urbanFabricCodes": list(URBAN_FABRIC_CODES),
        "excludedUrbanAtlasCodes": [EXCLUDED_URBAN_CODE],
        "urbanAtlasClassMaskUrl": urban_class_mask["url"],
        "urbanAtlasClassMaskSha256": urban_class_mask["sha256"],
        "urbanAtlasClassIndexes": urban_class_mask["classIndexes"],
        "urbanSurfaceGroups": [
            {"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
            for group in LANDSAT_GREEN_SURFACE_GROUPS
        ],
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
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


def landsat_display_status(temperature, status):
    """Encode every Landsat status without applying comparison eligibility."""
    output = np.full(np.asarray(status).shape, POINT_OTHER_MISSING, dtype=np.uint8)
    output[(status == 1) & np.isfinite(temperature)] = POINT_CLEAR
    output[status == 2] = POINT_CLOUD
    return output


def _landsat_products(
        densities10, coverage10, density_grid, sectors, income_payload, income,
        urban_mask, urban_class_mask):
    landsat_manifest_path = CACHE_ROOT / "landsat-temperature" / "manifest.json"
    landsat = json.loads(landsat_manifest_path.read_text(encoding="utf-8"))
    selected_ids = tuple(item["value"] for item in landsat["timelineItems"])
    if selected_ids != EXPECTED_SELECTED_OBSERVATIONS:
        raise ValueError("The six selected Landsat observations are not current.")
    first = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{selected_ids[0]}.tif"
    _, _, _, grid = _read_analysis(first)
    sectors_projected = sectors.to_crs(grid["crs"])
    sector_meta = _sector_metadata(sectors_projected)
    display_region, display_municipality, municipality_lookup = display_scope_indexes(sectors_projected, grid)
    scope_path = CACHE_ROOT / "landsat-groenkaart" / "scope-index.png"
    _write_rgba(scope_path, [display_region, display_municipality, np.zeros_like(display_region),
                             np.full_like(display_region, 255)])
    density30, density_coverage = _reproject_green_to_grid(densities10, coverage10, density_grid, grid)
    density_path = CACHE_ROOT / "landsat-groenkaart" / "green-density-grid.png"
    encoded_density = _encode_density(density30)
    opaque = np.full_like(encoded_density[0], 255)
    empty = np.zeros_like(encoded_density[0])
    _write_rgba(density_path, [encoded_density[0], encoded_density[1], encoded_density[2], opaque])
    density_non_green_path = CACHE_ROOT / "landsat-groenkaart" / "green-density-non-green.png"
    _write_rgba(density_non_green_path, [encoded_density[3], empty, empty, opaque])
    green_observations = {}
    income_observations = {}
    for observation_id in selected_ids:
        year = YEAR_BY_OBSERVATION[observation_id]
        temperature, status, _, observation_grid = _read_analysis(
            CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        )
        if observation_grid != grid:
            raise ValueError(f"{observation_id}: Landsat analytical grids differ.")
        exact = prepare_exact_mask_table(
            observation_id, year, densities=densities10, coverage=coverage10,
            density_grid=density_grid,
        )
        encoded_temperature = _temperature_code(temperature)
        display_status = landsat_display_status(temperature, status)
        display_path = CACHE_ROOT / "shared" / "landsat-display" / f"{observation_id}.png"
        _write_rgba(display_path, [
            (encoded_temperature >> 8).astype(np.uint8),
            (encoded_temperature & 255).astype(np.uint8),
            np.zeros_like(display_status, dtype=np.uint8),
            display_status,
        ])
        point_path = CACHE_ROOT / "landsat-groenkaart" / "points" / f"{observation_id}.json.gz"
        point_path.parent.mkdir(parents=True, exist_ok=True)
        exact_points = _aggregate_exact_green_points(exact)
        point_payload = json.dumps({
            "schemaVersion": 2, "observationId": observation_id,
            "encoding": ["sectorIndex", "landsatIndex", "urbanSurfaceGroupIndex", "maskedAreaM2",
                         "highGreenAreaSum", "lowGreenAreaSum", "agricultureAreaSum",
                         "nonGreenAreaSum", "temperatureC"],
            "records": exact_points,
        }, separators=(",", ":")).encode("utf-8")
        # The index is losslessly compressed for static hosting. Scientific
        # precision and record cardinality are unchanged in the browser.
        point_path.write_bytes(gzip.compress(point_payload, compresslevel=9, mtime=0))

        green_stats_path = CACHE_ROOT / "landsat-groenkaart" / "statistics" / f"{observation_id}.json"
        green_stats_path.parent.mkdir(parents=True, exist_ok=True)
        green_stats_path.write_text(json.dumps({
            "schemaVersion": 2,
            "observationId": observation_id,
            "secondaryYear": year,
            "pointCount": len(exact_points),
            "aggregation": "exact-masked-area",
        }, separators=(",", ":")), encoding="utf-8")

        income_stats_path = CACHE_ROOT / "landsat-income" / "statistics" / f"{observation_id}.json"
        income_stats_path.parent.mkdir(parents=True, exist_ok=True)
        income_sector_stats = _aggregate_exact_income_sectors(exact, sector_meta, income)
        def temperature_regression(records, x_key):
            valid = [record for record in records if record["analysedAreaHa"] >= MINIMUM_GREEN_INCOME_AREA_HA
                     and record.get(x_key) is not None and record["meanTemperatureC"] is not None]
            return ordinary_least_squares(
                [record[x_key] for record in valid], [record["meanTemperatureC"] for record in valid],
            )
        regressions_by_surface = {}
        categories_by_surface = {}
        for selected_ids in _surface_selection_keys():
            key = _surface_selection_key(selected_ids)
            selected_stats = _selected_income_sector_stats(income_sector_stats, selected_ids)
            regressions_by_surface[key] = _sector_regressions(
                selected_stats, "income", temperature_regression,
            )
            categories_by_surface[key] = {
                scope_id: {"sectors": {
                    category: _distribution_summary([
                        record["meanTemperatureC"] for record in (
                            selected_stats[sector_meta[index]["sectorId"]] for index in indexes
                        ) if record["analysedAreaHa"] >= MINIMUM_GREEN_INCOME_AREA_HA
                        and _income_category(record.get("income")) == category
                    ]) for category in ("low", "middle", "high")
                }} for scope_id, indexes in _scope_indexes(sector_meta).items()
            }
        income_stats_path.write_text(json.dumps({
            "schemaVersion": 3,
            "observationId": observation_id,
            "secondaryYear": year,
            "sectorStats": income_sector_stats,
            "regressions": _sector_regressions(income_sector_stats, "income", temperature_regression),
            "regressionsBySurface": regressions_by_surface,
            "incomeCategoriesBySurface": categories_by_surface,
        }, separators=(",", ":")), encoding="utf-8")
        green_observations[observation_id] = {
            "jaarbakYear": year,
            "displayDataUrl": f"shared/landsat-display/{observation_id}.png",
            "pointDataUrl": f"landsat-groenkaart/points/{observation_id}.json.gz",
            "statisticsUrl": f"landsat-groenkaart/statistics/{observation_id}.json",
            "displayDataSha256": file_hash(display_path),
            "pointDataSha256": file_hash(point_path),
            "statisticsSha256": file_hash(green_stats_path),
        }
        income_observations[observation_id] = {
            "jaarbakYear": year,
            "displayDataUrl": f"shared/landsat-display/{observation_id}.png",
            "statisticsUrl": f"landsat-income/statistics/{observation_id}.json",
            "displayDataSha256": file_hash(display_path),
            "statisticsSha256": file_hash(income_stats_path),
        }

    common = {
        "schemaVersion": 1,
        "urbanAtlasYear": 2021,
        "urbanFabricCodes": list(URBAN_FABRIC_CODES),
        "excludedUrbanAtlasCodes": [EXCLUDED_URBAN_CODE],
        "maskResolutionMeters": 1,
        "temperatureResolutionMeters": 30,
        "aggregation": "exact-masked-area",
        "minimumAnalysedAreaHa": MINIMUM_ANALYSED_AREA_M2 / 10_000,
        "minimumPixelMaskedAreaM2": 1,
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
        "schemaVersion": 6,
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
        "urbanFabricMaskUrl": urban_mask["url"],
        "urbanFabricMaskSha256": urban_mask["sha256"],
        "urbanAtlasClassMaskUrl": urban_class_mask["url"],
        "urbanAtlasClassMaskSha256": urban_class_mask["sha256"],
        "urbanAtlasClassIndexes": urban_class_mask["classIndexes"],
        "urbanSurfaceGroups": [
            {"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
            for group in LANDSAT_GREEN_SURFACE_GROUPS
        ],
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
        "pointEncoding": ["sectorIndex", "landsatIndex", "urbanSurfaceGroupIndex", "maskedAreaM2",
                          "highGreenAreaSum", "lowGreenAreaSum", "agricultureAreaSum",
                          "nonGreenAreaSum", "temperatureC"],
        "displayResolutionMeters": 1,
        "observations": green_observations,
    }
    income_manifest = {
        **common,
        "schemaVersion": 4,
        "comparisonId": "landsat-income",
        "primaryLayerId": "landsat-temperature",
        "secondaryLayerId": "income",
        "incomeYear": INCOME_YEAR,
        "minimumAnalysedAreaHa": MINIMUM_ANALYSED_AREA_M2 / 10_000,
        "urbanAtlasClassMaskUrl": urban_class_mask["url"],
        "urbanAtlasClassMaskSha256": urban_class_mask["sha256"],
        "urbanAtlasClassIndexes": urban_class_mask["classIndexes"],
        "urbanSurfaceGroups": [
            {"id": group["id"], "codes": list(group["codes"]), "color": group["color"]}
            for group in LANDSAT_GREEN_SURFACE_GROUPS
        ],
        "defaultUrbanSurfaceGroups": [group["id"] for group in LANDSAT_GREEN_SURFACE_GROUPS],
        "displayResolutionMeters": 1,
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
    urban_mask = _prepare_urban_fabric_mask()
    urban_class_mask = _prepare_urban_atlas_class_mask()
    income_payload, income = _income_records()
    _green_income_product(densities, coverage, density_grid, sectors, income, urban_class_mask)
    _landsat_products(
        densities, coverage, density_grid, sectors, income_payload, income,
        urban_mask, urban_class_mask,
    )
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
