"""Catalogue and radial land-cover features for clear Landsat temperatures.

The authoritative classifications remain on their shared 1 m Belgian Lambert
grid. The catalogue stores eligible 30 m Landsat centres and targets; five
mutually exclusive land-cover channels are read lazily around each centre.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
import math
from pathlib import Path
import shutil
import zipfile

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.transform import array_bounds
from rasterio.windows import Window
from rasterio.warp import transform as transform_coordinates, transform_bounds
from shapely import contains_xy

from .analysis_water import (
    DEFAULT_LAND_USE_PATH,
    LAND_USE_WATER_CODE,
    LAND_USE_YEAR,
    analysis_water_metadata,
    analysis_water_union,
    prepare_analysis_water_context,
)
from .constants import CACHE_ROOT, PROJECT_ROOT, SECTORS_PATH
from .landsat_jaarbak import YEAR_BY_OBSERVATION
from .scenario_land_cover import xgboost_land_cover_channels
from .sources import file_hash


SCHEMA_VERSION = 5
DEFAULT_OBSERVATION_ID = "landsat-2026-06-22"
PATCH_RADIUS_METERS = 100
PATCH_RESOLUTION_METERS = 1
PATCH_SIZE = PATCH_RADIUS_METERS * 2
RADIAL_BAND_EDGES_METERS = (0, 25, 50, 75, 100)
GREEN_YEAR = 2021
URBAN_ATLAS_YEAR = 2021
LAND_COVER_CHANNEL_NAMES = (
    "soil_sealing", "high_green", "low_green", "agriculture", "water",
)
URBAN_FABRIC_CODES = ("11100", "11210", "11220", "11230", "11240")
WATER_CODE = "50000"
UA_VALID = np.uint8(1)
UA_URBAN_FABRIC = np.uint8(2)
UA_WATER = np.uint8(4)
CATALOG_ROOT = CACHE_ROOT / "image-regression"


def _xgboost_input_contract():
    return {
        "channels": list(LAND_COVER_CHANNEL_NAMES),
        "radialBandEdgesMeters": list(RADIAL_BAND_EDGES_METERS),
        "featureCount": len(LAND_COVER_CHANNEL_NAMES) * (len(RADIAL_BAND_EDGES_METERS) - 1),
        "implicitRemainder": "other-unsealed-bare-soil-proxy",
        "surfaceContract": "mutually-exclusive-upper-surface-v5-landgebruik-water",
        "priority": ["water", "agriculture", "high_green", "soil_sealing", "low_green", "other_unsealed"],
        "waterContract": {
            "rule": "urban-atlas-water-union-landgebruik-2025-water",
            "urbanAtlasCode": WATER_CODE,
            "landUseYear": LAND_USE_YEAR,
            "landUseCode": LAND_USE_WATER_CODE,
            "landUseResampling": "nearest",
        },
    }


@dataclass(frozen=True)
class RegressionCatalog:
    """Prepared sample metadata and the aligned rasters used by the loader."""

    observation_id: str
    samples: pd.DataFrame
    manifest: dict
    cache_dir: Path
    soil_path: Path
    green_path: Path
    urban_context_path: Path
    water_context_path: Path


@dataclass(frozen=True)
class SpatialFold:
    """One sector-held-out fold and its leakage-buffer exclusions."""

    fold: int
    train_indices: np.ndarray
    test_indices: np.ndarray
    excluded_buffer_indices: np.ndarray
    train_sector_ids: tuple[str, ...]
    test_sector_ids: tuple[str, ...]
    diagnostics: dict


def center_is_eligible(soil_value, urban_value, landsat_status, temperature) -> bool:
    """Use every clear finite Landsat centre; disk validity is checked later."""
    del soil_value, urban_value
    return bool(int(landsat_status) == 1 and np.isfinite(temperature))


@lru_cache(maxsize=None)
def _support_and_rings(radius: int = PATCH_RADIUS_METERS):
    offsets = np.arange(radius * 2, dtype=np.float32) + 0.5 - radius
    yy, xx = np.meshgrid(offsets, offsets, indexing="ij")
    distance = np.sqrt(xx * xx + yy * yy)
    support = distance < radius
    rings = np.floor(distance).astype(np.int16)
    rings[~support] = -1
    return support, rings


SUPPORT_MASK, RING_INDEX = _support_and_rings()


def radial_band_fractions(
        patch, valid_mask=None, band_edges=RADIAL_BAND_EDGES_METERS,
        radius: int = PATCH_RADIUS_METERS):
    """Return area-weighted active fractions in contiguous radial distance bands."""
    values = np.asarray(patch, dtype=np.float32)
    expected = (radius * 2, radius * 2)
    if values.ndim != 3 or values.shape[1:] != expected:
        raise ValueError(f"Patch must have shape (channels, {expected[0]}, {expected[1]}).")
    edges = np.asarray(band_edges, dtype=np.float64)
    if edges.ndim != 1 or len(edges) < 2 or not np.all(np.isfinite(edges)):
        raise ValueError("Radial band edges must be a finite one-dimensional sequence.")
    if edges[0] != 0 or edges[-1] != radius or np.any(np.diff(edges) <= 0) \
            or not np.all(edges == np.rint(edges)):
        raise ValueError(f"Radial bands must increase continuously from 0 to {radius} metres.")
    support, rings = _support_and_rings(radius)
    valid = support if valid_mask is None else support & np.asarray(valid_mask, dtype=bool)
    if valid.shape != expected:
        raise ValueError(f"Valid mask must have shape {expected}.")
    features = np.empty((values.shape[0], len(edges) - 1), dtype=np.float32)
    for band_index, (lower, upper) in enumerate(zip(edges[:-1], edges[1:])):
        band = valid & (rings >= lower) & (rings < upper)
        valid_count = int(np.count_nonzero(band))
        if not valid_count:
            raise ValueError(f"Radial band [{lower}, {upper}) contains no valid pixels.")
        features[:, band_index] = values[:, band].sum(axis=1) / valid_count
    return np.clip(features, 0.0, 1.0).astype(np.float32, copy=False)


def _relative_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return str(resolved)


def _resolve_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def _source_signature(path: Path):
    stat = path.stat()
    return {
        "path": _relative_path(path),
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "sha256": file_hash(path),
    }


def _signature_is_current(signature: dict) -> bool:
    path = _resolve_path(signature["path"])
    if not path.exists():
        return False
    stat = path.stat()
    return stat.st_size == signature["size"] and stat.st_mtime_ns == signature["mtimeNs"]


def _atomic_json(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _default_urban_atlas_source() -> Path:
    root = PROJECT_ROOT / ".cache" / "urban-atlas"
    candidates = sorted(
        path for path in root.glob("*")
        if path.is_file() and path.stat().st_size > 1_000_000
    )
    if not candidates:
        raise FileNotFoundError(
            "The official full Urban Atlas product is missing. Run the existing "
            "Urban Atlas preparation or pass urban_atlas_source explicitly."
        )
    return candidates[0]


def _extract_urban_atlas_fgb(source: Path, source_sha256: str) -> Path:
    """Return a real FGB path, extracting the official ZIP container once."""
    with source.open("rb") as stream:
        magic = stream.read(4)
    if magic != b"PK\x03\x04":
        return source
    with zipfile.ZipFile(source) as archive:
        members = [item for item in archive.infolist() if item.filename.lower().endswith(".fgb")]
        if len(members) != 1:
            raise ValueError("The Urban Atlas archive must contain exactly one FlatGeobuf file.")
        member = members[0]
        raw_root = CATALOG_ROOT / "raw"
        raw_root.mkdir(parents=True, exist_ok=True)
        destination = raw_root / Path(member.filename).name
        marker = destination.with_suffix(".source.json")
        if destination.exists() and marker.exists():
            metadata = json.loads(marker.read_text(encoding="utf-8"))
            if metadata == {"archiveSha256": source_sha256, "size": member.file_size} \
                    and destination.stat().st_size == member.file_size:
                return destination
        temporary = destination.with_suffix(".partial.fgb")
        temporary.unlink(missing_ok=True)
        with archive.open(member) as input_stream, temporary.open("wb") as output_stream:
            shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
        temporary.replace(destination)
        _atomic_json(marker, {"archiveSha256": source_sha256, "size": member.file_size})
        return destination


def _normalise_urban_code(value) -> str:
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    return text.zfill(5)


def _column_casefold(frame: pd.DataFrame, name: str) -> str:
    matches = [column for column in frame.columns if str(column).casefold() == name.casefold()]
    if not matches:
        raise ValueError(f"Urban Atlas source is missing the {name!r} field.")
    return matches[0]


def _validate_aligned_sources(soil_path: Path, green_path: Path):
    with rasterio.open(soil_path) as soil, rasterio.open(green_path) as green:
        soil_contract = (soil.shape, soil.transform, str(soil.crs), soil.res)
        green_contract = (green.shape, green.transform, str(green.crs), green.res)
        if soil_contract != green_contract:
            raise ValueError("JaarBAK and Groenkaart halo rasters must use the same grid.")
        if str(soil.crs) != "EPSG:31370" or soil.res != (1.0, 1.0):
            raise ValueError("Image regression requires the native 1 m EPSG:31370 ground grid.")


def _prepare_urban_context(
        source: Path, source_sha256: str, soil_path: Path, sectors: gpd.GeoDataFrame,
        *, force: bool = False, destination: Path | None = None,
        radius_m: int = PATCH_RADIUS_METERS) -> Path:
    """Rasterise full-product validity, urban fabric and water as bit flags."""
    destination = destination or CATALOG_ROOT / "shared" / "urban-atlas-2021-context.tif"
    expected_tags = {
        "source_sha256": source_sha256,
        "urban_fabric_codes": ",".join(URBAN_FABRIC_CODES),
        "water_code": WATER_CODE,
        "encoding": "bit0-valid_bit1-urban-fabric_bit2-water",
        "radius_halo_m": str(radius_m),
    }
    if destination.exists() and not force:
        with rasterio.open(destination) as prepared, rasterio.open(soil_path) as soil:
            same_grid = (
                prepared.shape == soil.shape and prepared.transform == soil.transform
                and prepared.crs == soil.crs
            )
            if same_grid and all(prepared.tags().get(key) == value for key, value in expected_tags.items()):
                return destination

    flatgeobuf = _extract_urban_atlas_fgb(source, source_sha256)
    header = gpd.read_file(flatgeobuf, rows=1)
    if header.crs is None:
        raise ValueError("The official Urban Atlas FlatGeobuf has no CRS.")
    with rasterio.open(soil_path) as soil:
        raster_bounds = array_bounds(soil.height, soil.width, soil.transform)
        profile = soil.profile.copy()
        target_crs = str(soil.crs)
    analysis_area = sectors.to_crs(target_crs).geometry.union_all().buffer(radius_m + 2)
    query_bounds = transform_bounds(
        target_crs, str(header.crs), *analysis_area.bounds, densify_pts=21,
    )
    urban = gpd.read_file(flatgeobuf, bbox=query_bounds)
    code_column = _column_casefold(urban, "code_2021")
    urban = urban.loc[~urban.geometry.is_empty & urban.geometry.notna()].copy()
    urban["_code"] = urban[code_column].map(_normalise_urban_code)
    values = np.ones(len(urban), dtype=np.uint8)
    values[urban["_code"].isin(URBAN_FABRIC_CODES).to_numpy()] |= UA_URBAN_FABRIC
    values[(urban["_code"] == WATER_CODE).to_numpy()] |= UA_WATER
    urban["_mask_value"] = values
    urban = urban.to_crs(target_crs)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial.tif")
    temporary.unlink(missing_ok=True)
    profile.update(
        driver="GTiff", count=1, dtype="uint8", nodata=0, tiled=True,
        blockxsize=512, blockysize=512, compress="ZSTD", zstd_level=3, predictor=2,
    )
    # Rasterio/GDAL can burn the complete vector set onto this 390 MB byte
    # grid substantially faster than thousands of Python-level block calls.
    # The array is transient; the durable output remains a tiled compressed
    # raster and lazy dataset reads still touch only one 200 x 200 window.
    context = rasterize(
        ((geometry, int(value)) for geometry, value in zip(urban.geometry, urban["_mask_value"])),
        out_shape=(profile["height"], profile["width"]),
        transform=profile["transform"], fill=0, dtype="uint8",
    )
    with rasterio.open(temporary, "w", **profile) as output:
        output.write(context, 1)
        output.update_tags(**expected_tags, source_geometry="official full Urban Atlas FGB")
    del context
    temporary.replace(destination)
    return destination


def _grid_point_indexes(source, x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    transform = source.transform
    columns = np.floor((x - transform.c) / transform.a).astype(np.int64)
    rows = np.floor((transform.f - y) / abs(transform.e)).astype(np.int64)
    inside = (
        (rows >= 0) & (rows < source.height)
        & (columns >= 0) & (columns < source.width)
    )
    return rows, columns, inside


def _sample_points(path: Path, x, y, fill=0):
    """Sample many points with one read per touched raster block."""
    with rasterio.open(path) as source:
        rows, columns, inside = _grid_point_indexes(source, x, y)
        output = np.full(len(rows), fill, dtype=np.dtype(source.dtypes[0]))
        positions = np.flatnonzero(inside)
        if not len(positions):
            return output
        block_height, block_width = source.block_shapes[0]
        block_columns = math.ceil(source.width / block_width)
        keys = (rows[positions] // block_height) * block_columns + columns[positions] // block_width
        order = np.argsort(keys, kind="stable")
        positions, keys = positions[order], keys[order]
        for key in np.unique(keys):
            selected = positions[keys == key]
            block_row, block_column = divmod(int(key), block_columns)
            window = Window(
                block_column * block_width, block_row * block_height,
                min(block_width, source.width - block_column * block_width),
                min(block_height, source.height - block_row * block_height),
            )
            block = source.read(1, window=window)
            output[selected] = block[
                rows[selected] - int(window.row_off), columns[selected] - int(window.col_off)
            ]
        return output


def _coarse_complete_grid(soil_path: Path, green_path: Path, urban_path: Path, factor: int = 10):
    """Conservatively mark 10 m cells whose every native pixel is valid."""
    with rasterio.open(soil_path) as soil, rasterio.open(green_path) as green, \
            rasterio.open(urban_path) as urban:
        if soil.shape != green.shape or soil.shape != urban.shape:
            raise ValueError("All ground rasters must share one shape.")
        if soil.height % factor or soil.width % factor:
            return None
        target_height, target_width = soil.height // factor, soil.width // factor
        complete = np.ones((target_height, target_width), dtype=bool)
        rows_per_chunk = 1000
        for row in range(0, soil.height, rows_per_chunk):
            rows = min(rows_per_chunk, soil.height - row)
            window = Window(0, row, soil.width, rows)
            soil_values = soil.read(1, window=window)
            green_values = green.read(1, window=window)
            urban_values = urban.read(1, window=window)
            valid = (
                np.isin(soil_values, (0, 1))
                & np.isin(green_values, (1, 2, 3, 4))
                & ((urban_values & UA_VALID) != 0)
            )
            reduced = valid.reshape(rows // factor, factor, target_width, factor).all(axis=(1, 3))
            complete[row // factor:(row + rows) // factor] = reduced
        return complete


def _read_ground_arrays(handles, center_row: int, center_column: int, radius: int = PATCH_RADIUS_METERS):
    window = Window(center_column - radius, center_row - radius, radius * 2, radius * 2)
    return tuple(source.read(1, window=window) for source in handles)


def _ground_valid(soil, green, urban):
    return (
        np.isin(soil, (0, 1))
        & np.isin(green, (1, 2, 3, 4))
        & ((urban & UA_VALID) != 0)
    )


def _complete_candidate_mask(
        frame: pd.DataFrame, soil_path: Path, green_path: Path, urban_path: Path):
    coarse = _coarse_complete_grid(soil_path, green_path, urban_path)
    keep = np.zeros(len(frame), dtype=bool)
    fallback = []
    factor = 10
    for position, row in enumerate(frame.itertuples(index=False)):
        top = int(row.patch_center_row) - PATCH_RADIUS_METERS
        left = int(row.patch_center_col) - PATCH_RADIUS_METERS
        bottom, right = top + PATCH_SIZE, left + PATCH_SIZE
        if coarse is not None and top >= 0 and left >= 0:
            row_start, row_stop = top // factor, math.ceil(bottom / factor)
            col_start, col_stop = left // factor, math.ceil(right / factor)
            if row_stop <= coarse.shape[0] and col_stop <= coarse.shape[1] \
                    and coarse[row_start:row_stop, col_start:col_stop].all():
                keep[position] = True
                continue
        fallback.append(position)
    if fallback:
        with rasterio.open(soil_path) as soil, rasterio.open(green_path) as green, \
                rasterio.open(urban_path) as urban:
            for position in fallback:
                row = frame.iloc[position]
                arrays = _read_ground_arrays(
                    (soil, green, urban), int(row.patch_center_row), int(row.patch_center_col),
                )
                keep[position] = arrays[0].shape == (PATCH_SIZE, PATCH_SIZE) \
                    and _ground_valid(*arrays)[SUPPORT_MASK].all()
    return keep


def _build_sample_index(
        observation_id: str, soil_year: int, landsat_path: Path, soil_path: Path,
        green_path: Path, urban_path: Path, sectors: gpd.GeoDataFrame):
    with rasterio.open(landsat_path) as landsat:
        temperature = landsat.read(1)
        status = landsat.read(2).astype(np.uint8)
        uncertainty = landsat.read(3)
        selected = (status == 1) & np.isfinite(temperature) & (temperature != landsat.nodata)
        rows, columns = np.nonzero(selected)
        transform = landsat.transform
        x_utm = transform.c + (columns + 0.5) * transform.a + (rows + 0.5) * transform.b
        y_utm = transform.f + (columns + 0.5) * transform.d + (rows + 0.5) * transform.e
        x_lambert, y_lambert = transform_coordinates(
            landsat.crs, "EPSG:31370", x_utm.tolist(), y_utm.tolist(),
        )
        x_lambert = np.asarray(x_lambert, dtype=np.float64)
        y_lambert = np.asarray(y_lambert, dtype=np.float64)
        target = temperature[rows, columns].astype(np.float32)
        uncertainty_values = uncertainty[rows, columns].astype(np.float32)

    with rasterio.open(soil_path) as ground:
        patch_columns = np.rint((x_lambert - ground.transform.c) / ground.transform.a).astype(np.int32)
        patch_rows = np.rint((ground.transform.f - y_lambert) / abs(ground.transform.e)).astype(np.int32)
        snapped_x = ground.transform.c + patch_columns * ground.transform.a
        snapped_y = ground.transform.f + patch_rows * ground.transform.e

    frame = pd.DataFrame({
        "sample_id": [f"{observation_id}:{row}:{column}" for row, column in zip(rows, columns)],
        "site_id": [f"{row}:{column}" for row, column in zip(rows, columns)],
        "observation_id": observation_id,
        "landsat_row": rows.astype(np.int32),
        "landsat_col": columns.astype(np.int32),
        "patch_center_row": patch_rows,
        "patch_center_col": patch_columns,
        "x_utm": x_utm,
        "y_utm": y_utm,
        "x_lambert": x_lambert,
        "y_lambert": y_lambert,
        "snapped_x_lambert": snapped_x,
        "snapped_y_lambert": snapped_y,
        "snap_offset_m": np.hypot(snapped_x - x_lambert, snapped_y - y_lambert),
        "lst_c": target,
        "uncertainty_k": uncertainty_values,
        "soil_year": np.int16(soil_year),
        "green_year": np.int16(GREEN_YEAR),
        "urban_year": np.int16(URBAN_ATLAS_YEAR),
    })

    points = gpd.GeoDataFrame(
        {"_position": np.arange(len(frame), dtype=np.int64)},
        geometry=gpd.points_from_xy(frame["x_lambert"], frame["y_lambert"]),
        crs="EPSG:31370",
    )
    sector_columns = sectors.to_crs("EPSG:31370")[["sectorId", "municipality", "geometry"]]
    joined = gpd.sjoin(points, sector_columns, how="inner", predicate="intersects")
    joined = joined.rename(columns={"sectorId": "sector_id"})
    joined = joined.sort_values(["_position", "sector_id"], kind="stable").drop_duplicates("_position")
    frame = frame.iloc[joined["_position"].to_numpy()].copy()
    frame["sector_id"] = joined["sector_id"].astype(str).to_numpy()
    frame["municipality"] = joined["municipality"].astype(str).to_numpy()
    frame = frame.sort_values(["landsat_row", "landsat_col"], kind="stable").reset_index(drop=True)
    complete = _complete_candidate_mask(frame, soil_path, green_path, urban_path)
    frame = frame.loc[complete].reset_index(drop=True)
    frame["ground_coverage"] = np.float32(1.0)
    return frame


def _catalog_paths(observation_id: str):
    root = CATALOG_ROOT / observation_id
    return root, root / "manifest.json", root / "samples.csv.gz"


def prepare_regression_catalog(
        observation_id: str = DEFAULT_OBSERVATION_ID, urban_atlas_source=None,
        force: bool = False) -> RegressionCatalog:
    """Prepare and load the lightweight catalog for one Landsat acquisition."""
    if observation_id not in YEAR_BY_OBSERVATION:
        raise ValueError(f"No Soil-sealing year is configured for {observation_id}.")
    soil_year = YEAR_BY_OBSERVATION[observation_id]
    source = Path(urban_atlas_source).resolve() if urban_atlas_source else _default_urban_atlas_source()
    if not source.exists():
        raise FileNotFoundError(source)
    root, manifest_path, samples_path = _catalog_paths(observation_id)
    if manifest_path.exists() and samples_path.exists() and not force:
        try:
            # Schema 2 existed briefly before the XGBoost radial-band metadata
            # was added. Upgrade that metadata without rebuilding identical
            # sample coordinates or source rasters.
            cached_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if cached_manifest.get("schemaVersion") == SCHEMA_VERSION \
                    and cached_manifest.get("xgboostInput") is None:
                cached_manifest["xgboostInput"] = _xgboost_input_contract()
                _atomic_json(manifest_path, cached_manifest)
            catalog = load_regression_catalog(observation_id)
            manifest_source = _resolve_path(catalog.manifest["sources"]["urbanAtlas"]["path"]).resolve()
            if manifest_source == source.resolve():
                return catalog
        except (FileNotFoundError, ValueError, OSError, KeyError):
            pass

    landsat_path = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
    soil_path = CACHE_ROOT / "density-source" / "jaarbak" / f"jaarbak-{soil_year}-halo.tif"
    green_path = CACHE_ROOT / "density-source" / "groenkaart" / f"groenkaart-{GREEN_YEAR}-halo.tif"
    required = (landsat_path, soil_path, green_path, SECTORS_PATH, source)
    missing = [path for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing image-regression inputs: {missing}")
    _validate_aligned_sources(soil_path, green_path)
    sectors = gpd.read_file(SECTORS_PATH)
    if not {"sectorId", "municipality"}.issubset(sectors.columns):
        raise ValueError("Statbel sectors must contain sectorId and municipality.")

    print(f"Preparing Urban Atlas context for {observation_id}…", flush=True)
    urban_signature = _source_signature(source)
    urban_context = _prepare_urban_context(
        source, urban_signature["sha256"], soil_path, sectors, force=force,
    )
    print(f"Preparing additive Urban Atlas/Flanders water context for {observation_id}â€¦", flush=True)
    water_context = prepare_analysis_water_context(
        urban_context, soil_path, sectors_path=SECTORS_PATH, force=force,
    )
    print(f"Indexing eligible Landsat centres for {observation_id}…", flush=True)
    samples = _build_sample_index(
        observation_id, soil_year, landsat_path, soil_path, green_path, urban_context, sectors,
    )
    if samples.empty:
        raise ValueError(f"{observation_id}: no eligible image-regression samples were found.")

    root.mkdir(parents=True, exist_ok=True)
    temporary_samples = samples_path.with_suffix(".partial.csv.gz")
    samples.to_csv(temporary_samples, index=False, compression="gzip")
    temporary_samples.replace(samples_path)
    signatures = {
        "landsat": _source_signature(landsat_path),
        "soilSealing": _source_signature(soil_path),
        "greenMap": _source_signature(green_path),
        "sectors": _source_signature(SECTORS_PATH),
        "urbanAtlas": urban_signature,
        "urbanContext": _source_signature(urban_context),
        "landUseWater": _source_signature(DEFAULT_LAND_USE_PATH),
        "waterContext": _source_signature(water_context),
    }
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "observationId": observation_id,
        "target": {"name": "land_surface_temperature", "unit": "°C", "status": "clear"},
        "channels": [
            {"id": "soil_sealing", "year": soil_year, "sourceValue": 1},
            {"id": "high_green", "year": GREEN_YEAR, "sourceValue": 1},
            {"id": "low_green", "year": GREEN_YEAR, "sourceValue": 2},
            {"id": "agriculture", "year": GREEN_YEAR, "sourceValue": 3},
            {
                "id": "water", "years": [URBAN_ATLAS_YEAR, LAND_USE_YEAR],
                "sourceCodes": {"urbanAtlas": WATER_CODE, "landUse": LAND_USE_WATER_CODE},
                "rule": "additive-union-with-land-use-priority",
            },
        ],
        "eligibility": {
            "rule": "all-clear-finite-centres-in-zennevallei",
            "completeGroundDiskRequired": True,
        },
        "spatialInput": {
            "shape": [len(CHANNEL_NAMES), PATCH_SIZE, PATCH_SIZE],
            "crs": "EPSG:31370", "resolutionMeters": PATCH_RESOLUTION_METERS,
            "radiusMeters": PATCH_RADIUS_METERS, "outsideDiskValue": 0,
        },
        "radialInput": {
            "profileShape": [len(CHANNEL_NAMES), RADIAL_BINS],
            "lineTensorShape": [len(CHANNEL_NAMES), RADIAL_IMAGE_HEIGHT, RADIAL_BINS],
            "value": "active fraction of valid pixels in each 1 m annulus",
        },
        "xgboostInput": _xgboost_input_contract(),
        "analysisWater": analysis_water_metadata(water_context),
        "sampleIndex": _relative_path(samples_path),
        "sampleCount": int(len(samples)),
        "sectorCount": int(samples["sector_id"].nunique()),
        "temperatureRangeC": [float(samples["lst_c"].min()), float(samples["lst_c"].max())],
        "sources": signatures,
    }
    _atomic_json(manifest_path, manifest)
    return load_regression_catalog(observation_id)


def load_regression_catalog(observation_id: str = DEFAULT_OBSERVATION_ID) -> RegressionCatalog:
    """Load a prepared catalog and reject stale or incomplete source state."""
    root, manifest_path, samples_path = _catalog_paths(observation_id)
    if not manifest_path.exists() or not samples_path.exists():
        raise FileNotFoundError(f"Prepare the image-regression catalog first: {root}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION or manifest.get("observationId") != observation_id:
        raise ValueError("The image-regression catalog schema or observation is incompatible.")
    if manifest.get("xgboostInput") != _xgboost_input_contract():
        raise ValueError("The image-regression XGBoost predictor contract is incompatible.")
    if [item.get("id") for item in manifest.get("channels", [])] != list(LAND_COVER_CHANNEL_NAMES):
        raise ValueError("The image-regression land-cover channel contract is incompatible.")
    if manifest.get("eligibility", {}).get("rule") != "all-clear-finite-centres-in-zennevallei" \
            or manifest.get("eligibility", {}).get("completeGroundDiskRequired") is not True:
        raise ValueError("The image-regression eligibility contract is incompatible.")
    stale = [name for name, signature in manifest["sources"].items() if not _signature_is_current(signature)]
    if stale:
        raise ValueError(f"The image-regression catalog has stale sources: {stale}")
    samples = pd.read_csv(samples_path, compression="gzip")
    if len(samples) != manifest["sampleCount"] or samples["sample_id"].duplicated().any():
        raise ValueError("The image-regression sample index is incomplete or duplicated.")
    for column in ("sample_id", "site_id", "observation_id", "sector_id", "municipality"):
        samples[column] = samples[column].astype(str)
    sources = manifest["sources"]
    return RegressionCatalog(
        observation_id=observation_id, samples=samples.reset_index(drop=True), manifest=manifest,
        cache_dir=root,
        soil_path=_resolve_path(sources["soilSealing"]["path"]),
        green_path=_resolve_path(sources["greenMap"]["path"]),
        urban_context_path=_resolve_path(sources["urbanContext"]["path"]),
        water_context_path=_resolve_path(sources["waterContext"]["path"]),
    )


class ImageRegressionDataset:
    """Lazy reader for the five production land-cover channels."""

    def __init__(self, catalog: RegressionCatalog, indices=None):
        self.catalog = catalog
        self.indices = np.arange(len(catalog.samples), dtype=np.int64) if indices is None \
            else np.asarray(indices, dtype=np.int64)
        if np.any(self.indices < 0) or np.any(self.indices >= len(catalog.samples)):
            raise IndexError("Dataset subset contains an out-of-range catalog index.")
        self._handles = {}

    def __len__(self):
        return len(self.indices)

    def _sources(self):
        if not self._handles:
            self._handles = {
                "soil": rasterio.open(self.catalog.soil_path),
                "green": rasterio.open(self.catalog.green_path),
                "urban": rasterio.open(self.catalog.urban_context_path),
                "water": rasterio.open(self.catalog.water_context_path),
            }
        return self._handles

    def close(self):
        for source in self._handles.values():
            source.close()
        self._handles = {}

    def __getstate__(self):
        state = self.__dict__.copy()
        state["_handles"] = {}
        return state

    def __del__(self):
        self.close()

    def subset(self, indices):
        positions = np.asarray(indices, dtype=np.int64)
        return ImageRegressionDataset(self.catalog, indices=self.indices[positions])

    def land_cover_patch(self, index: int):
        """Return five mutually exclusive binary channels on the 100 m disk."""
        catalog_index = int(self.indices[index])
        row = self.catalog.samples.iloc[catalog_index]
        sources = self._sources()
        soil, green, urban, water_context = _read_ground_arrays(
            (sources["soil"], sources["green"], sources["urban"], sources["water"]),
            int(row.patch_center_row), int(row.patch_center_col),
        )
        if soil.shape != (PATCH_SIZE, PATCH_SIZE) or not _ground_valid(soil, green, urban)[SUPPORT_MASK].all():
            raise ValueError(f"Sample {row.sample_id} no longer has complete ground coverage.")
        patch = xgboost_land_cover_channels(green, soil, analysis_water_union(water_context))
        patch[:, ~SUPPORT_MASK] = 0.0
        return patch


def make_sector_folds(
        samples: pd.DataFrame, n_splits: int = 5, buffer_m: float = 200,
        seed: int = 42, *, sectors: gpd.GeoDataFrame | None = None):
    """Create deterministic sector folds with a no-overlap spatial embargo.

    Inputs and targets must be normalised, if desired, only after selecting a
    fold and using its ``train_indices``.  The fold assignment never examines
    target values.
    """
    required = {"site_id", "sector_id", "municipality", "x_lambert", "y_lambert"}
    missing = required.difference(samples.columns)
    if missing:
        raise ValueError(f"Samples are missing split columns: {sorted(missing)}")
    if n_splits < 2:
        raise ValueError("At least two spatial folds are required.")
    if buffer_m < 2 * PATCH_RADIUS_METERS:
        raise ValueError("The buffer must be at least 200 m for two 100 m disks not to overlap.")
    frame = samples.reset_index(drop=True).copy()
    site_sectors = frame[["site_id", "sector_id"]].drop_duplicates()
    conflicts = site_sectors.groupby("site_id")["sector_id"].nunique()
    if (conflicts > 1).any():
        raise ValueError("Every repeated spatial site must belong to exactly one sector.")
    sector_counts = frame.groupby("sector_id", sort=True).size()
    if len(sector_counts) < n_splits:
        raise ValueError("There must be at least one sector per fold.")

    rng = np.random.default_rng(seed)
    tie_order = dict(zip(sector_counts.index, rng.permutation(len(sector_counts))))
    ordered = sorted(
        sector_counts.items(), key=lambda item: (-int(item[1]), tie_order[item[0]], str(item[0])),
    )
    assignments = [[] for _ in range(n_splits)]
    loads = np.zeros(n_splits, dtype=np.int64)
    for sector_id, count in ordered:
        fold = min(range(n_splits), key=lambda value: (loads[value], len(assignments[value]), value))
        assignments[fold].append(str(sector_id))
        loads[fold] += int(count)

    sector_frame = gpd.read_file(SECTORS_PATH) if sectors is None else sectors.copy()
    if "sectorId" not in sector_frame.columns:
        if "sector_id" not in sector_frame.columns:
            raise ValueError("Sector geometry needs sectorId or sector_id.")
        sector_frame = sector_frame.rename(columns={"sector_id": "sectorId"})
    sector_frame["sectorId"] = sector_frame["sectorId"].astype(str)
    sector_frame = sector_frame.to_crs("EPSG:31370")
    available = set(sector_frame["sectorId"])
    unknown = set(frame["sector_id"].astype(str)).difference(available)
    if unknown:
        raise ValueError(f"Samples reference sectors without geometry: {sorted(unknown)[:3]}")

    x = frame["x_lambert"].to_numpy(dtype=np.float64)
    y = frame["y_lambert"].to_numpy(dtype=np.float64)
    folds = []
    for fold_index, test_sector_ids in enumerate(assignments):
        test_sector_ids = tuple(sorted(test_sector_ids))
        is_test = frame["sector_id"].astype(str).isin(test_sector_ids).to_numpy()
        test_geometry = sector_frame.loc[
            sector_frame["sectorId"].isin(test_sector_ids), "geometry"
        ].union_all()
        exclusion = test_geometry.buffer(float(buffer_m) + 1e-7)
        inside_buffer = contains_xy(exclusion, x, y)
        excluded = ~is_test & inside_buffer
        is_train = ~is_test & ~excluded
        train_indices = np.flatnonzero(is_train)
        test_indices = np.flatnonzero(is_test)
        excluded_indices = np.flatnonzero(excluded)
        train_sites = set(frame.iloc[train_indices]["site_id"])
        test_sites = set(frame.iloc[test_indices]["site_id"])
        if train_sites.intersection(test_sites):
            raise AssertionError("A spatial site leaked between train and test.")
        if set(frame.iloc[train_indices]["sector_id"]).intersection(test_sector_ids):
            raise AssertionError("A held-out sector leaked into training.")
        if np.any(contains_xy(exclusion, x[train_indices], y[train_indices])):
            raise AssertionError("A training centre violates the spatial embargo.")
        train_sector_ids = tuple(sorted(frame.iloc[train_indices]["sector_id"].astype(str).unique()))
        diagnostics = {
            "trainSampleCount": int(len(train_indices)),
            "testSampleCount": int(len(test_indices)),
            "excludedBufferSampleCount": int(len(excluded_indices)),
            "trainSectorCount": int(frame.iloc[train_indices]["sector_id"].nunique()),
            "testSectorCount": len(test_sector_ids),
            "trainMunicipalities": sorted(frame.iloc[train_indices]["municipality"].astype(str).unique()),
            "testMunicipalities": sorted(frame.iloc[test_indices]["municipality"].astype(str).unique()),
            "bufferMeters": float(buffer_m),
        }
        folds.append(SpatialFold(
            fold=fold_index, train_indices=train_indices, test_indices=test_indices,
            excluded_buffer_indices=excluded_indices, train_sector_ids=train_sector_ids,
            test_sector_ids=test_sector_ids,
            diagnostics=diagnostics,
        ))
    return tuple(folds)
