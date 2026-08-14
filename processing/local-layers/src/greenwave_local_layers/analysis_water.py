"""Shared, non-rendered water context for land-cover temperature modelling.

Urban Atlas remains the visible scenario water layer.  The analytical model
uses its water class plus Landgebruik Vlaanderen 2025 class 17, resampled with
nearest-neighbour assignment onto the native 1 m land-cover grid.  Two bits
retain provenance while ``value != 0`` is the production water union.
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling

from .constants import CACHE_ROOT, SECTORS_PATH
from .sources import file_hash


ANALYSIS_WATER_SCHEMA_VERSION = 1
LAND_USE_YEAR = 2025
LAND_USE_WATER_CODE = 17
URBAN_ATLAS_YEAR = 2021
URBAN_ATLAS_WATER_BIT = np.uint8(1)
LAND_USE_WATER_BIT = np.uint8(2)
URBAN_CONTEXT_WATER_BIT = np.uint8(4)
DEFAULT_LAND_USE_PATH = (
    CACHE_ROOT / "raw" / "landgebruik" / f"landgebruik-{LAND_USE_YEAR}.tif"
)
DEFAULT_ANALYSIS_WATER_PATH = (
    CACHE_ROOT / "image-regression" / "shared"
    / f"analysis-water-urban-atlas-{URBAN_ATLAS_YEAR}-landgebruik-{LAND_USE_YEAR}.tif"
)


def analysis_water_union(values):
    """Return the additive Urban Atlas/Flanders water mask."""
    return np.asarray(values, dtype=np.uint8) != 0


def land_use_water(values):
    """Return only the Flanders Land Use contribution."""
    return (np.asarray(values, dtype=np.uint8) & LAND_USE_WATER_BIT) != 0


def analysis_water_metadata(path: Path = DEFAULT_ANALYSIS_WATER_PATH):
    """Read the versioned source and overlap audit stored on the raster."""
    with rasterio.open(path) as source:
        tags = source.tags()
    return {
        "schemaVersion": int(tags["schema_version"]),
        "urbanAtlasYear": int(tags["urban_atlas_year"]),
        "urbanAtlasWaterCode": tags["urban_atlas_water_code"],
        "landUseYear": int(tags["land_use_year"]),
        "landUseWaterCode": int(tags["land_use_water_code"]),
        "resampling": tags["land_use_resampling"],
        "encoding": tags["encoding"],
        "urbanContextSha256": tags["urban_context_sha256"],
        "landUseSha256": tags["land_use_sha256"],
        "sectorsSha256": tags["sectors_sha256"],
        "audit": json.loads(tags["zennevallei_audit_json"]),
    }


def prepare_analysis_water_context(
        urban_context_path: Path, soil_path: Path, *, land_use_path: Path | None = None,
        sectors_path: Path = SECTORS_PATH, destination: Path | None = None,
        force: bool = False) -> Path:
    """Create the provenance-preserving water union on the aligned 1 m grid."""
    urban_context_path = Path(urban_context_path)
    soil_path = Path(soil_path)
    land_use_path = Path(land_use_path or DEFAULT_LAND_USE_PATH)
    sectors_path = Path(sectors_path)
    destination = Path(destination or DEFAULT_ANALYSIS_WATER_PATH)
    missing = [path for path in (
        urban_context_path, soil_path, land_use_path, sectors_path,
    ) if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing analysis-water inputs: {missing}")

    expected_tags = {
        "schema_version": str(ANALYSIS_WATER_SCHEMA_VERSION),
        "urban_atlas_year": str(URBAN_ATLAS_YEAR),
        "urban_atlas_water_code": "50000",
        "land_use_year": str(LAND_USE_YEAR),
        "land_use_water_code": str(LAND_USE_WATER_CODE),
        "land_use_resampling": "nearest",
        "encoding": "bit0-urban-atlas-water_bit1-landgebruik-water",
        "urban_context_sha256": file_hash(urban_context_path),
        "land_use_sha256": file_hash(land_use_path),
        "sectors_sha256": file_hash(sectors_path),
    }
    if destination.exists() and not force:
        try:
            with rasterio.open(destination) as prepared, rasterio.open(soil_path) as soil:
                same_grid = (
                    prepared.shape == soil.shape and prepared.transform == soil.transform
                    and prepared.crs == soil.crs and prepared.dtypes == ("uint8",)
                )
                if same_grid and all(
                        prepared.tags().get(key) == value for key, value in expected_tags.items()
                ) and prepared.tags().get("zennevallei_audit_json"):
                    return destination
        except (OSError, ValueError, KeyError):
            pass

    sectors = gpd.read_file(sectors_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial.tif")
    temporary.unlink(missing_ok=True)
    counts = {"urbanAtlas": 0, "landUse": 0, "intersection": 0, "union": 0}

    with rasterio.open(soil_path) as soil, rasterio.open(urban_context_path) as urban, \
            rasterio.open(land_use_path) as land_use:
        if urban.shape != soil.shape or urban.transform != soil.transform or urban.crs != soil.crs:
            raise ValueError("Urban Atlas context and Soil sealing must share the 1 m model grid.")
        if str(soil.crs) != "EPSG:31370" or soil.res != (1.0, 1.0):
            raise ValueError("Analysis water requires the native 1 m EPSG:31370 model grid.")
        if str(land_use.crs) != "EPSG:31370" or land_use.res != (10.0, 10.0):
            raise ValueError("Flanders Land Use water must come from its native 10 m EPSG:31370 raster.")

        region = sectors.to_crs(soil.crs).geometry.union_all()
        profile = soil.profile.copy()
        profile.update(
            driver="GTiff", count=1, dtype="uint8", nodata=None, tiled=True,
            blockxsize=512, blockysize=512, compress="ZSTD", zstd_level=3, predictor=2,
        )
        with WarpedVRT(
                land_use, crs=soil.crs, transform=soil.transform,
                width=soil.width, height=soil.height,
                src_nodata=land_use.nodata if land_use.nodata is not None else 0,
                nodata=0, resampling=Resampling.nearest,
        ) as aligned_land_use, rasterio.open(temporary, "w", **profile) as output:
            for _, window in output.block_windows(1):
                ua = (urban.read(1, window=window) & URBAN_CONTEXT_WATER_BIT) != 0
                flanders = aligned_land_use.read(1, window=window) == LAND_USE_WATER_CODE
                encoded = (
                    ua.astype(np.uint8) * URBAN_ATLAS_WATER_BIT
                    | flanders.astype(np.uint8) * LAND_USE_WATER_BIT
                )
                output.write(encoded, 1, window=window)

                inside = rasterize(
                    [(region, 1)], out_shape=(int(window.height), int(window.width)),
                    transform=output.window_transform(window), fill=0, dtype="uint8",
                ).astype(bool)
                ua_inside = ua & inside
                flanders_inside = flanders & inside
                counts["urbanAtlas"] += int(np.count_nonzero(ua_inside))
                counts["landUse"] += int(np.count_nonzero(flanders_inside))
                counts["intersection"] += int(np.count_nonzero(ua_inside & flanders_inside))
                counts["union"] += int(np.count_nonzero((ua | flanders) & inside))

            audit = {
                "unit": "ha",
                "urbanAtlasWaterHa": round(counts["urbanAtlas"] / 10_000, 4),
                "landUseWaterHa": round(counts["landUse"] / 10_000, 4),
                "intersectionHa": round(counts["intersection"] / 10_000, 4),
                "urbanAtlasOnlyHa": round(
                    (counts["urbanAtlas"] - counts["intersection"]) / 10_000, 4,
                ),
                "landUseOnlyHa": round(
                    (counts["landUse"] - counts["intersection"]) / 10_000, 4,
                ),
                "unionHa": round(counts["union"] / 10_000, 4),
            }
            output.update_tags(
                **expected_tags,
                zennevallei_audit_json=json.dumps(audit, sort_keys=True, separators=(",", ":")),
                purpose="non-rendered analytical water priority mask",
            )
    temporary.replace(destination)
    return destination
