"""Export notebook rasters to the local MapLibre Test-layer contract."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import matplotlib
import numpy as np
import xarray as xr
from affine import Affine
from matplotlib import colors
from PIL import Image
from rasterio.features import geometry_mask
from rasterio.transform import array_bounds
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds, transform_geom

from .analysis import load_sectors
from .loader import DEFAULT_SECTORS
from .source import PROJECT_ROOT

DEFAULT_WEB_EXPORT = PROJECT_ROOT / ".cache" / "playground" / "web"


def _translated(value: str | dict[str, str], fallback: str) -> dict[str, str]:
    if isinstance(value, str):
        return {"en": value, "nl": value}
    return {"en": value.get("en", fallback), "nl": value.get("nl", value.get("en", fallback))}


def _transform(data: xr.DataArray) -> Affine:
    if data.sizes.get("x", 0) < 2 or data.sizes.get("y", 0) < 2:
        raise ValueError("The exported raster needs at least two rows and columns.")
    dx = float(np.median(np.diff(data.x.values)))
    dy = float(np.median(np.diff(data.y.values)))
    if dx <= 0 or dy >= 0:
        raise ValueError("Expected increasing x and decreasing y coordinates.")
    return Affine(dx, 0, float(data.x.values[0]) - dx / 2, 0, dy, float(data.y.values[0]) - dy / 2)


def _crs(data: xr.DataArray) -> str:
    value = data.attrs.get("crs")
    if not value:
        raise ValueError("Set data.attrs['crs'] before exporting.")
    return str(value)


def _reproject(values: np.ndarray, transform: Affine, source_crs: str, categorical: bool):
    height, width = values.shape
    left, bottom, right, top = array_bounds(height, width, transform)
    destination_transform, destination_width, destination_height = calculate_default_transform(
        source_crs, "EPSG:3857", width, height, left, bottom, right, top
    )
    destination = np.full((destination_height, destination_width), np.nan, dtype="float32")
    reproject(
        source=values.astype("float32"),
        destination=destination,
        src_transform=transform,
        src_crs=source_crs,
        src_nodata=np.nan,
        dst_transform=destination_transform,
        dst_crs="EPSG:3857",
        dst_nodata=np.nan,
        resampling=Resampling.nearest if categorical else Resampling.bilinear,
    )
    west, south, east, north = transform_bounds(
        "EPSG:3857", "EPSG:4326", *array_bounds(destination_height, destination_width, destination_transform)
    )
    coordinates = [[west, north], [east, north], [east, south], [west, south]]
    return destination, coordinates


def _rgba_continuous(values: np.ndarray, cmap: str, vmin: float, vmax: float) -> np.ndarray:
    normalizer = colors.Normalize(vmin=vmin, vmax=vmax, clip=True)
    rgba = np.asarray(matplotlib.colormaps[cmap](normalizer(np.nan_to_num(values, nan=vmin))) * 255, dtype="uint8")
    rgba[..., 3] = np.where(np.isfinite(values), 255, 0).astype("uint8")
    return rgba


def _rgba_categorical(values: np.ndarray, classes: list[dict[str, Any]]) -> np.ndarray:
    rgba = np.zeros((*values.shape, 4), dtype="uint8")
    for definition in classes:
        red, green, blue, alpha = colors.to_rgba(definition["color"], alpha=1)
        rgba[values == float(definition["value"])] = np.asarray([red, green, blue, alpha]) * 255
    return rgba


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")


def _masked_values(data: xr.DataArray, geometries: Iterable[dict]) -> np.ndarray:
    transform = _transform(data)
    mask = geometry_mask(
        list(geometries), out_shape=data.shape, transform=transform, invert=True, all_touched=False
    )
    return np.where(mask, data.values, np.nan)


def _sector_statistics(data: xr.DataArray, sectors, kind: str, classes: list[dict[str, Any]] | None):
    source_crs = _crs(data)
    transform = _transform(data)
    pixel_area_ha = abs(transform.a * transform.e) / 10_000
    projected = sectors.to_crs(source_crs)
    statistics = {}
    for row in projected.itertuples():
        geometry = transform_geom(source_crs, source_crs, row.geometry.__geo_interface__)
        selected = _masked_values(data, [geometry])
        finite = selected[np.isfinite(selected)]
        record: dict[str, Any] = {
            "validAreaHa": round(float(finite.size * pixel_area_ha), 2),
            "sectorAreaHa": round(float(row.geometry.area / 10_000), 2),
        }
        if finite.size and kind == "continuous":
            record.update({
                "minimum": round(float(np.min(finite)), 4),
                "maximum": round(float(np.max(finite)), 4),
                "mean": round(float(np.mean(finite)), 4),
                "median": round(float(np.median(finite)), 4),
            })
        elif kind == "categorical":
            record["classes"] = [{
                "value": definition["value"],
                "areaHa": round(float(np.sum(finite == float(definition["value"])) * pixel_area_ha), 2),
                "percentage": round(float(np.mean(finite == float(definition["value"])) * 100), 2) if finite.size else 0,
            } for definition in classes or []]
        statistics[str(row.sectorId)] = record
    return statistics


def _municipality_statistics(data: xr.DataArray, sectors, kind: str, classes: list[dict[str, Any]] | None):
    source_crs = _crs(data)
    transform = _transform(data)
    pixel_area_ha = abs(transform.a * transform.e) / 10_000
    projected = sectors.to_crs(source_crs)
    statistics = {}
    for municipality in sorted(projected["municipality"].unique()):
        selected = projected[projected["municipality"] == municipality]
        geometry = selected.geometry.union_all().__geo_interface__
        values = _masked_values(data, [geometry])
        finite = values[np.isfinite(values)]
        record: dict[str, Any] = {
            "validAreaHa": round(float(finite.size * pixel_area_ha), 2),
            "sectorAreaHa": round(float(selected.geometry.area.sum() / 10_000), 2),
        }
        if finite.size and kind == "continuous":
            record.update({
                "minimum": round(float(np.min(finite)), 4),
                "maximum": round(float(np.max(finite)), 4),
                "mean": round(float(np.mean(finite)), 4),
                "median": round(float(np.median(finite)), 4),
            })
        elif kind == "categorical":
            record["classes"] = [{
                "value": definition["value"],
                "areaHa": round(float(np.sum(finite == float(definition["value"])) * pixel_area_ha), 2),
                "percentage": round(float(np.mean(finite == float(definition["value"])) * 100), 2) if finite.size else 0,
            } for definition in classes or []]
        statistics[municipality] = record
    return statistics


def _write_export(
    data: xr.DataArray,
    *,
    kind: str,
    title: str | dict[str, str],
    description: str | dict[str, str],
    legend: dict[str, Any],
    rgba_factory,
    classes: list[dict[str, Any]] | None = None,
    units: str = "",
    output_dir: str | Path = DEFAULT_WEB_EXPORT,
    sectors_path: str | Path = DEFAULT_SECTORS,
    opacity: float = 0.68,
) -> Path:
    if data.ndim != 2 or data.dims != ("y", "x"):
        raise ValueError("Export a two-dimensional DataArray with y and x dimensions.")
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    transform = _transform(data)
    source_crs = _crs(data)
    sectors = load_sectors(sectors_path)
    source_geometries = [
        transform_geom(str(sectors.crs), source_crs, geometry.__geo_interface__)
        for geometry in sectors.geometry
    ]
    clipped = _masked_values(data, source_geometries)
    projected, coordinates = _reproject(clipped, transform, source_crs, kind == "categorical")
    Image.fromarray(rgba_factory(projected), "RGBA").save(target / "test.png", optimize=True)
    raster_variants = {"all": "test.png"}
    for municipality in sorted(sectors["municipality"].unique()):
        selected = sectors[sectors["municipality"] == municipality]
        geometries = [
            transform_geom(str(selected.crs), source_crs, geometry.__geo_interface__)
            for geometry in selected.geometry
        ]
        variant_values = _masked_values(data, geometries)
        variant, _ = _reproject(variant_values, transform, source_crs, kind == "categorical")
        filename = f"test-{_slug(municipality)}.png"
        Image.fromarray(rgba_factory(variant), "RGBA").save(target / filename, optimize=True)
        raster_variants[municipality] = filename
    manifest = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "kind": kind,
        "title": _translated(title, "Notebook test"),
        "description": _translated(description, "Experimental notebook output."),
        "units": units,
        "opacity": opacity,
        "imageUrl": "test.png",
        "rasterVariants": raster_variants,
        "coordinates": coordinates,
        "legend": legend,
        "sectorStats": _sector_statistics(data, sectors, kind, classes),
        "municipalityStats": _municipality_statistics(data, sectors, kind, classes),
        "source": {
            "type": "local-notebook-export",
            "date": data.attrs.get("date"),
            "crs": source_crs,
            "resolutionMeters": abs(transform.a),
        },
    }
    manifest_path = target / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest_path


def export_continuous_layer(
    data: xr.DataArray,
    *,
    title: str | dict[str, str] = "Notebook test",
    description: str | dict[str, str] = "Continuous notebook output.",
    cmap: str = "RdYlGn",
    vmin: float = -0.2,
    vmax: float = 0.9,
    units: str = "",
    output_dir: str | Path = DEFAULT_WEB_EXPORT,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> Path:
    """Export a continuous DataArray and a generated five-step legend."""

    values = np.linspace(vmin, vmax, 5)
    palette = matplotlib.colormaps[cmap](colors.Normalize(vmin=vmin, vmax=vmax)(values))
    legend = {
        "items": [
            {"label": f"{value:.2f}", "color": colors.to_hex(color)}
            for value, color in zip(values, palette)
        ],
        "minimum": vmin,
        "maximum": vmax,
    }
    return _write_export(
        data,
        kind="continuous",
        title=title,
        description=description,
        units=units,
        legend=legend,
        rgba_factory=lambda values_: _rgba_continuous(values_, cmap, vmin, vmax),
        output_dir=output_dir,
        sectors_path=sectors_path,
    )


def export_categorical_layer(
    data: xr.DataArray,
    classes: list[dict[str, Any]],
    *,
    title: str | dict[str, str] = "Notebook test",
    description: str | dict[str, str] = "Categorical notebook output.",
    output_dir: str | Path = DEFAULT_WEB_EXPORT,
    sectors_path: str | Path = DEFAULT_SECTORS,
) -> Path:
    """Export numeric classes using labels and CSS colours supplied in Python."""

    if not classes or any(not {"value", "label", "color"}.issubset(item) for item in classes):
        raise ValueError("Each class requires value, label and color.")
    legend = {"items": [
        {"value": item["value"], "label": item["label"], "color": item["color"]}
        for item in classes
    ]}
    return _write_export(
        data,
        kind="categorical",
        title=title,
        description=description,
        units="",
        legend=legend,
        rgba_factory=lambda values_: _rgba_categorical(values_, classes),
        classes=classes,
        output_dir=output_dir,
        sectors_path=sectors_path,
    )
