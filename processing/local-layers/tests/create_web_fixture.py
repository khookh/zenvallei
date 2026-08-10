"""Create deterministic PMTiles and manifests for browser integration tests."""

import json
import shutil
from itertools import combinations
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_bounds

from greenwave_local_layers.constants import GROENKAART_CLASSES, JAARBAK_CLASSES, PROJECT_ROOT, SECTORS_PATH
from greenwave_local_layers.pipeline import _pmtiles, _write_cutline, slug

ROOT = PROJECT_ROOT / ".cache" / "local-layers-test"
ROOT.mkdir(parents=True, exist_ok=True)
sectors = gpd.read_file(SECTORS_PATH)
projected = sectors.to_crs("EPSG:3857")
minx, miny, maxx, maxy = projected.total_bounds
source = ROOT / "fixture-rgba.tif"
with rasterio.open(
    source, "w", driver="GTiff", width=512, height=512, count=4, dtype="uint8",
    crs="EPSG:3857", transform=from_bounds(minx, miny, maxx, maxy, 512, 512),
) as dataset:
    rgba = np.zeros((4, 512, 512), dtype=np.uint8)
    rgba[0], rgba[1], rgba[2], rgba[3] = 35, 139, 69, 255
    dataset.write(rgba)
cutline = ROOT / "cutline.geojson"
_write_cutline(cutline, sectors.geometry.union_all())
archive = ROOT / "fixture.pmtiles"
_pmtiles(source, archive, cutline, "9..14")

municipalities = sorted(sectors["municipality"].unique())
sector_ids = sectors["sectorId"].astype(str).tolist()


def variants(dataset, value):
    output = {}
    for name in ["all", *municipalities]:
        filename = f"{dataset}-{value}-{slug(name)}.pmtiles"
        target = ROOT / dataset / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, target)
        output[name] = f"{dataset}/{filename}"
    return output


def official_stats(dataset):
    if dataset == "jaarbak":
        return {
            "completeAreaHa": 100, "validAreaHa": 98, "validPercentage": 98,
            "sealedAreaHa": 42, "sealedPercentage": 42, "unsealedAreaHa": 56,
            "unsealedPercentage": 56, "noDataAreaHa": 2, "noDataPercentage": 2,
        }
    return {
        "completeAreaHa": 100, "validAreaHa": 96, "validPercentage": 96,
        "noDataAreaHa": 4, "noDataPercentage": 4,
        "classes": [{"code": code, "areaHa": 24, "percentage": 24} for code in (1, 2, 3, 4)],
    }


dataset_years = {"jaarbak": list(range(2018, 2025)), "groenkaart": [2018, 2021]}
classes = {
    "jaarbak": {"items": list(JAARBAK_CLASSES)},
    "groenkaart": {"items": list(GROENKAART_CLASSES)},
}
descriptors = {}
for dataset, years in dataset_years.items():
    manifest = {
        "schemaVersion": 3, "datasetId": dataset, "kind": "categorical",
        "availableYears": years, "defaultYear": max(years), "classesOrScale": classes[dataset],
        "source": {"name": "Fixture official source", "url": "https://example.test/source", "resolutionLabel": "1 m"},
        "years": {},
    }
    for year in years:
        value = official_stats(dataset)
        manifest["years"][str(year)] = {
            "status": "provisional" if dataset == "jaarbak" and year == 2024 else "final",
            "bounds": sectors.total_bounds.tolist(), "minzoom": 10, "maxzoom": 14,
            "pmtilesVariants": variants(dataset, year),
            "sectorStats": {sector_id: value for sector_id in sector_ids},
            "municipalityStats": {municipality: value for municipality in municipalities},
        }
    density_root = ROOT / dataset / "density"
    density_root.mkdir(parents=True, exist_ok=True)
    scope = np.zeros((64, 64, 4), dtype=np.uint8)
    scope[..., 0] = rasterize(
        [(geometry, index) for index, geometry in enumerate(
            [projected.loc[sectors["municipality"] == name].geometry.union_all() for name in municipalities], start=1
        )], out_shape=(64, 64), transform=from_bounds(minx, miny, maxx, maxy, 64, 64), fill=0,
    )
    scope[..., 1] = rasterize(
        [(projected.geometry.union_all(), 255)], out_shape=(64, 64),
        transform=from_bounds(minx, miny, maxx, maxy, 64, 64), fill=0,
    )
    scope[..., 3] = 255
    Image.fromarray(scope, mode="RGBA").save(density_root / "scope-index.png")
    density_codes = [1] if dataset == "jaarbak" else [1, 2, 3, 4]
    density_years = {}
    for year in years:
        density_path = density_root / f"{dataset}-{year}-density.tif"
        values = np.full((len(density_codes) + 1, 64, 64), 65535, dtype=np.uint16)
        inside = scope[..., 1] > 0
        for band, code in enumerate(density_codes):
            values[band][inside] = (2200 + code * 800)
        values[-1][inside] = 10000
        with rasterio.open(
            density_path, "w", driver="GTiff", width=64, height=64,
            count=len(density_codes) + 1, dtype="uint16", crs="EPSG:3857",
            transform=from_bounds(minx, miny, maxx, maxy, 64, 64), nodata=65535,
        ) as density_file:
            density_file.write(values)
        density_years[str(year)] = {"dataUrl": f"{dataset}/density/{density_path.name}"}
    west, south, east, north = sectors.total_bounds
    manifest["density"] = {
        "schemaVersion": 1, "radiusMeters": 100, "circleAreaHa": 3.141592653589793,
        "analysisResolutionMeters": 10, "browserResolutionMeters": 20,
        "encodingScale": 100, "noDataValue": 65535, "validCoverageThreshold": 95,
        "denominator": "complete-circle", "includeBeyondZennevallei": True,
        "coordinates": [[west, north], [east, north], [east, south], [west, south]],
        "boundsEpsg3857": [minx, miny, maxx, maxy], "imageSize": [64, 64],
        "scopeIndexUrl": f"{dataset}/density/scope-index.png",
        "municipalityIndexes": {name: index for index, name in enumerate(municipalities, start=1)},
        "bands": [
            *[{"code": code, "index": index} for index, code in enumerate(density_codes, start=1)],
            {"code": "validCoverage", "index": len(density_codes) + 1},
        ],
        "years": density_years,
    }
    (ROOT / dataset / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    descriptors[dataset] = {
        "datasetId": dataset, "manifestUrl": f"{dataset}/manifest.json", "kind": "categorical",
        "availableYears": years, "defaultYear": max(years), "opacity": 0.68,
        "source": manifest["source"],
        "density": {"available": True, "radiusMeters": 100, "availableYears": years},
    }

landgebruik_classes = [
    {"value": value, "sourceLabel": f"Class {value}", "color": color, "group": group}
    for value, color, group in (
        (1, "#ff0000", "settlement"), (2, "#8400a8", "economic"),
        (3, "#ff00c5", "economic"), (4, "#002673", "economic"),
        (5, "#686868", "infrastructure"), (6, "#ffaa00", "recreation"),
        (7, "#a87000", "agriculture"), (8, "#cccccc", "settlement"),
        (9, "#828282", "other"), (10, "#dfe6a9", "other"),
        (11, "#df73ff", "infrastructure"), (12, "#267300", "nature"),
        (13, "#ffffbe", "agriculture"), (14, "#a3ff73", "agriculture"),
        (15, "#897044", "nature"), (16, "#ffd37f", "nature"),
        (17, "#005ce6", "water"), (18, "#00a884", "nature"),
        (19, "#82ca5b", "nature"),
    )
]
landgebruik_stats = {
    "completeAreaHa": 100, "validAreaHa": 99, "validPercentage": 99,
    "noDataAreaHa": 1, "noDataPercentage": 1,
    "classes": [
        {"code": code, "areaHa": 50 if code == 1 else 49 / 18, "percentage": 50 if code == 1 else 49 / 18}
        for code in range(1, 20)
    ],
}
parcel_stats = {
    "completeAreaHa": 100, "parcelAreaHa": 20, "parcelPercentage": 20, "parcelCount": 8,
    "cropGroups": [
        {"sourceLabel": "Grasland", "areaHa": 12, "percentage": 60},
        {"sourceLabel": "Maïs", "areaHa": 8, "percentage": 40},
    ],
}
landgebruik_manifest = {
    "schemaVersion": 1, "datasetId": "landgebruik", "kind": "compound-temporal",
    "availableYears": [2019, 2022, 2025], "defaultYear": 2025, "opacity": 0.68,
    "classesOrScale": {"items": landgebruik_classes},
    "source": {"name": "Fixture Landgebruik", "url": "https://example.test/landgebruik", "resolutionLabel": "10 m"},
    "years": {},
    "agriculturalDetail": {
        "availableYear": 2025, "geojsonUrl": "landgebruik/agpa-2025.geojson", "featureCount": 1,
        "source": {"url": "https://example.test/agpa"},
        "cropGroups": [{"sourceLabel": "Grasland", "color": "#BFFF7F"}, {"sourceLabel": "Maïs", "color": "#FFFF00"}],
        "sectorStats": {sector_id: parcel_stats for sector_id in sector_ids},
        "municipalityStats": {municipality: parcel_stats for municipality in municipalities},
    },
}
for year in landgebruik_manifest["availableYears"]:
    landgebruik_manifest["years"][str(year)] = {
        "status": "final", "bounds": sectors.total_bounds.tolist(), "minzoom": 9, "maxzoom": 14,
        "pmtilesVariants": variants("landgebruik", year),
        "sectorStats": {sector_id: landgebruik_stats for sector_id in sector_ids},
        "municipalityStats": {municipality: landgebruik_stats for municipality in municipalities},
    }
(ROOT / "landgebruik" / "manifest.json").write_text(json.dumps(landgebruik_manifest, ensure_ascii=False), encoding="utf-8")
parcel_feature = sectors.iloc[0]
(ROOT / "landgebruik" / "agpa-2025.geojson").write_text(json.dumps({
    "type": "FeatureCollection", "features": [{
        "type": "Feature", "geometry": parcel_feature.geometry.__geo_interface__,
        "properties": {
            "agpakey": "fixture-parcel", "sectorId": str(parcel_feature.sectorId),
            "municipality": parcel_feature.municipality, "maincrop_title": "Grasland",
            "maincropgroup_title": "Grasland", "cropGroup": "Grasland", "color": "#BFFF7F",
            "area_ha": 1.25, "productionmethod_title": "Fixture method",
        },
    }],
}, ensure_ascii=False), encoding="utf-8")
descriptors["landgebruik"] = {
    "datasetId": "landgebruik", "manifestUrl": "landgebruik/manifest.json", "kind": "compound-temporal",
    "availableYears": [2019, 2022, 2025], "defaultYear": 2025, "opacity": 0.68,
    "source": landgebruik_manifest["source"], "agriculturalDetail": {"availableYear": 2025, "featureCount": 1},
}

landsat_items = [
    {"value": "landsat-2023-06-13", "acquiredAt": "2023-06-13T10:39:29Z", "kind": "heatwave", "heatwaveIds": ["2023-06"], "status": "available"},
    {"value": "landsat-2026-06-22", "acquiredAt": "2026-06-22T10:33:40Z", "kind": "heatwave", "heatwaveIds": ["2026-06"], "status": "available"},
]
landsat_stats = {
    "completeAreaHa": 100, "clearAreaHa": 91.2, "clearPercentage": 91.2,
    "cloudAreaHa": 4.1, "cloudPercentage": 4.1, "otherNoDataAreaHa": 4.7,
    "otherNoDataPercentage": 4.7, "pixelCount": 104,
    "meanC": 35.8, "p10C": 29.1, "medianC": 36.4, "p90C": 42.6,
    "meanUncertaintyK": 0.7, "medianUncertaintyK": 0.65,
}
observations = {}
for item in landsat_items:
    observations[item["value"]] = {
        **item, "id": item["value"], "date": item["acquiredAt"][:10],
        "satellites": ["landsat-9"], "sceneIds": [f"{item['value']}-fixture"], "wrs": ["199/24"],
        "clearCoveragePercentage": 91.2, "analysisSha256": "0" * 64,
        "pmtilesVariants": variants("landsat-temperature", item["value"]),
        "sectorStats": {sector_id: landsat_stats for sector_id in sector_ids},
        "municipalityStats": {municipality: landsat_stats for municipality in municipalities},
        "regionStats": landsat_stats,
    }
landsat_source = {
    "name": "Fixture Landsat", "resolutionLabel": "30 m",
    "productUrl": "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature",
}
landsat_manifest = {
    "schemaVersion": 2, "datasetId": "landsat-temperature", "kind": "continuous-temporal",
    "timelineItems": landsat_items, "defaultObservation": "landsat-2026-06-22", "opacity": 0.76,
    "scale": {"minimum": 15, "maximum": 50, "unit": "°C", "stops": [
        {"position": 0, "color": "#000004"}, {"position": 0.57, "color": "#a52c60"},
        {"position": 1, "color": "#fcffa4"},
    ]},
    "heatwaves": [
        {"id": "2023-06", "start": "2023-06-08", "end": "2023-06-17", "status": "observed", "observationIds": ["landsat-2023-06-13"]},
        {"id": "2025-06", "start": "2025-06-28", "end": "2025-07-02", "status": "no-acquisition", "observationIds": []},
        {"id": "2026-06", "start": "2026-06-17", "end": "2026-06-28", "status": "observed", "observationIds": ["landsat-2026-06-22"]},
    ],
    "observations": observations, "source": landsat_source,
    "kmi": {"definitionUrl": "https://www.meteo.be/"},
}
(ROOT / "landsat-temperature" / "manifest.json").write_text(json.dumps(landsat_manifest, ensure_ascii=False), encoding="utf-8")
descriptors["landsat-temperature"] = {
    "datasetId": "landsat-temperature", "manifestUrl": "landsat-temperature/manifest.json",
    "kind": "continuous-temporal", "timelineItems": landsat_items,
    "defaultObservation": "landsat-2026-06-22", "opacity": 0.76, "source": landsat_source,
}

# The local query endpoint reads the analytical three-band GeoTIFF. Its extent
# matches the real Zennevallei grid while fixture pixels have one known value.
landsat_bounds = sectors.to_crs("EPSG:32631").total_bounds
landsat_analysis = ROOT / "landsat-temperature" / "analysis"
landsat_analysis.mkdir(parents=True, exist_ok=True)
for item in landsat_items:
    path = landsat_analysis / f"{item['value']}.tif"
    with rasterio.open(
        path, "w", driver="GTiff", width=64, height=64, count=3, dtype="float32",
        crs="EPSG:32631", transform=from_bounds(*landsat_bounds, 64, 64), nodata=-9999,
    ) as dataset:
        dataset.write(np.full((64, 64), 37.25, dtype=np.float32), 1)
        dataset.write(np.ones((64, 64), dtype=np.float32), 2)
        dataset.write(np.full((64, 64), 0.65, dtype=np.float32), 3)

urban_atlas = json.loads((PROJECT_ROOT / "public" / "data" / "urban-atlas.json").read_text(encoding="utf-8"))
present_classes = [item for item in urban_atlas["classes"] if item.get("present")]
comparison_root = ROOT / "landsat-urban-atlas"
(comparison_root / "pixels").mkdir(parents=True, exist_ok=True)
(comparison_root / "distributions").mkdir(parents=True, exist_ok=True)
scope_rgba = np.zeros((64, 64, 4), dtype=np.uint8)
scope_rgba[..., 0] = 1
scope_rgba[..., 1] = 1
scope_rgba[..., 3] = 255
Image.fromarray(scope_rgba, mode="RGBA").save(comparison_root / "scope-index.png")
comparison_series = [
    {"key": "family:artificialSurfaces", "type": "family", "id": "artificialSurfaces", "codes": ["11100", "11210", "11220", "11230", "11240", "11300", "12100", "12210", "12220", "12230", "13100", "13300", "13400"], "color": "#a51f3d"},
    {"key": "family:greenUrbanAreas", "type": "family", "id": "greenUrbanAreas", "codes": ["14110", "14120", "14130"], "color": "#4c7f00"},
    {"key": "family:agriculture", "type": "family", "id": "agriculture", "codes": ["21000", "22000", "23000", "24000"], "color": "#9a7d00"},
    {"key": "family:forestSemiNatural", "type": "family", "id": "forestSemiNatural", "codes": ["31000", "32000", "33000"], "color": "#007a4d"},
    {"key": "family:sportsLeisure", "type": "family", "id": "sportsLeisure", "codes": ["14200"], "color": "#5b8e7d"},
    {"key": "family:water", "type": "family", "id": "water", "codes": ["50000"], "color": "#0077b6"},
]
class_series = [{
    "key": f"class:{item['code']}", "type": "class", "code": item["code"],
    "color": item["color"], "groupKey": item["groupKey"], "index": index + 1,
} for index, item in enumerate(present_classes)]
series_stats = {
    "clearPixelCount": 100, "cloudPixelCount": 4, "otherMissingPixelCount": 2,
    "underflowCount": 0, "overflowCount": 0,
    "binCounts": [0] * 35 + [10, 25, 30, 20, 15] + [0] * 30,
    "meanC": 34.1, "medianC": 34.0, "p10C": 31.0, "p90C": 38.0,
}
scope_ids = ["region:zennevallei", *[f"municipality:{name}" for name in municipalities], *[f"sector:{value}" for value in sector_ids]]
for item in landsat_items:
    encoded = np.zeros((64, 64, 4), dtype=np.uint8)
    encoded[..., 0] = 150
    encoded[:, :32, 1] = next(entry["index"] for entry in class_series if entry["code"] == "11100")
    encoded[:, 32:, 1] = next(entry["index"] for entry in class_series if entry["code"] == "14110")
    encoded[..., 2] = 1
    encoded[..., 3] = 255
    Image.fromarray(encoded, mode="RGBA").save(comparison_root / "pixels" / f"{item['value']}.png")
    all_keys = [entry["key"] for entry in comparison_series + class_series]
    (comparison_root / "distributions" / f"{item['value']}.json").write_text(json.dumps({
        "schemaVersion": 1, "observationId": item["value"],
        "scopes": {scope_id: {"assignedPixelCount": 106, "series": {key: series_stats for key in all_keys}} for scope_id in scope_ids},
    }), encoding="utf-8")

comparison_manifest = {
    "schemaVersion": 1, "comparisonId": "landsat-urban-atlas",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "urban-atlas",
    "defaultSeries": ["family:greenUrbanAreas", "class:11100"], "maximumSeries": 4,
    "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
    "binEdges": np.arange(15, 50.5, 0.5).tolist(), "urbanAtlasYear": 2021,
    "coordinates": [[sectors.total_bounds[0], sectors.total_bounds[3]], [sectors.total_bounds[2], sectors.total_bounds[3]], [sectors.total_bounds[2], sectors.total_bounds[1]], [sectors.total_bounds[0], sectors.total_bounds[1]]],
    "imageSize": [64, 64], "scopeIndexUrl": "landsat-urban-atlas/scope-index.png",
    "municipalityIndexes": {name: index + 1 for index, name in enumerate(municipalities)},
    "sectorIndexes": {value: index + 1 for index, value in enumerate(sector_ids)},
    "families": comparison_series, "classes": class_series,
    "observations": {item["value"]: {
        "pixelDataUrl": f"landsat-urban-atlas/pixels/{item['value']}.png",
        "distributionUrl": f"landsat-urban-atlas/distributions/{item['value']}.json",
    } for item in landsat_items},
}
(comparison_root / "manifest.json").write_text(json.dumps(comparison_manifest), encoding="utf-8")

soil_root = ROOT / "landsat-jaarbak"
(soil_root / "pixels").mkdir(parents=True, exist_ok=True)
(soil_root / "distributions").mkdir(parents=True, exist_ok=True)
Image.fromarray(scope_rgba, mode="RGBA").save(soil_root / "scope-index.png")
soil_series = [
    {"key": "class:sealed", "type": "class", "id": "sealed", "color": "#8f1d2c"},
    {"key": "class:unsealed", "type": "class", "id": "unsealed", "color": "#176b43"},
]
soil_years = {
    landsat_items[0]["value"]: 2023,
    landsat_items[1]["value"]: 2024,
}
surface_stats = {
    "completeAreaHa": 100, "validAreaHa": 100, "noDataAreaHa": 0,
    "sealedAreaHa": 40, "sealedPercentage": 40,
    "unsealedAreaHa": 60, "unsealedPercentage": 60,
}
for item in landsat_items:
    encoded = np.zeros((64, 64, 4), dtype=np.uint8)
    encoded[..., 0] = 150
    encoded[:, :32, 1] = 1
    encoded[:, 32:, 1] = 2
    # Simulate an unassigned analytical class at an internal sector tie. The
    # display must still render the valid temperature from the dissolved scope.
    encoded[20:22, 20:22, 1] = 0
    encoded[..., 2] = 1
    encoded[..., 3] = 255
    Image.fromarray(encoded, mode="RGBA").save(soil_root / "pixels" / f"{item['value']}.png")
    (soil_root / "distributions" / f"{item['value']}.json").write_text(json.dumps({
        "schemaVersion": 1, "observationId": item["value"],
        "secondaryYear": soil_years[item["value"]], "secondaryStatus": "provisional",
        "scopes": {scope_id: {"assignedPixelCount": 106, "series": {
            entry["key"]: series_stats for entry in soil_series
        }} for scope_id in scope_ids},
        "surfaceStats": {scope_id: surface_stats for scope_id in scope_ids},
    }), encoding="utf-8")

soil_manifest = {
    "schemaVersion": 1, "comparisonId": "landsat-jaarbak",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "jaarbak",
    "defaultSeries": ["class:sealed", "class:unsealed"], "maximumSeries": 2,
    "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
    "binEdges": np.arange(15, 50.5, 0.5).tolist(),
    "coordinates": comparison_manifest["coordinates"], "imageSize": [64, 64],
    "scopeIndexUrl": "landsat-jaarbak/scope-index.png",
    "municipalityIndexes": comparison_manifest["municipalityIndexes"],
    "sectorIndexes": comparison_manifest["sectorIndexes"], "series": soil_series,
    "observations": {item["value"]: {
        "secondaryYear": soil_years[item["value"]], "secondaryStatus": "provisional",
        "pixelDataUrl": f"landsat-jaarbak/pixels/{item['value']}.png",
        "distributionUrl": f"landsat-jaarbak/distributions/{item['value']}.json",
    } for item in landsat_items},
}
(soil_root / "manifest.json").write_text(json.dumps(soil_manifest), encoding="utf-8")

# Green Map x Urban Atlas fixture. It deliberately reuses the prepared 64 px
# Green Map density COG so browser tests exercise the real worker and selector
# lifecycle without copying production-size analytical arrays.
green_comparison_root = ROOT / "groenkaart-urban-atlas"
green_comparison_root.mkdir(parents=True, exist_ok=True)
fabric_codes = ["11100", "11210", "11220", "11230", "11240"]
fabric_mask = np.zeros((64, 64, 4), dtype=np.uint8)
for index in range(5):
    fabric_mask[:, index * 12:(index + 1) * 12, 0] = index + 1
fabric_mask[..., 3] = 255
Image.fromarray(fabric_mask, mode="RGBA").save(green_comparison_root / "urban-fabric-index.png")
fabric_stats = {
    code: {
        "validCellCount": 100 + index,
        "validAreaHa": 1 + index / 10,
        "meanDensityByGreenClass": {"1": 25 + index, "2": 20 + index, "3": 15, "4": 40 - 2 * index},
        "densityDistributions": {
            "+".join(map(str, selected)): {
                "count": 100 + index,
                "q1": min(100, 20 + index + 5 * len(selected)),
                "median": min(100, 30 + index + 5 * len(selected)),
                "q3": min(100, 40 + index + 5 * len(selected)),
                "whiskerLow": max(0, 10 + index),
                "whiskerHigh": min(100, 55 + index + 5 * len(selected)),
            }
            for size in range(1, 5)
            for selected in combinations([1, 2, 3, 4], size)
        },
    }
    for index, code in enumerate(fabric_codes)
}
(green_comparison_root / "statistics.json").write_text(json.dumps({
    "schemaVersion": 1,
    "comparisonId": "groenkaart-urban-atlas",
    "scopes": {scope_id: {"classes": fabric_stats} for scope_id in scope_ids},
}), encoding="utf-8")
green_manifest = json.loads((ROOT / "groenkaart" / "manifest.json").read_text(encoding="utf-8"))
fabric_source = {str(item["code"]): item for item in urban_atlas["classes"]}
green_comparison_manifest = {
    "schemaVersion": 1,
    "comparisonId": "groenkaart-urban-atlas",
    "primaryLayerId": "groenkaart",
    "secondaryLayerId": "urban-atlas",
    "greenMapYear": 2021,
    "urbanAtlasYear": 2021,
    "densityRadiusMeters": 100,
    "analysisResolutionMeters": 10,
    "defaultGreenClasses": [1, 2],
    "defaultFabricClasses": fabric_codes,
    "greenClasses": list(GROENKAART_CLASSES),
    "fabricClasses": [
        {
            "code": code,
            "index": index + 1,
            "sourceLabel": fabric_source[code].get("sourceLabel", code),
            "color": fabric_source[code]["color"],
        }
        for index, code in enumerate(fabric_codes)
    ],
    "excludedUrbanAtlasCodes": ["11300"],
    "coordinates": green_manifest["density"]["coordinates"],
    "imageSize": [64, 64],
    "densityDataUrl": "groenkaart/density/groenkaart-2021-density.tif",
    "densityBands": green_manifest["density"]["bands"],
    "densityEncodingScale": 100,
    "densityNoDataValue": 65535,
    "scopeIndexUrl": "groenkaart/density/scope-index.png",
    "municipalityIndexes": green_manifest["density"]["municipalityIndexes"],
    "fabricMaskUrl": "groenkaart-urban-atlas/urban-fabric-index.png",
    "statisticsUrl": "groenkaart-urban-atlas/statistics.json",
}
(green_comparison_root / "manifest.json").write_text(json.dumps(green_comparison_manifest), encoding="utf-8")

(ROOT / "index.json").write_text(json.dumps({
    "schemaVersion": 3, "datasets": descriptors,
    "comparisons": {
        "landsat-urban-atlas": {
            "comparisonId": "landsat-urban-atlas", "primaryLayerId": "landsat-temperature",
            "secondaryLayerId": "urban-atlas", "manifestUrl": "landsat-urban-atlas/manifest.json",
        },
        "landsat-jaarbak": {
            "comparisonId": "landsat-jaarbak", "primaryLayerId": "landsat-temperature",
            "secondaryLayerId": "jaarbak", "manifestUrl": "landsat-jaarbak/manifest.json",
        },
        "groenkaart-urban-atlas": {
            "comparisonId": "groenkaart-urban-atlas", "primaryLayerId": "groenkaart",
            "secondaryLayerId": "urban-atlas", "manifestUrl": "groenkaart-urban-atlas/manifest.json",
        },
    },
}), encoding="utf-8")
