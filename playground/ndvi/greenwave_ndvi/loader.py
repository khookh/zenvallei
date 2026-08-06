"""Load Greenwave's preparation-only Sentinel-2 NDVI GeoTIFFs.

The browser never receives these files. They remain under `.cache/vegetation`
and contain two 10 m bands in EPSG:32631: NDVI and observation validity. This
module masks the rectangular grid to the committed Statbel sector union and
can expose either one eager observation or a lazy time stack.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

import dask.array as da
import numpy as np
import pandas as pd
import rasterio
import xarray as xr
from affine import Affine
from dask import delayed
from rasterio.features import geometry_mask
from rasterio.warp import transform_geom

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CACHE = PROJECT_ROOT / ".cache" / "vegetation"
DEFAULT_SELECTION = DEFAULT_CACHE / "selection.json"
DEFAULT_SECTORS = PROJECT_ROOT / "public" / "data" / "sectors.geojson"
FILENAME = re.compile(r"sentinel-2-l2a-ndvi-validity-(\d{4}-\d{2}-\d{2})-epsg32631-10m\.tif$")


def _read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def _selected_dates(selection_path: Path) -> dict[int, str]:
    if not selection_path.exists():
        return {}
    selection = _read_json(selection_path)
    return {
        int(year): entry.get("selectedDate") or entry.get("selected", {}).get("date")
        for year, entry in selection.get("years", {}).items()
    }


def discover_observations(
    selected_only: bool = True,
    *,
    cache_dir: str | Path = DEFAULT_CACHE,
    selection_path: str | Path | None = None,
) -> pd.DataFrame:
    """Return a date-sorted inventory of cached NDVI observations.

    By default, only the deterministic annual choices in `selection.json` are
    returned. Set `selected_only=False` to include alternative downloaded dates.
    """

    cache = Path(cache_dir)
    selection = Path(selection_path) if selection_path else cache / "selection.json"
    if not cache.exists():
        raise FileNotFoundError(
            f"NDVI cache not found at {cache}. Run 'pnpm vegetation:download -- --all' first."
        )
    selected_dates = _selected_dates(selection)
    records: list[dict] = []
    for path in sorted(cache.glob("sentinel-2-l2a-ndvi-validity-*-epsg32631-10m.tif")):
        match = FILENAME.match(path.name)
        if not match:
            continue
        date = match.group(1)
        year = int(date[:4])
        selected = selected_dates.get(year) == date
        if selected_only and not selected:
            continue
        sidecar_path = Path(f"{path}.json")
        sidecar = _read_json(sidecar_path) if sidecar_path.exists() else {}
        quality = sidecar.get("cloudQuality", {})
        records.append({
            "year": year,
            "date": pd.Timestamp(date),
            "selected": selected,
            "path": path,
            "sidecar_path": sidecar_path if sidecar_path.exists() else None,
            "cloud_affected_percentage": quality.get("cloudAffectedPercentage"),
            "coverage_percentage": quality.get("coveragePercentage"),
            "products": tuple(product.get("id") for product in sidecar.get("products", [])),
        })
    if not records:
        scope = "selected " if selected_only else ""
        raise FileNotFoundError(f"No {scope}NDVI GeoTIFFs were found in {cache}.")
    return pd.DataFrame.from_records(records).sort_values(["date", "path"]).reset_index(drop=True)


def _resolve_observation(
    year_or_path: int | str | Path,
    cache_dir: Path,
    selection_path: Path,
) -> tuple[Path, dict]:
    if isinstance(year_or_path, int) or str(year_or_path).isdigit():
        year = int(year_or_path)
        inventory = discover_observations(True, cache_dir=cache_dir, selection_path=selection_path)
        matches = inventory[inventory["year"] == year]
        if len(matches) != 1:
            raise KeyError(f"Expected one selected NDVI observation for {year}; found {len(matches)}.")
        path = Path(matches.iloc[0]["path"])
    else:
        path = Path(year_or_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    sidecar_path = Path(f"{path}.json")
    return path, _read_json(sidecar_path) if sidecar_path.exists() else {}


def _validate_raster(source: rasterio.io.DatasetReader) -> None:
    if source.crs is None or source.crs.to_epsg() != 32631:
        raise ValueError(f"Expected EPSG:32631, found {source.crs}.")
    if source.count != 2:
        raise ValueError(f"Expected NDVI and validity bands, found {source.count} bands.")
    if not np.isclose(abs(source.transform.a), 10) or not np.isclose(abs(source.transform.e), 10):
        raise ValueError("Expected a 10 m raster grid.")


def _sector_geometries(sectors_path: Path, target_crs: str) -> list[dict]:
    geojson = _read_json(sectors_path)
    features = geojson.get("features", [])
    if len(features) != 154 and sectors_path == DEFAULT_SECTORS:
        raise ValueError(f"Expected 154 Statbel sectors, found {len(features)}.")
    return [transform_geom("EPSG:4326", target_crs, feature["geometry"], precision=3) for feature in features]


def _mask_for_grid(height: int, width: int, transform: Affine, crs: str, sectors_path: Path) -> np.ndarray:
    return geometry_mask(
        _sector_geometries(sectors_path, crs),
        out_shape=(height, width),
        transform=transform,
        invert=True,
        all_touched=False,
    )


def build_zennevallei_mask(
    dataset: xr.Dataset,
    *,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> xr.DataArray:
    """Build a boolean sector-union mask aligned to an opened dataset."""

    transform = Affine(*dataset.attrs["transform"])
    mask = _mask_for_grid(
        dataset.sizes["y"], dataset.sizes["x"], transform, dataset.attrs["crs"], Path(sectors_path)
    )
    return xr.DataArray(mask, dims=("y", "x"), coords={"y": dataset.y, "x": dataset.x}, name="inside_zennevallei")


def _coordinates(source: rasterio.io.DatasetReader) -> tuple[np.ndarray, np.ndarray]:
    x = source.transform.c + (np.arange(source.width) + 0.5) * source.transform.a
    y = source.transform.f + (np.arange(source.height) + 0.5) * source.transform.e
    return x, y


def open_observation(
    year_or_path: int | str | Path,
    *,
    cache_dir: str | Path = DEFAULT_CACHE,
    selection_path: str | Path | None = None,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> xr.Dataset:
    """Eagerly open and mask one annual or explicitly named observation."""

    cache = Path(cache_dir)
    selection = Path(selection_path) if selection_path else cache / "selection.json"
    path, sidecar = _resolve_observation(year_or_path, cache, selection)
    with rasterio.open(path) as source:
        _validate_raster(source)
        ndvi = source.read(1).astype("float32")
        valid = source.read(2) >= 0.5
        inside = _mask_for_grid(source.height, source.width, source.transform, str(source.crs), Path(sectors_path))
        valid &= inside
        ndvi[~valid] = np.nan
        x, y = _coordinates(source)
        date = sidecar.get("date") or FILENAME.match(path.name).group(1)
        attributes = {
            "crs": str(source.crs),
            "transform": tuple(source.transform)[:6],
            "resolution_meters": 10,
            "source_path": str(path),
            "date": date,
            "year": int(sidecar.get("year") or date[:4]),
        }
    return xr.Dataset(
        data_vars={
            "ndvi": (("y", "x"), ndvi),
            "valid": (("y", "x"), valid),
            "inside_zennevallei": (("y", "x"), inside),
        },
        coords={"x": x, "y": y},
        attrs=attributes,
    )


def _grid_metadata(path: Path) -> dict:
    with rasterio.open(path) as source:
        _validate_raster(source)
        x, y = _coordinates(source)
        return {
            "height": source.height,
            "width": source.width,
            "transform": source.transform,
            "crs": str(source.crs),
            "x": x,
            "y": y,
        }


def _read_for_stack(path: str, inside: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    with rasterio.open(path) as source:
        ndvi = source.read(1).astype("float32")
        valid = (source.read(2) >= 0.5) & inside
    ndvi[~valid] = np.nan
    return ndvi, valid


def open_stack(
    years: Iterable[int] | None = None,
    selected_only: bool = True,
    chunks: tuple[int, int, int] = (1, 512, 512),
    *,
    cache_dir: str | Path = DEFAULT_CACHE,
    selection_path: str | Path | None = None,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> xr.Dataset:
    """Return a lazy time, y, x stack for annual or alternative observations."""

    cache = Path(cache_dir)
    selection = Path(selection_path) if selection_path else cache / "selection.json"
    inventory = discover_observations(selected_only, cache_dir=cache, selection_path=selection)
    if years is not None:
        wanted = {int(year) for year in years}
        inventory = inventory[inventory["year"].isin(wanted)]
    if inventory.empty:
        raise ValueError("The requested year selection contains no cached observations.")

    first_path = Path(inventory.iloc[0]["path"])
    grid = _grid_metadata(first_path)
    inside = _mask_for_grid(grid["height"], grid["width"], grid["transform"], grid["crs"], Path(sectors_path))
    ndvi_arrays = []
    valid_arrays = []
    for path in inventory["path"]:
        metadata = _grid_metadata(Path(path))
        if any(metadata[key] != grid[key] for key in ("height", "width", "transform", "crs")):
            raise ValueError(f"Observation grid does not align with {first_path.name}: {Path(path).name}.")
        pair = delayed(_read_for_stack)(str(path), inside)
        ndvi_arrays.append(da.from_delayed(pair[0], shape=(grid["height"], grid["width"]), dtype="float32"))
        valid_arrays.append(da.from_delayed(pair[1], shape=(grid["height"], grid["width"]), dtype="bool"))

    ndvi = da.stack(ndvi_arrays).rechunk(chunks)
    valid = da.stack(valid_arrays).rechunk(chunks)
    return xr.Dataset(
        data_vars={
            "ndvi": (("time", "y", "x"), ndvi),
            "valid": (("time", "y", "x"), valid),
            "inside_zennevallei": (("y", "x"), inside),
        },
        coords={
            "time": inventory["date"].to_numpy(dtype="datetime64[ns]"),
            "year": ("time", inventory["year"].to_numpy()),
            "x": grid["x"],
            "y": grid["y"],
        },
        attrs={
            "crs": grid["crs"],
            "transform": tuple(grid["transform"])[:6],
            "resolution_meters": 10,
            "selected_only": selected_only,
        },
    )
