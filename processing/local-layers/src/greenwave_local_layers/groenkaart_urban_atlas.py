"""Prepare the Green Map density x Urban Atlas urban-fabric comparison.

The four focal-density bands are calculated on the scientific 10 m grid. The
PNG mask is only a browser display derivative; panel statistics never read it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from itertools import combinations

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

from .constants import CACHE_ROOT, MUNICIPALITIES, PROJECT_ROOT, SECTORS_PATH
from .density import (
    ANALYSIS_RESOLUTION, RADIUS_METERS, _fraction_grid, aligned_bounds,
    circular_kernel, focal_density,
)
from .pipeline import file_hash, update_index


COMPARISON_ID = "groenkaart-urban-atlas"
OUTPUT_ROOT = CACHE_ROOT / COMPARISON_ID
URBAN_ATLAS_PATH = PROJECT_ROOT / "public" / "data" / "urban-atlas.geojson"
URBAN_ATLAS_MANIFEST = PROJECT_ROOT / "public" / "data" / "urban-atlas.json"
GROENKAART_MANIFEST = CACHE_ROOT / "groenkaart" / "manifest.json"
GROENKAART_HALO = CACHE_ROOT / "density-source" / "groenkaart" / "groenkaart-2021-halo.tif"
FABRIC_CODES = ("11100", "11210", "11220", "11230", "11240")
GREEN_CODES = (1, 2, 3, 4)


def _density_distribution(values):
    """Return Tukey box-plot values for exact 10 m focal-density cells."""
    clean = np.asarray(values, dtype=np.float64)
    clean = clean[np.isfinite(clean)]
    if not clean.size:
        return None
    q1, median, q3 = np.quantile(clean, [0.25, 0.5, 0.75], method="linear")
    iqr = q3 - q1
    lower = clean[clean >= q1 - 1.5 * iqr]
    upper = clean[clean <= q3 + 1.5 * iqr]
    return {
        "count": int(clean.size),
        "q1": round(float(q1), 4),
        "median": round(float(median), 4),
        "q3": round(float(q3), 4),
        "whiskerLow": round(float(np.min(lower)), 4),
        "whiskerHigh": round(float(np.max(upper)), 4),
    }


def _scope_statistics(densities, fabric_index, sector_index, sector_meta):
    flat_density = densities.reshape(len(GREEN_CODES), -1)
    flat_fabric = fabric_index.ravel()
    flat_sector = sector_index.ravel()
    scopes = {"region:zennevallei": flat_sector > 0}
    for index, metadata in sector_meta.items():
        scopes[f"sector:{metadata['sectorId']}"] = flat_sector == index
    for municipality in MUNICIPALITIES:
        indexes = [index for index, metadata in sector_meta.items() if metadata["municipality"] == municipality]
        scopes[f"municipality:{municipality}"] = np.isin(flat_sector, indexes)

    result = {}
    for scope_id, scope_mask in scopes.items():
        classes = {}
        for fabric_position, code in enumerate(FABRIC_CODES, start=1):
            selected = scope_mask & (flat_fabric == fabric_position)
            valid = selected & np.all(np.isfinite(flat_density), axis=0)
            count = int(np.count_nonzero(valid))
            density_distributions = {}
            for size in range(1, len(GREEN_CODES) + 1):
                for selected_codes in combinations(GREEN_CODES, size):
                    indexes = [GREEN_CODES.index(code) for code in selected_codes]
                    combined = np.sum(flat_density[indexes][:, valid], axis=0)
                    density_distributions["+".join(map(str, selected_codes))] = _density_distribution(combined)
            classes[code] = {
                "validCellCount": count,
                "validAreaHa": round(count * ANALYSIS_RESOLUTION * ANALYSIS_RESOLUTION / 10_000, 4),
                "meanDensityByGreenClass": {
                    str(green_code): None if not count else round(float(np.mean(flat_density[index][valid])), 4)
                    for index, green_code in enumerate(GREEN_CODES)
                },
                "densityDistributions": density_distributions,
            }
        result[scope_id] = {"classes": classes}
    return result


def _browser_mask(fabric_index, analysis_transform, density_contract):
    bounds = density_contract["boundsEpsg3857"]
    width, height = density_contract["imageSize"]
    transform = from_origin(
        bounds[0], bounds[3],
        (bounds[2] - bounds[0]) / width,
        (bounds[3] - bounds[1]) / height,
    )
    output = np.zeros((height, width), dtype=np.uint8)
    reproject(
        source=fabric_index.astype(np.uint8), destination=output,
        src_transform=analysis_transform, src_crs="EPSG:31370",
        dst_transform=transform, dst_crs="EPSG:3857",
        src_nodata=0, dst_nodata=0, resampling=Resampling.nearest,
    )
    return output


def prepare_groenkaart_urban_atlas():
    if not GROENKAART_MANIFEST.exists() or not GROENKAART_HALO.exists():
        raise FileNotFoundError("Prepare Groenkaart density before preparing this comparison.")
    green_manifest = json.loads(GROENKAART_MANIFEST.read_text(encoding="utf-8"))
    density_contract = green_manifest.get("density")
    if not density_contract or "2021" not in density_contract.get("years", {}):
        raise ValueError("Groenkaart 2021 density is unavailable.")

    sectors = gpd.read_file(SECTORS_PATH).to_crs("EPSG:31370")
    display_bounds = aligned_bounds(sectors.total_bounds)
    analysis_transform = from_origin(display_bounds[0], display_bounds[3], ANALYSIS_RESOLUTION, ANALYSIS_RESOLUTION)
    height = int((display_bounds[3] - display_bounds[1]) / ANALYSIS_RESOLUTION)
    width = int((display_bounds[2] - display_bounds[0]) / ANALYSIS_RESOLUTION)

    fractions, valid = _fraction_grid(GROENKAART_HALO, GREEN_CODES)
    densities, _ = focal_density(fractions, valid, circular_kernel())
    radius_cells = RADIUS_METERS // ANALYSIS_RESOLUTION
    densities = densities[:, radius_cells:-radius_cells, radius_cells:-radius_cells]
    if densities.shape[1:] != (height, width):
        raise ValueError("Groenkaart density and comparison grids are not aligned.")

    urban = gpd.read_file(URBAN_ATLAS_PATH).to_crs("EPSG:31370")
    fabric_lookup = {code: index for index, code in enumerate(FABRIC_CODES, start=1)}
    shapes = [
        (geometry, fabric_lookup[str(code)])
        for geometry, code in zip(urban.geometry, urban["classCode"])
        if str(code) in fabric_lookup
    ]
    fabric_index = rasterize(
        shapes, out_shape=(height, width), transform=analysis_transform,
        fill=0, dtype="uint8", all_touched=False,
    )
    sector_meta = {
        index + 1: {"sectorId": row.sectorId, "municipality": row.municipality}
        for index, row in sectors.iterrows()
    }
    sector_index = rasterize(
        [(row.geometry, index + 1) for index, row in sectors.iterrows()],
        out_shape=(height, width), transform=analysis_transform,
        fill=0, dtype="uint16", all_touched=False,
    )

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    statistics_path = OUTPUT_ROOT / "statistics.json"
    statistics_path.write_text(json.dumps({
        "schemaVersion": 1,
        "comparisonId": COMPARISON_ID,
        "scopes": _scope_statistics(densities, fabric_index, sector_index, sector_meta),
    }, separators=(",", ":")), encoding="utf-8")

    mask = _browser_mask(fabric_index, analysis_transform, density_contract)
    mask_path = OUTPUT_ROOT / "urban-fabric-index.png"
    rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
    rgba[..., 0] = mask
    rgba[..., 3] = 255
    Image.fromarray(rgba, mode="RGBA").save(mask_path, optimize=True)

    urban_manifest = json.loads(URBAN_ATLAS_MANIFEST.read_text(encoding="utf-8"))
    class_by_code = {str(item["code"]): item for item in urban_manifest["classes"]}
    green_class_by_code = {str(item["value"]): item for item in green_manifest["classesOrScale"]["items"]}
    manifest = {
        "schemaVersion": 1,
        "comparisonId": COMPARISON_ID,
        "primaryLayerId": "groenkaart",
        "secondaryLayerId": "urban-atlas",
        "greenMapYear": 2021,
        "urbanAtlasYear": 2021,
        "densityRadiusMeters": 100,
        "analysisResolutionMeters": 10,
        "defaultGreenClasses": [1, 2],
        "defaultFabricClasses": list(FABRIC_CODES),
        "greenClasses": [green_class_by_code[str(code)] for code in GREEN_CODES],
        "fabricClasses": [
            {
                "code": code, "index": fabric_lookup[code],
                "sourceLabel": class_by_code[code]["sourceLabel"], "color": class_by_code[code]["color"],
            }
            for code in FABRIC_CODES
        ],
        "excludedUrbanAtlasCodes": ["11300"],
        "coordinates": density_contract["coordinates"],
        "imageSize": density_contract["imageSize"],
        "densityDataUrl": density_contract["years"]["2021"]["dataUrl"],
        "densityBands": density_contract["bands"],
        "densityEncodingScale": density_contract["encodingScale"],
        "densityNoDataValue": density_contract["noDataValue"],
        "scopeIndexUrl": density_contract["scopeIndexUrl"],
        "municipalityIndexes": density_contract["municipalityIndexes"],
        "fabricMaskUrl": f"{COMPARISON_ID}/{mask_path.name}",
        "statisticsUrl": f"{COMPARISON_ID}/{statistics_path.name}",
        "fabricMaskSha256": file_hash(mask_path),
        "statisticsSha256": file_hash(statistics_path),
        "sources": {
            "groenkaartManifestSha256": file_hash(GROENKAART_MANIFEST),
            "urbanAtlasGeojsonSha256": file_hash(URBAN_ATLAS_PATH),
            "urbanAtlasManifestSha256": file_hash(URBAN_ATLAS_MANIFEST),
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    manifest_path = OUTPUT_ROOT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    update_index()
    return manifest
