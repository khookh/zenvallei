"""Create deterministic PMTiles and manifests for browser integration tests."""

import json
import shutil
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
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
        "schemaVersion": 2, "datasetId": dataset, "kind": "categorical",
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
    (ROOT / dataset / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    descriptors[dataset] = {
        "datasetId": dataset, "manifestUrl": f"{dataset}/manifest.json", "kind": "categorical",
        "availableYears": years, "defaultYear": max(years), "opacity": 0.68,
        "source": manifest["source"],
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

(ROOT / "index.json").write_text(json.dumps({"schemaVersion": 2, "datasets": descriptors}), encoding="utf-8")
