"""Prepare Landgebruik Vlaanderen and the optional 2025 parcel detail.

The 10 m Landgebruik raster is the analytical source for sector and
municipality compositions. The PMTiles are lossless visual derivatives. The
2025 agricultural parcels are kept as clipped vector features so their exact
official crop attributes remain inspectable in the local application.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

from .constants import (
    AGPA_CROP_GROUP_COLORS,
    AGPA_FEATURES,
    CACHE_ROOT,
    LANDGEBRUIK_CLASSES,
    LANDGEBRUIK_LAYERS,
    LANDGEBRUIK_YEARS,
    MERCATOR_WCS,
    MUNICIPALITIES,
    SECTORS_PATH,
)
from .pipeline import (
    _area_stats,
    _pmtiles,
    _rgba_derivative,
    _validate_pmtiles,
    _validate_raster,
    _validate_statistics,
    _wcs_subset,
    _write_cutline,
    file_hash,
    load_areas,
    slug,
    update_index,
)

DATASET_ID = "landgebruik"
PARCEL_COLLECTION = "AGPA_2025"
PARCEL_SOURCE_URL = (
    "https://www.vlaanderen.be/datavindplaats/catalogus/"
    "landbouwgebruikspercelen-2025"
)
LANDGEBRUIK_SOURCE_URL = (
    "https://www.vlaanderen.be/datavindplaats/catalogus/"
    "landgebruik-vlaanderen-toestand-2025"
)


def _download_parcels(bounds, destination: Path) -> Path:
    """Download the bounded official OGC API response without credentials."""
    endpoint = f"{AGPA_FEATURES}/collections/{PARCEL_COLLECTION}/items"
    def retrieve(bbox, depth=0):
        params = {"bbox": ",".join(str(value) for value in bbox), "limit": 10000}
        response = requests.get(endpoint, params=params, timeout=(30, 300))
        response.raise_for_status()
        payload = response.json()
        features = payload.get("features", [])
        matched = int(payload.get("numberMatched", len(features)))
        if len(features) >= matched and len(features) < 10000:
            return features
        if depth >= 6:
            raise ValueError("The AGPA 2025 response remained truncated after spatial subdivision.")
        minx, miny, maxx, maxy = bbox
        if maxx - minx >= maxy - miny:
            middle = (minx + maxx) / 2
            children = ((minx, miny, middle, maxy), (middle, miny, maxx, maxy))
        else:
            middle = (miny + maxy) / 2
            children = ((minx, miny, maxx, middle), (minx, middle, maxx, maxy))
        return [feature for child in children for feature in retrieve(child, depth + 1)]

    by_id = {}
    for feature in retrieve(bounds):
        identifier = str(feature.get("id") or feature.get("properties", {}).get("agpakey"))
        by_id[identifier] = feature
    payload = {"type": "FeatureCollection", "features": list(by_id.values())}
    if not payload["features"]:
        raise ValueError("The AGPA 2025 OGC API returned no agricultural parcels.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial.geojson")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(destination)
    return destination


def _parcel_value(properties, name):
    value = properties.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        if bool(pd.isna(value)):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _prepare_parcels(sectors, municipalities, output_root: Path):
    print("landgebruik 2025: preparing agricultural parcel detail", flush=True)
    raw_path = CACHE_ROOT / "raw" / DATASET_ID / "agpa-2025.geojson"
    if not raw_path.exists():
        bounds = sectors.total_bounds
        padding = 0.01
        _download_parcels(
            (bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding),
            raw_path,
        )
    parcels = gpd.read_file(raw_path)
    required = {"agpakey", "area_ha", "maincrop_title", "maincropgroup_title"}
    if parcels.crs is None or not required.issubset(parcels.columns):
        raise ValueError("AGPA 2025 is missing its CRS or required crop attributes.")
    parcels = parcels.to_crs(sectors.crs)
    parcels = parcels[parcels.geometry.notna() & ~parcels.geometry.is_empty].copy()
    if "municipality" in parcels.columns:
        parcels = parcels.rename(columns={"municipality": "sourceMunicipality"})
    # Splitting by sector makes municipality filtering exact and attaches the
    # same Statbel identifiers used by every other selectable layer.
    fragments = gpd.overlay(
        parcels,
        sectors[["sectorId", "municipality", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    fragments = fragments[fragments.geometry.geom_type.isin(("Polygon", "MultiPolygon"))].copy()
    fragments = fragments.to_crs("EPSG:3035")
    fragments["fragmentAreaHa"] = fragments.geometry.area / 10000.0
    fragments = fragments.to_crs("EPSG:4326")
    # Keep the local browser asset focused on attributes that are rendered or
    # useful for provenance. Optional pandas values must become JSON null, not
    # JavaScript-incompatible NaN literals.
    allowed_fields = (
        "agpakey", "area_ha", "maincrop_code", "maincrop_title",
        "maincropgroup_title", "productionmethod_title", "organic_farming",
        "permanent_grassland",
    )
    fragments["cropGroup"] = fragments["maincropgroup_title"].map(
        lambda value: _parcel_value({"value": value}, "value") or "Overige gewassen"
    )
    features = []
    for _, row in fragments.iterrows():
        properties = {
            name: _parcel_value(row, name) for name in allowed_fields if name in fragments.columns
        }
        group = str(row["cropGroup"])
        properties.update({
            "sectorId": str(row["sectorId"]),
            "municipality": row["municipality"],
            "fragmentAreaHa": round(float(row["fragmentAreaHa"]), 5),
            "cropGroup": group,
            "color": AGPA_CROP_GROUP_COLORS.get(group, "#8f8f8f"),
        })
        features.append({
            "type": "Feature",
            "geometry": row.geometry.__geo_interface__,
            "properties": properties,
        })
    output_path = output_root / "agpa-2025.geojson"
    payload = {"type": "FeatureCollection", "features": features}
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    # Round-trip before publication so a malformed analytical source cannot
    # silently produce a legend and statistics with an unreadable map layer.
    if len(json.loads(encoded).get("features", [])) != len(features):
        raise ValueError("The agricultural parcel GeoJSON failed strict validation.")
    output_path.write_text(encoded, encoding="utf-8")

    def summaries(frame, key_field, complete_areas):
        result = {
            str(key): {
                "completeAreaHa": round(float(area), 4),
                "parcelAreaHa": 0.0,
                "parcelPercentage": 0.0,
                "parcelCount": 0,
                "cropGroups": [],
            }
            for key, area in complete_areas.items()
        }
        for key, group in frame.groupby(key_field, sort=True):
            groups = group.groupby("cropGroup", dropna=False)["fragmentAreaHa"].sum()
            total = float(group["fragmentAreaHa"].sum())
            complete_area = float(complete_areas[str(key)])
            result[str(key)] = {
                "completeAreaHa": round(complete_area, 4),
                "parcelAreaHa": round(total, 4),
                "parcelPercentage": round(0 if complete_area == 0 else total / complete_area * 100, 4),
                "parcelCount": int(group["agpakey"].nunique()),
                "cropGroups": [
                    {
                        "sourceLabel": str(label),
                        "areaHa": round(float(area), 4),
                        "percentage": round(0 if total == 0 else float(area) / total * 100, 4),
                    }
                    for label, area in groups.items()
                ],
            }
        return result

    sector_areas = sectors.to_crs("EPSG:3035").set_index("sectorId").geometry.area.div(10000).to_dict()
    sector_areas = {str(key): value for key, value in sector_areas.items()}
    municipality_areas = (
        municipalities.to_crs("EPSG:3035").set_index("municipality").geometry.area.div(10000).to_dict()
    )
    municipality_areas = {str(key): value for key, value in municipality_areas.items()}

    return {
        "availableYear": 2025,
        "geojsonUrl": f"{DATASET_ID}/agpa-2025.geojson",
        "featureCount": len(features),
        "sourceFeatureCount": int(parcels["agpakey"].nunique()),
        "source": {
            "name": "Landbouwgebruikspercelen 2025",
            "producer": "Agency for Agriculture and Fisheries, Government of Flanders",
            "url": PARCEL_SOURCE_URL,
            "ogcApi": AGPA_FEATURES,
            "collection": PARCEL_COLLECTION,
            "referenceScale": "1:2,000",
            "status": "definitive",
        },
        "cropGroups": [
            {"sourceLabel": label, "color": color}
            for label, color in AGPA_CROP_GROUP_COLORS.items()
        ],
        "sectorStats": summaries(fragments, "sectorId", sector_areas),
        "municipalityStats": summaries(fragments, "municipality", municipality_areas),
        "sourceSha256": file_hash(raw_path),
        "outputSha256": file_hash(output_path),
    }


def prepare_landgebruik(sources: dict[int, Path] | None = None):
    sources = sources or {}
    sectors, municipalities = load_areas()
    raw_bounds = sectors.to_crs("EPSG:31370").total_bounds
    bounds = tuple(math.floor(value) if index < 2 else math.ceil(value) for index, value in enumerate(raw_bounds))
    output_root = CACHE_ROOT / DATASET_ID
    output_root.mkdir(parents=True, exist_ok=True)
    cutline_root = CACHE_ROOT / "cutlines"
    cutline_root.mkdir(parents=True, exist_ok=True)
    all_cutline = cutline_root / "zennevallei.geojson"
    _write_cutline(all_cutline, sectors.geometry.union_all())
    municipality_cutlines = {}
    for _, row in municipalities.iterrows():
        path = cutline_root / f"{slug(row['municipality'])}.geojson"
        _write_cutline(path, row.geometry)
        municipality_cutlines[row["municipality"]] = path

    manifest = {
        "schemaVersion": 1,
        "datasetId": DATASET_ID,
        "kind": "compound-temporal",
        "availableYears": list(LANDGEBRUIK_YEARS),
        "defaultYear": 2025,
        "opacity": 0.68,
        "classesOrScale": {"items": list(LANDGEBRUIK_CLASSES)},
        "source": {
            "name": "Landgebruik Vlaanderen",
            "producer": "Department of Environment & Spatial Development, Government of Flanders",
            "url": LANDGEBRUIK_SOURCE_URL,
            "resolutionLabel": "10 m",
            "crs": "EPSG:31370",
            "frequency": "three-yearly",
        },
        "years": {},
        "processing": {
            "statisticsGrid": "native 10 m EPSG:31370 raster",
            "visualDerivative": "lossless categorical PNG PMTiles",
            "resampling": "nearest",
            "cutline": "Statbel Zennevallei union",
        },
        "sectorGeometrySha256": file_hash(SECTORS_PATH),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    palette = {item["value"]: item["color"] for item in LANDGEBRUIK_CLASSES}
    for year in LANDGEBRUIK_YEARS:
        print(f"landgebruik {year}: validating source and calculating area statistics", flush=True)
        source = sources.get(year)
        retrieval = "manual"
        if source is None:
            source = CACHE_ROOT / "raw" / DATASET_ID / f"landgebruik-{year}.tif"
            retrieval = "WCS"
            if not source.exists():
                _wcs_subset(MERCATOR_WCS, LANDGEBRUIK_LAYERS[year], bounds, source, resolution=10, nodata=0)
        source = Path(source).resolve()
        _validate_raster(source, "EPSG:31370", 10, range(0, 20), tuple(raw_bounds), range(1, 20))
        sector_stats = _area_stats(source, sectors, DATASET_ID, "sectorId")
        municipality_stats = _area_stats(source, municipalities, DATASET_ID, "municipality")
        _validate_statistics(sector_stats, DATASET_ID, 154)
        _validate_statistics(municipality_stats, DATASET_ID, 7)
        visual = output_root / f"landgebruik-{year}-visual.tif"
        variants = {}
        hashes = {}
        for key, cutline in {"all": all_cutline, **municipality_cutlines}.items():
            filename = f"landgebruik-{year}-{slug(key)}.pmtiles"
            archive = output_root / filename
            try:
                _validate_pmtiles(archive, 9, 16)
                print(f"landgebruik {year}: reusing {filename}", flush=True)
            except (FileNotFoundError, ValueError, OSError):
                if not visual.exists():
                    _rgba_derivative(source, visual, sectors.geometry.union_all(), DATASET_ID, palette)
                _pmtiles(visual, archive, cutline, "9..16")
                _validate_pmtiles(archive, 9, 16)
                print(f"landgebruik {year}: created {filename}", flush=True)
            variants[key] = f"{DATASET_ID}/{filename}"
            hashes[key] = file_hash(archive)
        visual.unlink(missing_ok=True)
        manifest["years"][str(year)] = {
            "status": "final",
            "bounds": list(sectors.total_bounds),
            "minzoom": 9,
            "maxzoom": 16,
            "pmtilesVariants": variants,
            "pmtilesSha256": hashes,
            "sectorStats": sector_stats,
            "municipalityStats": municipality_stats,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "provenance": {
                "retrieval": retrieval,
                "layerId": LANDGEBRUIK_LAYERS[year],
                "sourceSha256": file_hash(source),
                "sourceBytes": source.stat().st_size,
            },
        }
    manifest["agriculturalDetail"] = _prepare_parcels(sectors, municipalities, output_root)
    present_codes = {
        int(item["code"])
        for year in manifest["years"].values()
        for stats in year["sectorStats"].values()
        for item in stats["classes"]
        if item["areaHa"] > 0
    }
    manifest["classesOrScale"]["items"] = [
        {**item, "present": item["value"] in present_codes}
        for item in manifest["classesOrScale"]["items"]
    ]
    (output_root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    update_index()
    return manifest
