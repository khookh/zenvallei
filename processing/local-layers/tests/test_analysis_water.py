import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from greenwave_local_layers.analysis_water import (
    LAND_USE_WATER_BIT,
    URBAN_ATLAS_WATER_BIT,
    analysis_water_metadata,
    analysis_water_union,
    prepare_analysis_water_context,
)
from greenwave_local_layers.scenario_land_cover import xgboost_land_cover_channels


def _write(path, values, transform):
    with rasterio.open(
            path, "w", driver="GTiff", width=values.shape[1], height=values.shape[0],
            count=1, dtype="uint8", crs="EPSG:31370", transform=transform,
    ) as output:
        output.write(values.astype(np.uint8), 1)


def test_additive_water_context_keeps_ua_and_prioritises_flanders(tmp_path):
    soil = tmp_path / "soil.tif"
    urban = tmp_path / "urban.tif"
    land_use = tmp_path / "land-use.tif"
    sectors = tmp_path / "sectors.geojson"
    destination = tmp_path / "analysis-water.tif"
    _write(soil, np.zeros((20, 20), dtype=np.uint8), from_origin(0, 20, 1, 1))
    urban_values = np.ones((20, 20), dtype=np.uint8)
    urban_values[:10, :10] |= np.uint8(4)
    _write(urban, urban_values, from_origin(0, 20, 1, 1))
    land_use_values = np.zeros((2, 2), dtype=np.uint8)
    land_use_values[0, 1] = 17
    _write(land_use, land_use_values, from_origin(0, 20, 10, 10))
    gpd.GeoDataFrame(
        {"sectorId": ["A"]}, geometry=[box(0, 0, 20, 20)], crs="EPSG:31370",
    ).to_file(sectors, driver="GeoJSON")

    prepared = prepare_analysis_water_context(
        urban, soil, land_use_path=land_use, sectors_path=sectors,
        destination=destination,
    )
    with rasterio.open(prepared) as source:
        encoded = source.read(1)
    assert np.all((encoded[:10, :10] & URBAN_ATLAS_WATER_BIT) != 0)
    assert np.all((encoded[:10, 10:] & LAND_USE_WATER_BIT) != 0)
    assert np.count_nonzero(analysis_water_union(encoded)) == 200
    metadata = analysis_water_metadata(prepared)
    assert metadata["resampling"] == "nearest"
    assert metadata["audit"] == {
        "unit": "ha", "urbanAtlasWaterHa": .01, "landUseWaterHa": .01,
        "intersectionHa": 0.0, "urbanAtlasOnlyHa": .01,
        "landUseOnlyHa": .01, "unionHa": .02,
    }

    green = np.ones((20, 20), dtype=np.uint8)
    sealing = np.ones((20, 20), dtype=np.uint8)
    channels = xgboost_land_cover_channels(green, sealing, analysis_water_union(encoded))
    assert np.all(channels[4, :10, :])
    assert not np.any(channels[:4, :10, :])
    assert np.all(channels.sum(axis=0) <= 1)


def test_source_hash_change_invalidates_cached_water_context(tmp_path):
    soil = tmp_path / "soil.tif"
    urban = tmp_path / "urban.tif"
    land_use = tmp_path / "land-use.tif"
    sectors = tmp_path / "sectors.geojson"
    destination = tmp_path / "analysis-water.tif"
    _write(soil, np.zeros((20, 20), dtype=np.uint8), from_origin(0, 20, 1, 1))
    _write(urban, np.ones((20, 20), dtype=np.uint8), from_origin(0, 20, 1, 1))
    _write(land_use, np.zeros((2, 2), dtype=np.uint8), from_origin(0, 20, 10, 10))
    gpd.GeoDataFrame(
        {"sectorId": ["A"]}, geometry=[box(0, 0, 20, 20)], crs="EPSG:31370",
    ).to_file(sectors, driver="GeoJSON")
    prepare_analysis_water_context(
        urban, soil, land_use_path=land_use, sectors_path=sectors,
        destination=destination,
    )
    first = analysis_water_metadata(destination)["landUseSha256"]
    _write(land_use, np.array([[17, 0], [0, 0]], dtype=np.uint8), from_origin(0, 20, 10, 10))
    prepare_analysis_water_context(
        urban, soil, land_use_path=land_use, sectors_path=sectors,
        destination=destination,
    )
    second = analysis_water_metadata(destination)["landUseSha256"]
    assert first != second
    with rasterio.open(destination) as source:
        assert np.count_nonzero(analysis_water_union(source.read(1))) == 100
