"""End-to-end raster preparation.

Statistics are calculated on the native projected raster. A separate RGBA
GeoTIFF is created only as an intermediate visual derivative for PMTiles.

The TCD-specific branches in this module are deprecated and unreachable from
the active CLI/catalogue. They remain temporarily for old-cache reproducibility.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from pmtiles.reader import MmapSource, Reader
from pyproj import CRS
from shapely import from_wkt
from rasterio.features import geometry_mask, geometry_window
from rasterio.mask import mask
from rasterio.transform import from_origin

from .constants import (
    ANB_WCS, ANB_WMS, CACHE_ROOT, GROENKAART_CLASSES, GROENKAART_YEARS,
    JAARBAK_CLASSES, JAARBAK_DOWNLOADS, JAARBAK_LAYERS, JAARBAK_YEARS,
    MERCATOR_WCS, MUNICIPALITIES, SECTORS_PATH, TCD_CATALOGUE, TCD_STYLE,
    TCD_YEARS,
)
from .sources import (
    download_file, download_tcd_product, file_hash, locate_geotiff,
    parse_tcd_palette, read_tcd_catalogue, request_wcs_tiff,
)
from .statistics import categorical_statistics, jaarbak_statistics, tcd_statistics


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def load_areas():
    sectors = gpd.read_file(SECTORS_PATH)
    if len(sectors) != 154 or sectors["sectorId"].nunique() != 154:
        raise ValueError("Expected exactly 154 unique Statbel sectors.")
    municipalities = sectors.dissolve(by="municipality", as_index=False)
    if set(municipalities["municipality"]) != set(MUNICIPALITIES):
        raise ValueError("The Statbel geometry does not contain the seven expected municipalities.")
    return sectors, municipalities


def _wcs_subset(url: str, coverage: str, bbox, destination: Path, resolution: float = 1.0, nodata: int = 0):
    """Download a large WCS subset as resumable tiles and write it atomically."""
    minx, miny, maxx, maxy = bbox
    width = math.ceil((maxx - minx) / resolution)
    height = math.ceil((maxy - miny) / resolution)
    transform = from_origin(minx, maxy, resolution, resolution)
    destination.parent.mkdir(parents=True, exist_ok=True)
    parts = destination.parent / f".{destination.stem}-parts"
    parts.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial.tif")
    chunk = 4096
    tiles = [
        (row, column, min(chunk, height - row), min(chunk, width - column))
        for row in range(0, height, chunk)
        for column in range(0, width, chunk)
    ]
    for index, (row, column, tile_height, tile_width) in enumerate(tiles, start=1):
        part = parts / f"r{row}-c{column}.tif"
        if not part.exists():
            tile_maxy = maxy - row * resolution
            tile_miny = tile_maxy - tile_height * resolution
            tile_minx = minx + column * resolution
            tile_maxx = tile_minx + tile_width * resolution
            print(f"  {coverage}: downloading tile {index}/{len(tiles)}", flush=True)
            payload = request_wcs_tiff(
                url, coverage, (tile_minx, tile_miny, tile_maxx, tile_maxy), tile_width, tile_height
            )
            partial_part = part.with_suffix(".partial.tif")
            partial_part.write_bytes(payload)
            with rasterio.open(partial_part) as source:
                if source.width != tile_width or source.height != tile_height:
                    raise ValueError(f"{coverage}: WCS tile {index} has an unexpected grid size.")
            partial_part.replace(part)
        else:
            print(f"  {coverage}: reusing tile {index}/{len(tiles)}", flush=True)
    print(f"  {coverage}: assembling {destination.name}", flush=True)
    with rasterio.open(temporary, "w", driver="GTiff", width=width, height=height, count=1,
                       dtype="uint8", crs="EPSG:31370", transform=transform, nodata=nodata,
                       tiled=True, blockxsize=512, blockysize=512, compress="DEFLATE") as output:
        for row, column, tile_height, tile_width in tiles:
            with rasterio.open(parts / f"r{row}-c{column}.tif") as source:
                data = source.read(
                    1, out_shape=(tile_height, tile_width), resampling=rasterio.enums.Resampling.nearest,
                    masked=True,
                ).filled(nodata)
            output.write(data, 1, window=rasterio.windows.Window(column, row, tile_width, tile_height))
    temporary.replace(destination)
    for part in parts.iterdir():
        part.unlink()
    parts.rmdir()
    return destination


def _crs_is_equivalent(actual, expected: str) -> bool:
    """Compare projection math while tolerating equivalent axis metadata."""
    actual_crs = CRS.from_user_input(actual)
    expected_crs = CRS.from_user_input(expected)
    if actual_crs.equals(expected_crs, ignore_axis_order=True):
        return True
    # CLMS labels EPSG:3035 as IGNF:ETRS89LAEA. The projection parameters are
    # identical, but the axis metadata uses conventional easting/northing order.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        return actual_crs.to_dict() == expected_crs.to_dict()


def _validate_raster(
    path: Path, crs: str, resolution: float, valid_values, validation_bounds=None, classified_values=None
):
    with rasterio.open(path) as dataset:
        if not _crs_is_equivalent(dataset.crs, crs):
            raise ValueError(f"{path.name}: expected {crs}, received {dataset.crs}.")
        if not all(abs(abs(value) - resolution) < 1e-6 for value in (dataset.transform.a, dataset.transform.e)):
            raise ValueError(f"{path.name}: expected {resolution} m pixels.")
        observed = set()
        area = rasterio.windows.Window(0, 0, dataset.width, dataset.height)
        if validation_bounds is not None:
            area = rasterio.windows.from_bounds(*validation_bounds, transform=dataset.transform).round_offsets().round_lengths().intersection(area)
        for row in range(int(area.row_off), int(area.row_off + area.height), 4096):
            height = min(4096, int(area.row_off + area.height) - row)
            for column in range(int(area.col_off), int(area.col_off + area.width), 4096):
                width = min(4096, int(area.col_off + area.width) - column)
                window = rasterio.windows.Window(column, row, width, height)
                observed.update(np.unique(dataset.read(1, window=window)).tolist())
                if len(observed) > len(valid_values):
                    break
        if not observed.issubset(set(valid_values)):
            raise ValueError(f"{path.name}: invalid values {sorted(observed - set(valid_values))}.")
        if classified_values is not None and not observed.intersection(set(classified_values)):
            raise ValueError(f"{path.name}: contains no classified pixels inside Zennevallei.")


def _source_for(dataset_id: str, year: int, sources: dict[int, Path], bbox_31370, catalogue=None) -> tuple[Path, dict]:
    if year in sources:
        path = sources[year].resolve()
        if dataset_id == "tcd":
            row = catalogue[year]
            if path.stat().st_size != int(row["content_length"]) or file_hash(path, "md5") != row["checksum_value"].lower():
                raise ValueError(f"Manual TCD source for {year} does not match the official catalogue size and MD5.")
            raster = locate_geotiff(path, CACHE_ROOT / "raw" / "tcd" / f"{row['id']}-manual")
            return raster, {"retrieval": "manual", "productId": row["id"], "productName": row["name"],
                            "size": int(row["content_length"]), "md5": row["checksum_value"],
                            "sourceSha256": file_hash(path), "rasterSha256": file_hash(raster)}
        return path, {"retrieval": "manual", "sourceSha256": file_hash(path), "sourceBytes": path.stat().st_size}
    raw = CACHE_ROOT / "raw" / dataset_id
    raw.mkdir(parents=True, exist_ok=True)
    if dataset_id == "jaarbak":
        layer = JAARBAK_LAYERS[year]
        destination = raw / f"jaarbak-{year}.tif"
        if not destination.exists():
            if year <= 2021:
                _wcs_subset(MERCATOR_WCS, layer, bbox_31370, destination, nodata=255)
            else:
                download_file(JAARBAK_DOWNLOADS[year], destination)
        return destination, {"retrieval": "WCS" if year <= 2021 else "GeoTIFF", "layerId": layer, "sourceSha256": file_hash(destination), "sourceBytes": destination.stat().st_size}
    if dataset_id == "groenkaart":
        coverage = f"Grnkrt{str(year)[-2:]}"
        destination = raw / f"groenkaart-{year}.tif"
        if not destination.exists():
            _wcs_subset(ANB_WCS, coverage, bbox_31370, destination)
        return destination, {"retrieval": "WCS", "coverageId": coverage, "sourceSha256": file_hash(destination), "sourceBytes": destination.stat().st_size}
    row = catalogue[year]
    product = raw / f"{row['name']}.bin"
    download_tcd_product(row, product)
    path = locate_geotiff(product, raw / f"{row['id']}-extracted")
    return path, {
        "retrieval": "CDSE OData", "productId": row["id"], "productName": row["name"],
        "size": int(row["content_length"]), "md5": row["checksum_value"], "bbox": row["bbox"],
        "sourceSha256": file_hash(path),
    }


def _area_stats(source_path: Path, areas: gpd.GeoDataFrame, dataset_id: str, key_field: str):
    """Calculate native-grid statistics keyed by the requested area identifier.

    Municipality geometries are dissolved from sectors and consequently retain
    an arbitrary sectorId column. Requiring the caller to name the key prevents
    that implementation detail from leaking into the browser manifest.
    """
    result = {}
    with rasterio.open(source_path) as source:
        projected = areas.to_crs(source.crs)
        equal_area = areas.to_crs("EPSG:3035")
        pixel_area = abs(source.transform.a * source.transform.e) / 10000.0
        for (_, feature), (_, area_feature) in zip(projected.iterrows(), equal_area.iterrows()):
            complete_area = area_feature.geometry.area / 10000.0
            if dataset_id == "tcd":
                window = geometry_window(source, [feature.geometry], pad_x=1, pad_y=1)
                values = source.read(1, window=window)
                source_valid = source.read_masks(1, window=window) > 0
                factor = 10
                high_shape = (values.shape[0] * factor, values.shape[1] * factor)
                high_transform = source.window_transform(window) * rasterio.Affine.scale(1 / factor)
                high_inside = geometry_mask(
                    [feature.geometry], out_shape=high_shape, transform=high_transform, invert=True
                )
                fractions = high_inside.reshape(
                    values.shape[0], factor, values.shape[1], factor
                ).mean(axis=(1, 3))
                weighted_values = np.ma.array(values, mask=~source_valid)
                stats = tcd_statistics(
                    weighted_values, pixel_area, complete_area, fractions * pixel_area
                )
                key = feature[key_field]
                result[str(key)] = stats
                continue
            try:
                values, _ = mask(source, [feature.geometry], crop=True, filled=False, indexes=1)
            except ValueError:
                values = np.ma.masked_all((1, 1), dtype=np.uint8)
            if dataset_id == "jaarbak":
                stats = jaarbak_statistics(values, pixel_area, complete_area)
            elif dataset_id == "groenkaart":
                stats = categorical_statistics(values, (1, 2, 3, 4), pixel_area, complete_area, 0)
            elif dataset_id == "landgebruik":
                stats = categorical_statistics(values, tuple(range(1, 20)), pixel_area, complete_area, 0)
            key = feature[key_field]
            result[str(key)] = stats
    return result


def _hex_rgb(value: str):
    value = value.lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def _rgba_derivative(source_path: Path, destination: Path, cutline, dataset_id: str, palette):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(source_path) as source:
        geometry = gpd.GeoSeries([cutline], crs="EPSG:4326").to_crs(source.crs).iloc[0]
        geometry_window = rasterio.windows.from_bounds(*geometry.bounds, transform=source.transform)
        geometry_window = geometry_window.round_offsets().round_lengths().intersection(
            rasterio.windows.Window(0, 0, source.width, source.height)
        )
        profile = source.profile.copy()
        profile.update(width=int(geometry_window.width), height=int(geometry_window.height),
                       transform=source.window_transform(geometry_window), count=4, dtype="uint8",
                       nodata=None, photometric="RGB", tiled=True,
                       blockxsize=512, blockysize=512, compress="DEFLATE")
        with rasterio.open(destination, "w", **profile) as output:
            for _, output_window in output.block_windows(1):
                source_window = rasterio.windows.Window(
                    geometry_window.col_off + output_window.col_off,
                    geometry_window.row_off + output_window.row_off,
                    output_window.width,
                    output_window.height,
                )
                values = source.read(1, window=source_window)
                source_valid = source.read_masks(1, window=source_window) > 0
                inside = geometry_mask([geometry], out_shape=(int(output_window.height), int(output_window.width)),
                                       transform=source.window_transform(source_window), invert=True)
                rgba = np.zeros((4, int(output_window.height), int(output_window.width)), dtype=np.uint8)
                if dataset_id == "jaarbak":
                    valid = inside & source_valid & np.isin(values, (0, 1))
                    colors = {item["value"]: _hex_rgb(item["color"]) for item in JAARBAK_CLASSES}
                elif dataset_id == "groenkaart":
                    valid = inside & source_valid & np.isin(values, (1, 2, 3, 4))
                    colors = {item["value"]: _hex_rgb(item["color"]) for item in GROENKAART_CLASSES}
                elif dataset_id == "landgebruik":
                    valid = inside & source_valid & np.isin(values, tuple(range(1, 20)))
                    colors = {int(value): _hex_rgb(color) for value, color in palette.items()}
                else:
                    valid = inside & source_valid & (values <= 100) & (values != 255)
                    colors = {value: _hex_rgb(color) for value, color in enumerate(palette)}
                for value, color in colors.items():
                    selected = valid & (values == value)
                    for band, component in enumerate(color):
                        rgba[band][selected] = component
                rgba[3][valid] = 255
                output.write(rgba, window=output_window)
    return destination


def _write_cutline(path: Path, geometry):
    gpd.GeoDataFrame({"id": [1]}, geometry=[geometry], crs="EPSG:4326").to_file(path, driver="GeoJSON")


def _pmtiles(source: Path, destination: Path, cutline: Path, zooms: str):
    destination.parent.mkdir(parents=True, exist_ok=True)
    rio = Path(sys.executable).with_name("rio.exe" if os.name == "nt" else "rio")
    if not rio.exists():
        raise RuntimeError("The rio command is missing from the local-layers Python environment.")
    temporary = destination.with_suffix(".partial.pmtiles")
    temporary.unlink(missing_ok=True)
    command = [
        str(rio), "pmtiles", str(source), str(temporary), "--format", "PNG", "--rgba",
        "--tile-size", "256", "--zoom-levels", zooms, "--resampling", "nearest",
        "--exclude-empty-tiles", "--cutline", str(cutline), "-j", "2", "--silent",
    ]
    completed = subprocess.run(command, check=False, text=True, capture_output=True)
    if completed.returncode:
        raise RuntimeError(f"rio pmtiles failed: {completed.stderr.strip()}")
    temporary.replace(destination)


def _validate_pmtiles(path: Path, minimum_zoom: int, maximum_zoom: int):
    with path.open("rb") as stream:
        reader = Reader(MmapSource(stream))
        header = reader.header()
        metadata = reader.metadata()
    if header["version"] != 3 or header["tile_type"].name != "PNG":
        raise ValueError(f"{path.name}: expected PMTiles v3 with PNG tiles.")
    if header["min_zoom"] != minimum_zoom or header["max_zoom"] != maximum_zoom:
        raise ValueError(f"{path.name}: unexpected zoom range.")
    if metadata.get("tileSize") != 256 or header["addressed_tiles_count"] < 1:
        raise ValueError(f"{path.name}: invalid tile size or empty archive.")


def _validate_statistics(records: dict, dataset_id: str, expected_count: int):
    if len(records) != expected_count:
        raise ValueError(f"{dataset_id}: expected {expected_count} statistic records, received {len(records)}.")
    for key, stats in records.items():
        complete = stats["completeAreaHa"]
        if dataset_id == "jaarbak":
            reconciled = stats["sealedAreaHa"] + stats["unsealedAreaHa"] + stats["noDataAreaHa"]
        elif dataset_id == "groenkaart":
            reconciled = sum(item["areaHa"] for item in stats["classes"]) + stats["noDataAreaHa"]
        elif dataset_id == "landgebruik":
            reconciled = sum(item["areaHa"] for item in stats["classes"]) + stats["noDataAreaHa"]
        else:
            reconciled = stats["zeroDensityAreaHa"] + stats["treePresenceAreaHa"] + stats["noDataAreaHa"]
            density_area = sum(item["areaHa"] for item in stats["densityClasses"])
            if abs(density_area - stats["treePresenceAreaHa"]) > max(0.01, complete * 0.005):
                raise ValueError(f"{dataset_id} {key}: density classes do not match detected-tree area.")
            if stats["crownEquivalentAreaHa"] > stats["treePresenceAreaHa"] + 1e-9:
                raise ValueError(f"{dataset_id} {key}: crown-equivalent area exceeds detected-tree area.")
        if abs(reconciled - complete) > max(0.01, complete * 0.005):
            raise ValueError(f"{dataset_id} {key}: areas do not reconcile with the complete Statbel area.")


def _source_metadata(dataset_id: str):
    if dataset_id == "jaarbak":
        return {"name": "Jaarlijkse bodemafdekkingskaart (JaarBAK)", "url": "https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023", "attribution": {"en": "Department of Environment & Spatial Development, Government of Flanders", "nl": "Departement Omgeving van de Vlaamse overheid"}, "resolutionLabel": "1 m", "crs": "EPSG:31370"}
    if dataset_id == "groenkaart":
        return {"name": "Groenkaart Vlaanderen", "url": "https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021", "attribution": {"en": "Agency for Nature and Forests, Government of Flanders, and Digital Flanders Agency", "nl": "Agentschap voor Natuur en Bos van de Vlaamse overheid en Digitaal Vlaanderen"}, "resolutionLabel": "1 m", "crs": "EPSG:31370", "producer": "Agentschap voor Natuur en Bos / Digitaal Vlaanderen", "styleUrl": f"{ANB_WMS}?service=WMS&request=GetLegendGraphic&layer=Grnkrt21&format=image/png"}
    return {"name": "Copernicus Tree Cover Density", "url": "https://land.copernicus.eu/en/products/high-resolution-layer-forests-and-tree-cover/tree-cover-density-2018-present-raster-10-m-europe-yearly", "attribution": {"en": "European Union Copernicus Land Monitoring Service", "nl": "Copernicus Land Monitoring Service van de Europese Unie"}, "resolutionLabel": "10 m", "crs": "EPSG:3035", "doi": "10.2909/e677441e-fb94-431c-b4f9-304f10e4dfd8", "catalogueUrl": TCD_CATALOGUE, "styleUrl": TCD_STYLE}


def prepare(dataset_id: str, sources: dict[int, Path]):
    sectors, municipalities = load_areas()
    raw_bounds = sectors.to_crs("EPSG:31370").total_bounds
    bounds_31370 = (math.floor(raw_bounds[0]), math.floor(raw_bounds[1]), math.ceil(raw_bounds[2]), math.ceil(raw_bounds[3]))
    years = {"jaarbak": JAARBAK_YEARS, "groenkaart": GROENKAART_YEARS, "tcd": TCD_YEARS}[dataset_id]
    output_root = CACHE_ROOT / dataset_id
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    previous_years = {}
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            if previous.get("schemaVersion") in (1, 2) and previous.get("datasetId") == dataset_id:
                previous_years = previous.get("years", {})
        except (OSError, ValueError):
            previous_years = {}
    catalogue = read_tcd_catalogue(CACHE_ROOT / "raw" / "tcd-catalogue.csv") if dataset_id == "tcd" else None
    if catalogue is not None and not set(years).issubset(catalogue):
        raise ValueError("The TCD catalogue does not contain every pinned 2018–2024 E39N30 product.")
    if catalogue is not None:
        zennevallei = sectors.geometry.union_all()
        for year in years:
            footprint = from_wkt(catalogue[year]["bbox"])
            if not footprint.contains(zennevallei):
                raise ValueError(f"TCD E39N30 does not fully contain Zennevallei in {year}.")
    if dataset_id == "tcd":
        style_cache = CACHE_ROOT / "raw" / "tcd-style.js"
        if not style_cache.exists():
            download_file(TCD_STYLE, style_cache)
        tcd_palette = parse_tcd_palette(style_cache.read_text(encoding="utf-8"))
        scale = {"items": [
            {"minimum": 0, "maximum": 0, "label": {"en": "0% tree cover", "nl": "0% boomkroonbedekking"}, "color": tcd_palette[0]},
            *[{"minimum": start, "maximum": end, "label": {"en": f"{start}–{end}%", "nl": f"{start}–{end}%"}, "color": tcd_palette[(start + end) // 2]} for start, end in ((1, 20), (21, 40), (41, 60), (61, 80), (81, 100))],
        ], "palette": tcd_palette}
    else:
        scale = {"items": list(JAARBAK_CLASSES if dataset_id == "jaarbak" else GROENKAART_CLASSES)}
        tcd_palette = None
    manifest = {
        "schemaVersion": 2, "datasetId": dataset_id,
        "kind": "continuous" if dataset_id == "tcd" else "categorical",
        "availableYears": list(years), "defaultYear": max(years), "opacity": 0.68,
        "classesOrScale": scale, "source": _source_metadata(dataset_id), "years": {},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sectorGeometrySha256": file_hash(SECTORS_PATH),
        "processing": {"tileSize": 256, "format": "PNG", "resampling": "nearest", "cutline": "Statbel Zennevallei union", "statisticsGrid": "native"},
    }
    cutlines = CACHE_ROOT / "cutlines"
    cutlines.mkdir(parents=True, exist_ok=True)
    all_cutline = cutlines / "zennevallei.geojson"
    _write_cutline(all_cutline, sectors.geometry.union_all())
    municipality_cutlines = {}
    for _, row in municipalities.iterrows():
        path = cutlines / f"{slug(row['municipality'])}.geojson"
        _write_cutline(path, row.geometry)
        municipality_cutlines[row["municipality"]] = path
    for year in years:
        previous_entry = previous_years.get(str(year))
        expected_maxzoom = 14 if dataset_id == "tcd" else 17
        if previous_entry:
            variants = previous_entry.get("pmtilesVariants", {})
            expected_keys = {"all", *MUNICIPALITIES}
            archives_are_valid = set(variants) == expected_keys
            if archives_are_valid:
                try:
                    for relative_path in variants.values():
                        _validate_pmtiles(CACHE_ROOT / relative_path, 10, expected_maxzoom)
                except (FileNotFoundError, ValueError, OSError):
                    archives_are_valid = False
            statistics_are_current = dataset_id != "tcd" or all(
                "treePresenceAreaHa" in stats and len(stats.get("densityClasses", [])) == 5
                for stats in previous_entry.get("sectorStats", {}).values()
            )
            if statistics_are_current:
                try:
                    _validate_statistics(previous_entry.get("sectorStats", {}), dataset_id, 154)
                    _validate_statistics(previous_entry.get("municipalityStats", {}), dataset_id, 7)
                except ValueError:
                    statistics_are_current = False
            if (
                archives_are_valid
                and len(previous_entry.get("sectorStats", {})) == 154
                and set(previous_entry.get("municipalityStats", {})) == set(MUNICIPALITIES)
                and statistics_are_current
            ):
                previous_entry["status"] = (
                    "provisional" if dataset_id == "jaarbak" and year == 2024 else "final"
                )
                manifest["years"][str(year)] = previous_entry
                print(f"{dataset_id} {year}: reusing completed year", flush=True)
                continue
        print(f"{dataset_id} {year}: validating source", flush=True)
        source, provenance = _source_for(dataset_id, year, sources, bounds_31370, catalogue)
        expected_crs = "EPSG:3035" if dataset_id == "tcd" else "EPSG:31370"
        resolution = 10 if dataset_id == "tcd" else 1
        values = range(0, 101) if dataset_id == "tcd" else ((0, 1, 255) if dataset_id == "jaarbak" else range(0, 5))
        validation_bounds = tuple(sectors.to_crs(expected_crs).total_bounds)
        classified_values = (
            range(0, 101) if dataset_id == "tcd" else ((0, 1) if dataset_id == "jaarbak" else range(1, 5))
        )
        try:
            _validate_raster(source, expected_crs, resolution, values, validation_bounds, classified_values)
        except ValueError:
            if year in sources or dataset_id == "tcd":
                raise
            print(f"{dataset_id} {year}: cached source is incomplete; downloading it again", flush=True)
            source.unlink(missing_ok=True)
            source, provenance = _source_for(dataset_id, year, sources, bounds_31370, catalogue)
            _validate_raster(source, expected_crs, resolution, values, validation_bounds, classified_values)
        print(f"{dataset_id} {year}: calculating sector and municipality statistics", flush=True)
        sector_stats = _area_stats(source, sectors, dataset_id, "sectorId")
        municipality_stats = _area_stats(source, municipalities, dataset_id, "municipality")
        _validate_statistics(sector_stats, dataset_id, 154)
        _validate_statistics(municipality_stats, dataset_id, 7)
        rgba = output_root / f"{dataset_id}-{year}-visual.tif"
        variants = {}
        archive_hashes = {}
        zooms = "10..14" if dataset_id == "tcd" else "10..17"
        targets = {"all": all_cutline, **municipality_cutlines}
        for name, cutline in targets.items():
            key = "all" if name == "all" else name
            filename = f"{dataset_id}-{year}-{slug(key)}.pmtiles"
            target = output_root / filename
            try:
                _validate_pmtiles(target, 10, 14 if dataset_id == "tcd" else 17)
                print(f"{dataset_id} {year}: reusing {filename}", flush=True)
            except (FileNotFoundError, ValueError, OSError):
                target.unlink(missing_ok=True)
                print(f"{dataset_id} {year}: creating {filename}", flush=True)
                if not rgba.exists():
                    _rgba_derivative(source, rgba, sectors.geometry.union_all(), dataset_id, tcd_palette)
                _pmtiles(rgba, target, cutline, zooms)
                _validate_pmtiles(target, 10, 14 if dataset_id == "tcd" else 17)
            variants[key] = f"{dataset_id}/{filename}"
            archive_hashes[key] = file_hash(target)
        rgba.unlink(missing_ok=True)
        manifest["years"][str(year)] = {
            "status": "provisional" if dataset_id == "jaarbak" and year == 2024 else "final",
            "note": {"en": "Production method changed from this year.", "nl": "De productiemethode wijzigde vanaf dit jaar."} if dataset_id == "jaarbak" and year == 2023 else None,
            "bounds": list(sectors.total_bounds), "minzoom": 10, "maxzoom": 14 if dataset_id == "tcd" else 17,
            "pmtilesVariants": variants, "sectorStats": sector_stats, "municipalityStats": municipality_stats,
            "pmtilesSha256": archive_hashes, "outputCount": len(variants),
            "retrievedAt": datetime.now(timezone.utc).isoformat(), "provenance": provenance,
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        update_index()
        print(f"{dataset_id} {year}: complete", flush=True)
    # Persist contract-only upgrades even when every native raster and PMTiles
    # archive was reused and the processing loop performed no heavy work.
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    update_index()
    return manifest


def update_index():
    datasets = {}
    for dataset_id in ("jaarbak", "groenkaart", "landgebruik", "landsat-temperature"):
        manifest_path = CACHE_ROOT / dataset_id / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        datasets[dataset_id] = {
            "datasetId": dataset_id,
            "manifestUrl": f"{dataset_id}/manifest.json",
            "kind": manifest["kind"],
            "availableYears": manifest.get("availableYears", []),
            "defaultYear": manifest.get("defaultYear"),
            "timelineItems": manifest.get("timelineItems", []),
            "defaultObservation": manifest.get("defaultObservation"),
            "opacity": manifest.get("opacity", 0.68),
            "source": manifest["source"],
            "agriculturalDetail": {
                "availableYear": manifest.get("agriculturalDetail", {}).get("availableYear"),
                "featureCount": manifest.get("agriculturalDetail", {}).get("featureCount"),
                "source": manifest.get("agriculturalDetail", {}).get("source"),
            } if manifest.get("agriculturalDetail") else None,
        }
    (CACHE_ROOT / "index.json").write_text(
        json.dumps({"schemaVersion": 2, "datasets": datasets}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
