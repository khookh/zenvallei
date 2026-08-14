"""Create deterministic PMTiles and manifests for browser integration tests."""

import gzip
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

jaarbak_source = ROOT / "fixture-jaarbak-rgba.tif"
with rasterio.open(
    jaarbak_source, "w", driver="GTiff", width=512, height=512, count=4, dtype="uint8",
    crs="EPSG:3857", transform=from_bounds(minx, miny, maxx, maxy, 512, 512),
) as dataset:
    rgba = np.zeros((4, 512, 512), dtype=np.uint8)
    rgba[:, :, :256] = np.array([0xe8, 0x29, 0x2f, 255], dtype=np.uint8)[:, None, None]
    rgba[:, :, 256:] = np.array([0x8e, 0xcf, 0x7c, 255], dtype=np.uint8)[:, None, None]
    dataset.write(rgba)
jaarbak_archive = ROOT / "fixture-jaarbak.pmtiles"
# Browser tests only exercise the audited map zooms. Keeping this fixture at
# zoom 14 makes setup deterministic and fast; production JaarBAK remains 1 m
# through zoom 17.
_pmtiles(jaarbak_source, jaarbak_archive, cutline, "9..14")

shared_root = ROOT / "shared"
shared_root.mkdir(parents=True, exist_ok=True)
shutil.copy2(archive, shared_root / "urban-fabric-2021.pmtiles")

municipalities = sorted(sectors["municipality"].unique())
sector_ids = sectors["sectorId"].astype(str).tolist()


def variants(dataset, value):
    output = {}
    for name in ["all", *municipalities]:
        filename = f"{dataset}-{value}-{slug(name)}.pmtiles"
        target = ROOT / dataset / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(jaarbak_archive if dataset == "jaarbak" else archive, target)
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
(comparison_root / "display").mkdir(parents=True, exist_ok=True)
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
urban_class_indexes = {entry["code"]: entry["index"] for entry in class_series}
urban_class_rgba = np.zeros((4, 512, 512), dtype=np.uint8)
urban_class_rgba[0, :, :256] = urban_class_indexes["11100"]
urban_class_rgba[0, :, 256:] = urban_class_indexes["14110"]
urban_class_rgba[3] = 255
urban_class_source = ROOT / "fixture-urban-classes.tif"
with rasterio.open(
    urban_class_source, "w", driver="GTiff", width=512, height=512, count=4, dtype="uint8",
    crs="EPSG:3857", transform=from_bounds(minx, miny, maxx, maxy, 512, 512),
) as dataset:
    dataset.write(urban_class_rgba)
_pmtiles(urban_class_source, shared_root / "urban-atlas-classes-2021.pmtiles", cutline, "9..14")
series_stats = {
    "clearObservedAreaHa": 9.0, "cloudObservedAreaHa": .36, "otherMissingAreaHa": .18,
    "contributingLandsatCount": 100, "underflowAreaM2": 0, "overflowAreaM2": 0,
    "binAreaM2": [0] * 35 + [9_000, 22_500, 27_000, 18_000, 13_500] + [0] * 30,
    "meanC": 34.1, "medianC": 34.0, "p10C": 31.0, "p90C": 38.0,
}
scope_ids = ["region:zennevallei", *[f"municipality:{name}" for name in municipalities], *[f"sector:{value}" for value in sector_ids]]

def fixture_regression(scope_id, slope=.001):
    if scope_id == "region:zennevallei":
        count = len(sector_ids)
    elif scope_id.startswith("municipality:"):
        count = int(np.count_nonzero(sectors["municipality"] == scope_id.split(":", 1)[1]))
    else:
        count = 1
    if count < 3:
        return None
    available = count >= 10
    return {
        "count": count, "slope": slope, "intercept": 10, "rSquared": .4,
        "pearsonR": -.63, "spearmanRho": -.60,
        "xMinimum": 20_000, "xMaximum": 50_000, "yMinimum": 10, "yMaximum": 50,
        "inference": {
            "method": "crh-dutilleul-modified-t", "hypothesis": "pearson-r-equals-zero",
            "sidedness": "two-sided", "pValue": .023 if available else None,
            "effectiveSampleSize": min(count, 42.5) if available else None,
            "distanceClassCount": 13, "observationCount": count,
            "status": "available" if available else "insufficient-observations",
        },
    }
for item in landsat_items:
    encoded = np.zeros((64, 64, 4), dtype=np.uint8)
    temperature_code = int(round((35.5 + 100) * 100))
    encoded[..., 0] = temperature_code >> 8
    encoded[..., 1] = temperature_code & 255
    encoded[..., 3] = 255
    Image.fromarray(encoded, mode="RGBA").save(comparison_root / "display" / f"{item['value']}.png")
    all_keys = [entry["key"] for entry in comparison_series + class_series]
    distribution_payload = json.dumps({
        "schemaVersion": 2, "observationId": item["value"],
        "scopes": {scope_id: {"assignedAreaHa": 9.54, "series": {key: series_stats for key in all_keys}} for scope_id in scope_ids},
    }, separators=(",", ":")).encode("utf-8")
    (comparison_root / "distributions" / f"{item['value']}.json.gz").write_bytes(
        gzip.compress(distribution_payload, compresslevel=9, mtime=0),
    )

comparison_manifest = {
    "schemaVersion": 3, "comparisonId": "landsat-urban-atlas",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "urban-atlas",
    "defaultSeries": ["family:greenUrbanAreas", "class:11100"], "maximumSeries": 4,
    "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
    "binEdges": np.arange(15, 50.5, 0.5).tolist(), "urbanAtlasYear": 2021,
    "maskResolutionMeters": 1, "temperatureResolutionMeters": 30,
    "aggregation": "exact-masked-area", "minimumAnalysedAreaHa": .1,
    "coordinates": [[sectors.total_bounds[0], sectors.total_bounds[3]], [sectors.total_bounds[2], sectors.total_bounds[3]], [sectors.total_bounds[2], sectors.total_bounds[1]], [sectors.total_bounds[0], sectors.total_bounds[1]]],
    "imageSize": [64, 64], "scopeIndexUrl": "landsat-urban-atlas/scope-index.png",
    "municipalityIndexes": {name: index + 1 for index, name in enumerate(municipalities)},
    "sectorIndexes": {value: index + 1 for index, value in enumerate(sector_ids)},
    "urbanAtlasClassMaskUrl": "shared/urban-atlas-classes-2021.pmtiles",
    "urbanAtlasClassIndexes": urban_class_indexes,
    "families": comparison_series, "classes": class_series,
    "observations": {item["value"]: {
        "displayDataUrl": f"landsat-urban-atlas/display/{item['value']}.png",
        "distributionUrl": f"landsat-urban-atlas/distributions/{item['value']}.json.gz",
    } for item in landsat_items},
}
(comparison_root / "manifest.json").write_text(json.dumps(comparison_manifest), encoding="utf-8")

soil_root = ROOT / "landsat-jaarbak"
(soil_root / "density-points").mkdir(parents=True, exist_ok=True)
(soil_root / "density-values").mkdir(parents=True, exist_ok=True)
(soil_root / "distributions").mkdir(parents=True, exist_ok=True)
Image.fromarray(scope_rgba, mode="RGBA").save(soil_root / "scope-index.png")
analysis_scope = np.zeros((64, 64, 4), dtype=np.uint8)
fixture_sector_index = rasterize(
    [(row.geometry, index + 1) for index, row in sectors.iterrows()],
    out_shape=(64, 64), transform=from_bounds(*sectors.total_bounds, 64, 64),
    fill=0, dtype="uint8",
)
fixture_municipality_index = rasterize(
    [(sectors.loc[sectors["municipality"] == name].geometry.union_all(), index)
     for index, name in enumerate(municipalities, start=1)],
    out_shape=(64, 64), transform=from_bounds(*sectors.total_bounds, 64, 64),
    fill=0, dtype="uint8",
)
analysis_scope[..., 0] = (fixture_sector_index > 0).astype(np.uint8)
analysis_scope[..., 1] = fixture_municipality_index
analysis_scope[..., 2] = fixture_sector_index
analysis_scope[..., 3] = 255
Image.fromarray(analysis_scope, mode="RGBA").save(soil_root / "analysis-scope-index.png")
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

def fixture_density_scope_stats():
    output = {}
    for scope_id in scope_ids:
        if scope_id == "region:zennevallei":
            selected = analysis_scope[..., 0] == 1
        elif scope_id.startswith("municipality:"):
            selected = analysis_scope[..., 1] == comparison_manifest["municipalityIndexes"][scope_id.split(":", 1)[1]]
        else:
            selected = analysis_scope[..., 2] == comparison_manifest["sectorIndexes"][scope_id.split(":", 1)[1]]
        count = int(np.count_nonzero(selected))
        output[scope_id] = {
            "n": count, "slope": .05 if count >= 2 else None,
            "intercept": 33 if count >= 2 else None,
            "rSquared": .4 if count >= 2 else None,
            "pearsonR": -.63 if count >= 2 else None,
            "spearmanRho": -.60 if count >= 2 else None,
            "analysedAreaHa": round(count * .09, 2),
            "inference": {
                "method": "crh-dutilleul-modified-t", "hypothesis": "pearson-r-equals-zero",
                "sidedness": "two-sided", "pValue": .023 if count >= 10 else None,
                "effectiveSampleSize": min(count, 42.5) if count >= 10 else None,
                "distanceClassCount": 13, "observationCount": count,
                "status": "available" if count >= 10 else "insufficient-observations",
            },
        }
    return output

for item in landsat_items:
    temperature_code = int(round((35.5 + 100) * 100))
    point_values = np.zeros((64, 64, 4), dtype=np.uint8)
    point_values[..., 0] = temperature_code >> 8
    point_values[..., 1] = temperature_code & 255
    point_values[..., 3] = 255
    Image.fromarray(point_values, mode="RGBA").save(soil_root / "density-points" / f"{item['value']}.png")
    density_values = np.zeros((64, 64, 4), dtype=np.uint8)
    density_code = np.tile(np.linspace(0, 10000, 64, dtype=np.uint16), (64, 1))
    density_values[..., 0] = density_code >> 8
    density_values[..., 1] = density_code & 255
    density_values[..., 2] = 255
    density_values[..., 3] = 255
    Image.fromarray(density_values, mode="RGBA").save(soil_root / "density-values" / f"{item['value']}.png")
    soil_distribution = json.dumps({
        "schemaVersion": 4, "observationId": item["value"],
        "secondaryYear": soil_years[item["value"]], "secondaryStatus": "provisional",
        "scopes": {scope_id: {"assignedAreaHa": 9.54, "series": {
            entry["key"]: series_stats for entry in soil_series
        }} for scope_id in scope_ids},
        "surfaceStats": {scope_id: surface_stats for scope_id in scope_ids},
        "densityAnalysis": fixture_density_scope_stats(),
    }, separators=(",", ":")).encode("utf-8")
    (soil_root / "distributions" / f"{item['value']}.json.gz").write_bytes(
        gzip.compress(soil_distribution, compresslevel=9, mtime=0),
    )

soil_manifest = {
    "schemaVersion": 4, "comparisonId": "landsat-jaarbak",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "jaarbak",
    "defaultSeries": ["class:sealed", "class:unsealed"], "maximumSeries": 2,
    "temperatureScale": {"minimum": 15, "maximum": 50, "step": 0.5, "unit": "°C"},
    "binEdges": np.arange(15, 50.5, 0.5).tolist(),
    "maskResolutionMeters": 1, "temperatureResolutionMeters": 30,
    "aggregation": "exact-masked-area", "minimumAnalysedAreaHa": .1,
    "classification": {"sourceResolutionMetres": 1, "temperatureResolutionMetres": 30,
                       "aggregation": "exact-masked-area", "minimumAnalysedAreaHa": .1,
                       "areaContributionSquareMetres": 1},
    "coordinates": comparison_manifest["coordinates"], "imageSize": [64, 64],
    "scopeIndexUrl": "landsat-jaarbak/scope-index.png",
    "analysisImageSize": [64, 64], "analysisScopeIndexUrl": "landsat-jaarbak/analysis-scope-index.png",
    "densityAnalysis": {"radiusMeters": 100, "validCoverageThreshold": 95,
                        "points": "all-clear-valid-density-landsat-pixels", "sampling": "none"},
    "municipalityIndexes": comparison_manifest["municipalityIndexes"],
    "sectorIndexes": comparison_manifest["sectorIndexes"], "series": soil_series,
    "sectorIdsByIndex": {index + 1: sector_id for index, sector_id in enumerate(sector_ids)},
    "sectorMunicipalities": dict(zip(sector_ids, sectors["municipality"].astype(str))),
    "observations": {item["value"]: {
        "secondaryYear": soil_years[item["value"]], "secondaryStatus": "provisional",
        "densityPointDataUrl": f"landsat-jaarbak/density-points/{item['value']}.png",
        "densityDataUrl": f"landsat-jaarbak/density-values/{item['value']}.png",
        "distributionUrl": f"landsat-jaarbak/distributions/{item['value']}.json.gz",
    } for item in landsat_items},
}
(soil_root / "manifest.json").write_text(json.dumps(soil_manifest), encoding="utf-8")

# Sealed urban-fabric comparison fixtures use one analytical sector index and
# one dissolved visual scope mask, mirroring the production contract.
comparison_coordinates = comparison_manifest["coordinates"]
comparison_transform = from_bounds(*sectors.total_bounds, 64, 64)
sector_index = rasterize(
    [(row.geometry, index + 1) for index, row in sectors.iterrows()],
    out_shape=(64, 64), transform=comparison_transform, fill=0, dtype="uint8",
)
municipality_indexes = {name: index + 1 for index, name in enumerate(municipalities)}
municipality_index = rasterize(
    [(sectors.loc[sectors["municipality"] == name].geometry.union_all(), index)
     for name, index in municipality_indexes.items()],
    out_shape=(64, 64), transform=comparison_transform, fill=0, dtype="uint8",
)
sealed_scope = np.zeros((64, 64, 4), dtype=np.uint8)
sealed_scope[..., 0] = (sector_index > 0).astype(np.uint8)
sealed_scope[..., 1] = municipality_index
sealed_scope[..., 3] = 255
sector_indexes = {value: index + 1 for index, value in enumerate(sector_ids)}
sector_municipalities = dict(zip(sectors["sectorId"].astype(str), sectors["municipality"].astype(str)))
income_payload = json.loads((PROJECT_ROOT / "public" / "data" / "income.json").read_text(encoding="utf-8"))
income_2023 = income_payload["years"]["2023"]["sectorStats"]
green_classes = list(GROENKAART_CLASSES)
green_combinations = [tuple(value) for size in range(1, 5) for value in combinations([1, 2, 3, 4], size)]
fabric_codes = ["11100", "11210", "11220", "11230", "11240"]
surface_groups = [
    {"id": "residential", "codes": fabric_codes, "color": "#b84242"},
    {"id": "employmentInstitutional", "codes": ["12100"], "color": "#9147b7"},
]
surface_contract = {
    "urbanAtlasClassMaskUrl": "shared/urban-atlas-classes-2021.pmtiles",
    "urbanAtlasClassIndexes": urban_class_indexes,
    "urbanSurfaceGroups": surface_groups,
    "defaultUrbanSurfaceGroups": ["residential", "employmentInstitutional"],
}

green_income_root = ROOT / "groenkaart-income"
green_income_root.mkdir(parents=True, exist_ok=True)
green_density = np.zeros((64, 64, 4), dtype=np.uint8)
green_density[..., 0] = np.tile(np.linspace(20, 160, 64, dtype=np.uint8), (64, 1))
green_density[..., 1] = 80
green_density[..., 2] = 50
green_density[..., 3] = 255
green_non_green = np.zeros((64, 64, 4), dtype=np.uint8)
green_non_green[..., 0] = 30
green_non_green[..., 3] = 255
Image.fromarray(green_density, mode="RGBA").save(green_income_root / "density-grid.png")
Image.fromarray(green_non_green, mode="RGBA").save(green_income_root / "density-non-green.png")
Image.fromarray(sealed_scope, mode="RGBA").save(green_income_root / "scope-index.png")
sealed_sector_stats = {}
for _, row in sectors.iterrows():
    sector_id = str(row.sectorId)
    fiscal = income_2023.get(sector_id, {})
    sealed_sector_stats[sector_id] = {
        "sectorId": sector_id, "sectorName": str(row.sectorName), "municipality": str(row.municipality),
        "eligibleDensityCellCount": 25, "analysedAreaHa": .25,
        "meanDensityByGreenClass": {"1": 30, "2": 20, "3": 35, "4": 15},
        "urbanSurfaceGroups": {
            "residential": {"eligibleDensityCellCount": 15, "analysedAreaHa": .15,
                            "meanDensityByGreenClass": {"1": 32, "2": 20, "3": 33, "4": 15}},
            "employmentInstitutional": {"eligibleDensityCellCount": 10, "analysedAreaHa": .10,
                                        "meanDensityByGreenClass": {"1": 27, "2": 20, "3": 38, "4": 15}},
        },
        "income": fiscal.get("medianNetTaxableIncome") if fiscal.get("sourceStatus") == "available" else None,
    }
green_income_statistics = json.dumps({
    "schemaVersion": 4, "sectorStats": sealed_sector_stats,
    "regressions": {"+".join(map(str, selected)): {scope_id: fixture_regression(scope_id) for scope_id in scope_ids}
                    for selected in green_combinations},
    "regressionsBySurface": {
        surface_key: {"+".join(map(str, selected)): {scope_id: fixture_regression(scope_id) for scope_id in scope_ids}
                      for selected in green_combinations}
        for surface_key in ("residential", "employmentInstitutional", "residential+employmentInstitutional")
    },
}, separators=(",", ":")).encode("utf-8")
(green_income_root / "statistics.json.gz").write_bytes(
    gzip.compress(green_income_statistics, compresslevel=9, mtime=0),
)
green_income_manifest = {
    "schemaVersion": 5, "comparisonId": "groenkaart-income",
    "primaryLayerId": "groenkaart", "secondaryLayerId": "income",
    "greenMapYear": 2021, "urbanAtlasYear": 2021, "jaarbakYear": 2021, "incomeYear": 2023,
    "analysisResolutionMeters": 10, "minimumJaarbakCoverage": .95,
    "minimumEligibleAreaHa": .10, "minimumAnalysedAreaHa": .10,
    "maskResolutionMeters": 1, "aggregation": "exact-masked-area",
    "statisticWeighting": "exact-sealed-urban-area",
    "urbanFabricCodes": fabric_codes, "excludedUrbanAtlasCodes": ["11300"],
    "defaultGreenClasses": [1, 2], "greenClasses": green_classes,
    "coordinates": comparison_coordinates, "imageSize": [64, 64],
    "sectorIndexes": sector_indexes, "sectorMunicipalities": sector_municipalities,
    "municipalityIndexes": municipality_indexes,
    "densityGridUrl": "groenkaart-income/density-grid.png",
    "densityNonGreenUrl": "groenkaart-income/density-non-green.png",
    "scopeIndexUrl": "groenkaart-income/scope-index.png",
    **surface_contract,
    "statisticsUrl": "groenkaart-income/statistics.json.gz",
}
(green_income_root / "manifest.json").write_text(json.dumps(green_income_manifest), encoding="utf-8")

# Green Map-population fixtures use compact records like the published asset.
# Ten deterministic observations per sector keep every municipality above the
# chart's minimum sample size without inflating browser-test setup time.
green_population_root = ROOT / "groenkaart-population"
green_population_root.mkdir(parents=True, exist_ok=True)
green_population_cells = []
for sector_number, sector_id in enumerate(sector_ids):
    for cell_number in range(10):
        green_population_cells.append({
            "s": sector_id, "r": sector_number % 64, "c": cell_number,
            "p": float((sector_number * 7 + cell_number * 11) % 220),
            "a": .12 + cell_number * .01,
            "g": [35 + cell_number, 18 + (sector_number % 12), 22, 25],
            "u": [[900, 31_500, 16_200, 19_800, 22_500],
                  [300, 10_500 + cell_number * 300, 5_400, 6_600, 7_500]],
        })
(green_population_root / "cells.json").write_text(json.dumps({
    "schemaVersion": 2, "cells": green_population_cells,
}), encoding="utf-8")
green_population_manifest = {
    "schemaVersion": 3, "comparisonId": "groenkaart-population",
    "primaryLayerId": "groenkaart", "secondaryLayerId": "population",
    "greenMapYear": 2021, "urbanAtlasYear": 2021, "jaarbakYear": 2021,
    "populationYear": 2019, "populationDatasetId": "flanders-2019",
    "populationResolutionMeters": 100, "densityRadiusMeters": 100,
    "densityCircleAreaHa": 3.14159265, "densityAnalysisResolutionMeters": 10,
    "minimumDensityCoverage": .95, "minimumEligibleAreaHa": .10,
    "minimumAnalysedAreaHa": .10,
    "maskResolutionMeters": 1, "aggregation": "exact-masked-area",
    **surface_contract, "defaultGreenClasses": [1, 2],
    "greenClasses": green_classes,
    "cellEncoding": {"s": "sectorId", "r": "row", "c": "column", "p": "populationDensityPerHa",
                     "a": "analysedAreaHa", "g": "meanDensityByGreenClass[1,2,3,4]"},
    "sectorMunicipalities": sector_municipalities,
    "coordinates": comparison_coordinates, "imageSize": [64, 64],
    "densityGridUrl": "groenkaart-income/density-grid.png",
    "densityNonGreenUrl": "groenkaart-income/density-non-green.png",
    "statisticsUrl": "groenkaart-population/cells.json",
}
(green_population_root / "manifest.json").write_text(
    json.dumps(green_population_manifest), encoding="utf-8"
)

landsat_green_root = ROOT / "landsat-groenkaart"
(landsat_green_root / "points").mkdir(parents=True, exist_ok=True)
(landsat_green_root / "statistics").mkdir(parents=True, exist_ok=True)
Image.fromarray(green_density, mode="RGBA").save(landsat_green_root / "green-density-grid.png")
Image.fromarray(green_non_green, mode="RGBA").save(landsat_green_root / "green-density-non-green.png")
Image.fromarray(sealed_scope, mode="RGBA").save(landsat_green_root / "scope-index.png")
landsat_green_observations = {}
landsat_income_observations = {}
landsat_population_observations = {}
(ROOT / "shared" / "landsat-display").mkdir(parents=True, exist_ok=True)
for observation_number, item in enumerate(landsat_items):
    temperature = 35.5 + observation_number * 1.5
    temperature_code = int(round((temperature + 100) * 100))
    points_image = np.zeros((64, 64, 4), dtype=np.uint8)
    points_image[..., 0] = temperature_code >> 8
    points_image[..., 1] = temperature_code & 255
    points_image[..., 2] = sector_index
    points_image[..., 3] = np.where(sector_index > 0, 255, 0).astype(np.uint8)
    point_url = f"landsat-groenkaart/points/{item['value']}.json.gz"
    display_url = f"shared/landsat-display/{item['value']}.png"
    Image.fromarray(points_image, mode="RGBA").save(ROOT / display_url)
    point_records = []
    for sector_number, _sector_id in enumerate(sector_ids, start=1):
        for parent_offset in range(5):
            parent = (sector_number - 1) * 5 + parent_offset + 1
            for group_index in (1, 2):
                area = 100
                densities = (30, 20, 35, 15) if group_index == 1 else (24, 18, 43, 15)
                point_records.append([sector_number, parent, group_index, area,
                                      *[value * area for value in densities], temperature])
    point_payload = json.dumps({
        "schemaVersion": 2, "observationId": item["value"],
        "encoding": ["sectorIndex", "landsatIndex", "urbanSurfaceGroupIndex", "maskedAreaM2",
                     "highGreenAreaSum", "lowGreenAreaSum", "agricultureAreaSum",
                     "nonGreenAreaSum", "temperatureC"],
        "records": point_records,
    }, separators=(",", ":")).encode("utf-8")
    (ROOT / point_url).write_bytes(gzip.compress(point_payload, compresslevel=9, mtime=0))
    observation_stats = {
        sector_id: {**record, "clearPixelCount": 25, "analysedAreaHa": 2.25,
                    "meanTemperatureC": temperature,
                    "temperatureAreaSum": temperature * 22_500,
                    "contributingLandsatCount": 25,
                    "urbanSurfaceGroups": {
                        "residential": {"analysedAreaHa": 1.62,
                                        "temperatureAreaSum": temperature * 16_200,
                                        "contributingLandsatCount": 18,
                                        "landsatIndexes": list(range(1, 19))},
                        "employmentInstitutional": {"analysedAreaHa": .63,
                                                    "temperatureAreaSum": (temperature + .4) * 6_300,
                                                    "contributingLandsatCount": 7,
                                                    "landsatIndexes": list(range(19, 26))},
                    }}
        for sector_id, record in sealed_sector_stats.items()
    }
    green_statistics_url = f"landsat-groenkaart/statistics/{item['value']}.json.gz"
    green_statistics_payload = json.dumps({
        "schemaVersion": 3, "observationId": item["value"], "pointCount": len(point_records),
        "aggregation": "exact-masked-area",
        "inferenceBySurface": {
            surface_key: {"+".join(map(str, selected)): {
                scope_id: fixture_density_scope_stats()[scope_id]["inference"] for scope_id in scope_ids
            } for selected in green_combinations}
            for surface_key in ("residential", "employmentInstitutional", "residential+employmentInstitutional")
        },
    }, separators=(",", ":")).encode("utf-8")
    (ROOT / green_statistics_url).write_bytes(gzip.compress(green_statistics_payload, compresslevel=9, mtime=0))
    income_statistics_url = f"landsat-income/statistics/{item['value']}.json.gz"
    (ROOT / income_statistics_url).parent.mkdir(parents=True, exist_ok=True)
    income_statistics_payload = json.dumps({
        "schemaVersion": 4, "observationId": item["value"], "sectorStats": observation_stats,
        "regressions": {scope_id: fixture_regression(scope_id, -.0001) for scope_id in scope_ids},
        "regressionsBySurface": {
            surface_key: {scope_id: fixture_regression(scope_id, -.0001) for scope_id in scope_ids}
            for surface_key in ("residential", "employmentInstitutional", "residential+employmentInstitutional")
        }, "incomeCategoriesBySurface": {},
    }, separators=(",", ":")).encode("utf-8")
    (ROOT / income_statistics_url).write_bytes(gzip.compress(income_statistics_payload, compresslevel=9, mtime=0))
    landsat_green_observations[item["value"]] = {
        "jaarbakYear": soil_years[item["value"]], "displayDataUrl": display_url,
        "pointDataUrl": point_url,
        "statisticsUrl": green_statistics_url,
    }
    landsat_income_observations[item["value"]] = {
        "jaarbakYear": soil_years[item["value"]], "displayDataUrl": display_url,
        "statisticsUrl": income_statistics_url,
    }
    population_cells_url = f"landsat-population/cells/{item['value']}.json.gz"
    (ROOT / population_cells_url).parent.mkdir(parents=True, exist_ok=True)
    population_cells = []
    for sector_number, sector_id in enumerate(sector_ids):
        for cell_number in range(10):
            population_density = float((sector_number * 7 + cell_number * 11) % 220)
            population_cells.append([
                sector_id, sector_number % 64, cell_number, population_density,
                [650, round((temperature + (cell_number - 4.5) * .08) * 650, 5), [1, 2, 3]],
                [450, round((temperature + .5) * 450, 5), [4, 5]],
            ])
    population_cells_payload = json.dumps({
        "schemaVersion": 3, "observationId": item["value"], "cells": population_cells,
    }, separators=(",", ":")).encode("utf-8")
    (ROOT / population_cells_url).write_bytes(
        gzip.compress(population_cells_payload, compresslevel=9, mtime=0),
    )
    landsat_population_observations[item["value"]] = {
        "jaarbakYear": soil_years[item["value"]], "displayDataUrl": display_url,
        "statisticsUrl": population_cells_url,
    }

sealed_landsat_common = {
    "schemaVersion": 1, "urbanAtlasYear": 2021, "urbanFabricCodes": fabric_codes,
    "excludedUrbanAtlasCodes": ["11300"], "analysisResolutionMeters": 30,
    "maskResolutionMeters": 1, "temperatureResolutionMeters": 30,
    "aggregation": "exact-masked-area", "minimumAnalysedAreaHa": .1,
    "minimumPixelMaskedAreaM2": 1,
    "coordinates": comparison_coordinates, "imageSize": [64, 64],
    "sectorIndexes": sector_indexes, "sectorMunicipalities": sector_municipalities,
    "municipalityIndexes": municipality_indexes,
    "scopeIndexUrl": "landsat-groenkaart/scope-index.png",
}
landsat_green_manifest = {
    **sealed_landsat_common, "schemaVersion": 7, "comparisonId": "landsat-groenkaart",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "groenkaart",
    "greenMapYear": 2021, "defaultGreenClasses": [1, 2], "greenClasses": green_classes,
    "densityGridUrl": "landsat-groenkaart/green-density-grid.png",
    "densityNonGreenUrl": "landsat-groenkaart/green-density-non-green.png",
    "urbanFabricMaskUrl": "shared/urban-fabric-2021.pmtiles",
    "urbanAtlasClassMaskUrl": "shared/urban-atlas-classes-2021.pmtiles",
    "urbanAtlasClassIndexes": urban_class_indexes,
    "defaultUrbanSurfaceGroups": ["residential", "employmentInstitutional"],
    "urbanSurfaceGroups": surface_groups,
    "observations": landsat_green_observations,
}
(landsat_green_root / "manifest.json").write_text(json.dumps(landsat_green_manifest), encoding="utf-8")
landsat_income_root = ROOT / "landsat-income"
landsat_income_root.mkdir(parents=True, exist_ok=True)
landsat_income_manifest = {
    **sealed_landsat_common, "schemaVersion": 5, "comparisonId": "landsat-income",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "income",
    "incomeYear": 2023, "displayResolutionMeters": 1,
    **surface_contract,
    "observations": landsat_income_observations,
}
(landsat_income_root / "manifest.json").write_text(json.dumps(landsat_income_manifest), encoding="utf-8")

landsat_population_root = ROOT / "landsat-population"
landsat_population_root.mkdir(parents=True, exist_ok=True)
landsat_population_manifest = {
    **sealed_landsat_common, "schemaVersion": 3, "comparisonId": "landsat-population",
    "primaryLayerId": "landsat-temperature", "secondaryLayerId": "population",
    "populationYear": 2019, "populationDatasetId": "flanders-2019",
    "populationResolutionMeters": 100,
    "displayResolutionMeters": 1,
    "cellEncoding": ["sectorId", "row", "column", "populationDensityPerHa",
                     "residential[areaM2,temperatureAreaSum,landsatIndexes]",
                     "employmentInstitutional[areaM2,temperatureAreaSum,landsatIndexes]"],
    **surface_contract,
    "observations": landsat_population_observations,
}
(landsat_population_root / "manifest.json").write_text(
    json.dumps(landsat_population_manifest), encoding="utf-8"
)

scenario_root = ROOT / "land-cover-scenario"
(scenario_root / "runtime" / "fixture").mkdir(parents=True, exist_ok=True)
for method, delta_c in (("radoux", -.50), ("xgboost", -.20)):
    delta_code = int(round(delta_c * 100)) + 32768
    encoded_delta = np.zeros((64, 64, 4), dtype=np.uint8)
    encoded_delta[..., 0] = delta_code >> 8
    encoded_delta[..., 1] = delta_code & 255
    encoded_delta[..., 3] = 255
    Image.fromarray(encoded_delta).save(scenario_root / "runtime" / "fixture" / f"delta-{method}.png")
scenario_change = np.zeros((64, 64, 4), dtype=np.uint8)
scenario_change[16:48, 16:48] = [31, 127, 0, 255]
Image.fromarray(scenario_change).save(scenario_root / "runtime" / "fixture" / "vegetation.png")
analysis_water_source = scenario_root / "analysis-water-fixture.tif"
with rasterio.open(
    analysis_water_source, "w", driver="GTiff", width=512, height=512, count=4, dtype="uint8",
    crs="EPSG:3857", transform=from_bounds(minx, miny, maxx, maxy, 512, 512),
) as dataset:
    rgba = np.zeros((4, 512, 512), dtype=np.uint8)
    rgba[0, 8:24, 8:24] = 255
    rgba[3, 8:24, 8:24] = 255
    dataset.write(rgba)
analysis_water_archive = scenario_root / "analysis-water-landgebruik-2025.pmtiles"
_pmtiles(analysis_water_source, analysis_water_archive, cutline, "9..14")
scenario_manifest = {
    "schemaVersion": 6, "datasetId": "land-cover-scenario", "kind": "scenario",
    "baselineYears": {
        "greenMap": 2021, "urbanAtlas": 2021, "soilSealing": 2024,
        "landUseWater": 2025,
    },
    "available": True,
    "source": {"name": "Radoux et al. (2025)", "url": "https://doi.org/10.3390/rs17162815"},
    "coefficientsC": {"high": -7.42, "low": -2.07, "sealed": 3.20},
    "stateContract": {
        "ground": ["low", "sealed", "agriculture", "water", "bare", "locked"],
        "latentOverlap": "high-canopy-over-ground-for-editing-only",
        "analysisSurface": "mutually-exclusive-upper-surface-v5-landgebruik-water",
    },
    "urbanAtlasClassMaskUrl": "../shared/urban-atlas-classes-2021.pmtiles",
    "urbanAtlasClassIndexes": urban_class_indexes,
    "analysisWaterMask": {
        "url": "land-cover-scenario/analysis-water-landgebruik-2025.pmtiles",
        "sha256": "fixture", "rendered": False, "editable": False,
        "landUseYear": 2025, "landUseWaterCode": 17,
    },
    "psf": {"sigmaMeters": 79.5, "gridResolutionMeters": 15, "kernelSize": 41},
    "maskResolutionMeters": 1, "temperatureGridResolutionMeters": 30,
    "affectedThresholdC": .01,
    "methodOrder": ["radoux", "xgboost"],
    "methods": {
        "radoux": {"available": True, "productId": "radoux", "source": {
            "name": "Radoux et al. (2025) daylight LST model", "url": "https://doi.org/10.3390/rs17162815",
        }},
        "xgboost": {
            "available": True, "productId": "xgboost", "modelContractVersion": 5,
            "modelSha256": "fixture-model", "featureArtifactSha256": "fixture-features",
            "catalogManifestSha256": "fixture-catalog",
            "inferenceGrid": {"sha256": "fixture-grid", "validCentreCount": 4096},
            "source": {
                "name": "2026 Heatwave XGBoost training notebook",
                "url": "https://github.com/khookh/zenvallei/blob/main/playground/xgboost_2026_heatwave_regression_zennevallei.ipynb",
            },
        },
    },
    "limits": {"operations": 100, "vertices": 10_000, "submittedAreaHa": 500},
    "sourceGrid": {"width": 64, "height": 64},
    "outputGrid": {"width": 64, "height": 64},
}
(scenario_root / "manifest.json").write_text(json.dumps(scenario_manifest), encoding="utf-8")

# The general browser fixture intercepts scenario calculations with the
# deterministic rasters above; scientific runtime tests use the real worker.
descriptors["land-cover-scenario"] = {
    "datasetId": "land-cover-scenario",
    "manifestUrl": "land-cover-scenario/manifest.json",
    "kind": "scenario",
    "available": True,
    "baselineYears": {
        "greenMap": 2021, "urbanAtlas": 2021, "soilSealing": 2024,
        "landUseWater": 2025,
    },
    "source": {
        "name": "Radoux et al. (2025) land-cover linear mixture model",
        "url": "https://doi.org/10.3390/rs17162815",
    },
}

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
        "landsat-groenkaart": {
            "comparisonId": "landsat-groenkaart", "primaryLayerId": "landsat-temperature",
            "secondaryLayerId": "groenkaart", "manifestUrl": "landsat-groenkaart/manifest.json",
        },
        "groenkaart-income": {
            "comparisonId": "groenkaart-income", "primaryLayerId": "groenkaart",
            "secondaryLayerId": "income", "manifestUrl": "groenkaart-income/manifest.json",
        },
        "landsat-income": {
            "comparisonId": "landsat-income", "primaryLayerId": "landsat-temperature",
            "secondaryLayerId": "income", "manifestUrl": "landsat-income/manifest.json",
        },
        "groenkaart-population": {
            "comparisonId": "groenkaart-population", "primaryLayerId": "groenkaart",
            "secondaryLayerId": "population", "manifestUrl": "groenkaart-population/manifest.json",
        },
        "landsat-population": {
            "comparisonId": "landsat-population", "primaryLayerId": "landsat-temperature",
            "secondaryLayerId": "population", "manifestUrl": "landsat-population/manifest.json",
        },
    },
}), encoding="utf-8")
