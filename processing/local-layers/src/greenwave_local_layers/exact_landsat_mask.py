"""Exact-area accounting shared by Landsat comparison products.

The mask grid is the native 1 m Soil sealing grid in EPSG:31370.  A retained
mask cell contributes one square metre, but its temperature and observation
identifier always come from its parent 30 m Landsat cell.  The resulting table
is deliberately an area-accounting table, not a synthetic 1 m temperature
raster.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.warp import Resampling, reproject
from shapely.geometry import box

from .constants import CACHE_ROOT, PROJECT_ROOT, SECTORS_PATH
from .landsat import _read_analysis


SCHEMA_VERSION = 1
MASK_RESOLUTION_METERS = 1
TEMPERATURE_RESOLUTION_METERS = 30
MINIMUM_ANALYSED_AREA_M2 = 1_000
SOIL_INVALID, SOIL_UNSEALED, SOIL_SEALED = 0, 1, 2


@dataclass(frozen=True)
class ExactMaskTable:
    """Compressed exact intersections for one Landsat observation."""

    landsat: np.ndarray
    sector: np.ndarray
    urban_class: np.ndarray
    soil: np.ndarray
    status: np.ndarray
    population: np.ndarray
    area_m2: np.ndarray
    green_area_m2: np.ndarray
    green_sums: np.ndarray
    temperature: np.ndarray
    sector_ids: tuple[str, ...]
    urban_codes: tuple[str, ...]
    population_width: int

    @property
    def contributing_landsat_count(self) -> int:
        return int(np.unique(self.landsat[self.area_m2 > 0]).size)


def exact_area_mean(temperature_area_sum: float, area_m2: float):
    """Return the direct retained-cell mean, or ``None`` for no surface."""
    return None if area_m2 <= 0 else float(temperature_area_sum) / float(area_m2)


def meets_minimum_analysed_area(area_m2: float) -> bool:
    """Apply the shared 0.10 ha summary threshold without rounding."""
    return np.isfinite(area_m2) and float(area_m2) >= MINIMUM_ANALYSED_AREA_M2


def exact_area_summary(temperatures, areas_m2):
    """Summarise partial Landsat cells by their exact retained surface."""
    values = np.asarray(temperatures, dtype=np.float64)
    areas = np.asarray(areas_m2, dtype=np.float64)
    valid = np.isfinite(values) & np.isfinite(areas) & (areas > 0)
    if not np.any(valid):
        return {"analysedAreaHa": 0.0, "temperatureAreaSum": 0.0,
                "meanTemperatureC": None, "contributingLandsatCount": 0}
    values, areas = values[valid], areas[valid]
    return {
        "analysedAreaHa": round(float(np.sum(areas)) / 10_000, 4),
        "temperatureAreaSum": round(float(np.sum(values * areas)), 6),
        "meanTemperatureC": round(float(np.average(values, weights=areas)), 5),
        "contributingLandsatCount": int(values.size),
    }


def _source_signature(paths):
    return [
        [str(path), path.stat().st_size, path.stat().st_mtime_ns]
        for path in paths
    ]


def _cache_path(observation_id: str, soil_year: int) -> Path:
    return CACHE_ROOT / "exact-landsat-mask" / f"{observation_id}-soil-{soil_year}.npz"


def _load(path: Path) -> ExactMaskTable:
    with np.load(path, allow_pickle=False) as payload:
        metadata = json.loads(str(payload["metadata"].item()))
        return ExactMaskTable(
            landsat=payload["landsat"], sector=payload["sector"],
            urban_class=payload["urban_class"], soil=payload["soil"],
            status=payload["status"], population=payload["population"],
            area_m2=payload["area_m2"], green_area_m2=payload["green_area_m2"],
            green_sums=payload["green_sums"],
            temperature=payload["temperature"],
            sector_ids=tuple(metadata["sectorIds"]),
            urban_codes=tuple(metadata["urbanCodes"]),
            population_width=int(metadata["populationWidth"]),
        )


def _parent_raster(observation_id: str, source, landsat_grid) -> Path:
    """Cache the parent 30 m Landsat identifier on the native 1 m grid."""
    path = CACHE_ROOT / "exact-landsat-mask" / f"{observation_id}-parents.tif"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        with rasterio.open(path) as cached:
            if (cached.width, cached.height, cached.transform, str(cached.crs)) == (
                    source.width, source.height, source.transform, str(source.crs)):
                return path
    temporary = path.with_suffix(".partial.tif")
    temporary.unlink(missing_ok=True)
    parent_ids = np.arange(
        1, landsat_grid["width"] * landsat_grid["height"] + 1, dtype=np.uint32,
    ).reshape(landsat_grid["height"], landsat_grid["width"])
    profile = source.profile.copy()
    profile.update(count=1, dtype="uint32", nodata=0, tiled=True,
                   blockxsize=512, blockysize=512, compress="DEFLATE")
    with rasterio.open(temporary, "w", **profile) as output:
        reproject(
            parent_ids, rasterio.band(output, 1),
            src_transform=landsat_grid["transform"], src_crs=landsat_grid["crs"],
            dst_transform=source.transform, dst_crs=source.crs,
            src_nodata=0, dst_nodata=0, resampling=Resampling.nearest,
        )
    temporary.replace(path)
    return path


def prepare_exact_mask_table(
        observation_id: str, soil_year: int, *, densities=None, coverage=None,
        density_grid=None, force: bool = False) -> ExactMaskTable:
    """Build or reuse exact 1 m intersections for one Landsat observation.

    Records are aggregated only when all analytical dimensions are identical.
    This keeps the cache compact while preserving cross-sector, mixed-class and
    cross-population-cell boundaries exactly on the native mask grid.
    """
    soil_path = CACHE_ROOT / "density-source" / "jaarbak" / f"jaarbak-{soil_year}-halo.tif"
    analysis_path = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
    urban_path = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
    population_path = PROJECT_ROOT / "public" / "data" / "population" / "population-density-2019.tif"
    core_required = [soil_path, analysis_path, urban_path, SECTORS_PATH, population_path]
    required = list(core_required)
    if densities is not None:
        # Vegetation densities are deterministically derived from this halo.
        # Including it in the signature prevents an exact-mask cache from
        # silently retaining stale focal-density values after regeneration.
        required.append(CACHE_ROOT / "density-source" / "groenkaart" / "groenkaart-2021-halo.tif")
    missing = [path for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing exact-mask inputs: {missing}")
    cache_path = _cache_path(observation_id, soil_year)
    core_signature = _source_signature(core_required)
    signature = _source_signature(required)
    if cache_path.exists() and not force:
        with np.load(cache_path, allow_pickle=False) as cached:
            metadata = json.loads(str(cached["metadata"].item()))
        cached_sources = metadata.get("sources", [])
        core_matches = cached_sources[:len(core_signature)] == core_signature
        green_matches = (densities is None or (
            cached_sources == signature and metadata.get("hasGreenDensity")
        ))
        if metadata.get("schemaVersion") == SCHEMA_VERSION and core_matches and green_matches:
            return _load(cache_path)

    temperature, status, _, landsat_grid = _read_analysis(analysis_path)
    flat_temperature = temperature.ravel().astype(np.float64)
    flat_status = status.ravel().astype(np.uint8)
    sectors = gpd.read_file(SECTORS_PATH).to_crs("EPSG:31370")
    sector_ids = tuple(str(value) for value in sectors["sectorId"])
    sector_shapes = [(row.geometry, index + 1) for index, row in sectors.iterrows()]
    urban = gpd.read_file(urban_path).to_crs("EPSG:31370")
    urban_codes = tuple(sorted(str(value) for value in urban["classCode"].unique()))
    urban_lookup = {code: index + 1 for index, code in enumerate(urban_codes)}
    urban = urban.assign(_exact_index=urban["classCode"].astype(str).map(urban_lookup))
    urban_index = urban.sindex

    with rasterio.open(population_path) as population_source:
        population_transform = population_source.transform
        population_width = population_source.width
        population_height = population_source.height

    green = None
    green_valid = None
    if densities is not None:
        green = np.asarray(densities, dtype=np.float32).reshape(4, -1)
        green_valid = np.isfinite(np.asarray(coverage)).ravel()
        if density_grid is None:
            raise ValueError("density_grid is required with vegetation densities.")

    chunks = []
    with rasterio.open(soil_path) as soil_source:
        if str(soil_source.crs) != "EPSG:31370" or abs(soil_source.transform.a - 1) > 1e-6:
            raise ValueError("Exact masking requires the native 1 m EPSG:31370 soil grid.")
        parent_path = _parent_raster(observation_id, soil_source, landsat_grid)
        with rasterio.open(parent_path) as parents:
            for _, window in soil_source.block_windows(1):
                soil_values = soil_source.read(1, window=window)
                parent = parents.read(1, window=window)
                transform = soil_source.window_transform(window)
                bounds = rasterio.windows.bounds(window, soil_source.transform)
                shape = soil_values.shape
                sector = rasterize(
                    sector_shapes, out_shape=shape, transform=transform,
                    fill=0, dtype="uint16",
                )
                indexes = list(urban_index.query(box(*bounds), predicate="intersects"))
                urban_shapes = [
                    (row.geometry, int(row._exact_index))
                    for _, row in urban.iloc[indexes].iterrows() if not row.geometry.is_empty
                ]
                urban_class = rasterize(
                    urban_shapes, out_shape=shape, transform=transform,
                    fill=0, dtype="uint8",
                ) if urban_shapes else np.zeros(shape, dtype=np.uint8)
                selected = (sector > 0) & (parent > 0)
                if not np.any(selected):
                    continue
                rows, columns = np.nonzero(selected)
                land = parent[rows, columns].astype(np.int64)
                land_offset = land - 1
                sector_values = sector[rows, columns].astype(np.int64)
                ua_values = urban_class[rows, columns].astype(np.int64)
                raw_soil = soil_values[rows, columns]
                soil_state = np.where(raw_soil == 1, SOIL_SEALED,
                                      np.where(raw_soil == 0, SOIL_UNSEALED, SOIL_INVALID)).astype(np.int64)
                landsat_status = flat_status[land_offset].astype(np.int64)

                x = transform.c + (columns + .5) * transform.a
                y = transform.f + (rows + .5) * transform.e
                pop_columns = np.floor((x - population_transform.c) / population_transform.a).astype(np.int64)
                pop_rows = np.floor((population_transform.f - y) / abs(population_transform.e)).astype(np.int64)
                pop_inside = ((pop_columns >= 0) & (pop_columns < population_width)
                              & (pop_rows >= 0) & (pop_rows < population_height))
                population = np.where(pop_inside, pop_rows * population_width + pop_columns + 1, 0)

                green_values = np.full((4, len(rows)), np.nan, dtype=np.float32)
                if green is not None:
                    density_columns = np.floor(
                        (x - density_grid["transform"].c) / density_grid["transform"].a,
                    ).astype(np.int64)
                    density_rows = np.floor(
                        (density_grid["transform"].f - y) / abs(density_grid["transform"].e),
                    ).astype(np.int64)
                    density_inside = (
                        (density_columns >= 0) & (density_columns < density_grid["width"])
                        & (density_rows >= 0) & (density_rows < density_grid["height"])
                    )
                    density_flat = np.where(
                        density_inside, density_rows * density_grid["width"] + density_columns, 0,
                    )
                    density_ok = density_inside & green_valid[density_flat]
                    green_values[:, density_ok] = green[:, density_flat[density_ok]]

                # Packing dimensions into one integer makes the block and final
                # reductions deterministic without materialising 1 m records.
                key = land
                for values, size in (
                    (sector_values, len(sector_ids) + 1),
                    (ua_values, len(urban_codes) + 1),
                    (soil_state, 3), (landsat_status, 3),
                    (population, population_width * population_height + 1),
                ):
                    key = key * size + values
                unique, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
                first = np.unique(inverse, return_index=True)[1]
                sums = np.stack([
                    np.bincount(inverse, weights=np.nan_to_num(values, nan=0.0), minlength=len(unique))
                    for values in green_values
                ], axis=1)
                valid_green = np.bincount(
                    inverse, weights=np.all(np.isfinite(green_values), axis=0), minlength=len(unique),
                )
                chunks.append((
                    land[first], sector_values[first], ua_values[first], soil_state[first],
                    landsat_status[first], population[first], counts.astype(np.int64), sums,
                    valid_green.astype(np.int64),
                ))

    if not chunks:
        raise ValueError(f"{observation_id}: exact mask produced no records.")
    fields = [np.concatenate([chunk[index] for chunk in chunks]) for index in range(9)]
    land, sector, ua, soil, record_status, population, area, green_sums, green_area = fields
    # Block boundaries can split identical analytical records; reduce once more.
    key = land.astype(np.int64)
    for values, size in (
        (sector, len(sector_ids) + 1), (ua, len(urban_codes) + 1),
        (soil, 3), (record_status, 3),
        (population, population_width * population_height + 1),
    ):
        key = key * size + values
    unique, inverse = np.unique(key, return_inverse=True)
    first = np.unique(inverse, return_index=True)[1]
    area = np.bincount(inverse, weights=area, minlength=len(unique)).astype(np.int64)
    green_area = np.bincount(inverse, weights=green_area, minlength=len(unique)).astype(np.int64)
    reduced_green = np.stack([
        np.bincount(inverse, weights=green_sums[:, band], minlength=len(unique))
        for band in range(4)
    ], axis=1)
    # Green sums are meaningful only where every retained 1 m position had a
    # valid 100 m density. Consumers can compare green_area with exact area.
    reduced_green[green_area == 0] = np.nan
    metadata = {
        "schemaVersion": SCHEMA_VERSION, "sources": signature,
        "maskResolutionMeters": MASK_RESOLUTION_METERS,
        "temperatureResolutionMeters": TEMPERATURE_RESOLUTION_METERS,
        "aggregation": "exact-masked-area",
        "minimumAnalysedAreaHa": MINIMUM_ANALYSED_AREA_M2 / 10_000,
        "sectorIds": sector_ids, "urbanCodes": urban_codes,
        "populationWidth": population_width, "hasGreenDensity": densities is not None,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_path.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary, landsat=land[first].astype(np.uint32), sector=sector[first].astype(np.uint16),
        urban_class=ua[first].astype(np.uint8), soil=soil[first].astype(np.uint8),
        status=record_status[first].astype(np.uint8), population=population[first].astype(np.uint32),
        area_m2=area.astype(np.uint32), green_area_m2=green_area.astype(np.uint32),
        green_sums=reduced_green.astype(np.float32),
        temperature=flat_temperature.astype(np.float32), metadata=json.dumps(metadata, separators=(",", ":")),
    )
    temporary.replace(cache_path)
    return _load(cache_path)


def urban_indexes(table: ExactMaskTable, codes) -> np.ndarray:
    wanted = {str(code) for code in codes}
    indexes = [index + 1 for index, code in enumerate(table.urban_codes) if code in wanted]
    return np.asarray(indexes, dtype=np.uint8)


def selected_records(table: ExactMaskTable, *, urban_codes=None, soil=None, status=None):
    selected = table.area_m2 > 0
    if urban_codes is not None:
        selected &= np.isin(table.urban_class, urban_indexes(table, urban_codes))
    if soil is not None:
        selected &= table.soil == soil
    if status is not None:
        selected &= table.status == status
    return selected
