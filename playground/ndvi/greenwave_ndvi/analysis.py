"""Pure-Python NDVI calculation and GeoPandas region helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import geopandas as gpd
import numpy as np
import xarray as xr

from .loader import DEFAULT_SECTORS, build_zennevallei_mask
from .source import DEFAULT_RAW_CACHE, RAW_PATTERN, open_raw_observation

MASKED_SCL_CLASSES = (0, 1, 3, 7, 8, 9, 10, 11)


def load_sectors(path: str | Path = DEFAULT_SECTORS) -> gpd.GeoDataFrame:
    """Load the Statbel sectors as a normal GeoPandas table."""

    sectors = gpd.read_file(Path(path))
    required = {"sectorId", "municipality", "geometry"}
    missing = required.difference(sectors.columns)
    if missing:
        raise ValueError(f"Sector data is missing: {', '.join(sorted(missing))}.")
    if Path(path).resolve() == Path(DEFAULT_SECTORS).resolve() and len(sectors) != 154:
        raise ValueError(f"Expected 154 Statbel sectors, found {len(sectors)}.")
    return sectors


def municipality_bounds(
    name: str,
    padding_m: float = 1000,
    *,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> tuple[float, float, float, float]:
    """Return an EPSG:32631 rectangle around one municipality."""

    sectors = load_sectors(sectors_path).to_crs("EPSG:32631")
    selected = sectors[sectors["municipality"].str.casefold() == name.casefold()]
    if selected.empty:
        available = ", ".join(sorted(sectors["municipality"].unique()))
        raise KeyError(f"Unknown municipality '{name}'. Choose one of: {available}.")
    left, bottom, right, top = selected.total_bounds
    return left - padding_m, bottom - padding_m, right + padding_m, top + padding_m


def compute_ndvi(
    dataset: xr.Dataset,
    *,
    mask_to_zennevallei: bool = True,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> xr.DataArray:
    """Calculate NDVI and apply the current Sentinel-2 validity mask."""

    required = {"b04", "b08", "scl", "data_mask"}
    missing = required.difference(dataset.data_vars)
    if missing:
        raise ValueError(f"Raw observation is missing: {', '.join(sorted(missing))}.")
    denominator = dataset.b08 + dataset.b04
    values = (dataset.b08 - dataset.b04) / denominator
    valid = (
        dataset.data_mask.astype(bool)
        & np.isfinite(dataset.b04)
        & np.isfinite(dataset.b08)
        & (denominator != 0)
        & ~dataset.scl.isin(MASKED_SCL_CLASSES)
        & np.isfinite(values)
        & (values >= -1)
        & (values <= 1)
    )
    if mask_to_zennevallei:
        valid &= build_zennevallei_mask(dataset, sectors_path=sectors_path)
    result = values.where(valid).astype("float32").rename("ndvi")
    result.attrs.update({
        "long_name": "Normalized Difference Vegetation Index",
        "formula": "(B08 - B04) / (B08 + B04)",
        "masked_scl_classes": MASKED_SCL_CLASSES,
        "crs": dataset.attrs.get("crs"),
        "transform": dataset.attrs.get("transform"),
        "date": dataset.attrs.get("date"),
        "year": dataset.attrs.get("year"),
    })
    return result


def crop_to_bounds(data: xr.DataArray | xr.Dataset, bounds: tuple[float, float, float, float]):
    """Crop a north-up projected Xarray object to left, bottom, right, top."""

    left, bottom, right, top = bounds
    return data.sel(x=slice(left, right), y=slice(top, bottom))


def open_ndvi_stack(
    years: Iterable[int] | None = None,
    *,
    cache_dir: str | Path = DEFAULT_RAW_CACHE,
    sectors_path: str | Path = DEFAULT_SECTORS,
    chunks: tuple[int, int, int] = (1, 512, 512),
) -> xr.Dataset:
    """Calculate a lazy-compatible annual NDVI stack from raw band caches."""

    if years is None:
        cached_dates = sorted(
            match.group(1)
            for path in Path(cache_dir).glob("sentinel-2-l2a-raw-*-epsg32631-10m.tif")
            if (match := RAW_PATTERN.match(path.name))
        )
        selected_years = [int(date[:4]) for date in cached_dates]
    else:
        selected_years = list(years)
    observations = []
    for year in selected_years:
        raw = open_raw_observation(int(year), cache_dir=cache_dir)
        ndvi = compute_ndvi(raw, sectors_path=sectors_path)
        observations.append(ndvi.expand_dims(time=[np.datetime64(raw.attrs["date"])]))
    if not observations:
        raise ValueError("Choose at least one observation year.")
    stack = xr.concat(observations, dim="time").chunk(dict(zip(("time", "y", "x"), chunks)))
    return xr.Dataset(
        {"ndvi": stack, "valid": np.isfinite(stack)},
        attrs={
            "crs": observations[0].attrs["crs"],
            "transform": observations[0].attrs["transform"],
            "resolution_meters": 10,
        },
    )
