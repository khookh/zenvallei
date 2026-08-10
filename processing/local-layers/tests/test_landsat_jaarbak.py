"""Truth-table tests for the Landsat x JaarBAK comparison."""

import geopandas as gpd
import numpy as np
from rasterio import Affine
from shapely.geometry import box

from greenwave_local_layers.landsat_jaarbak import (
    YEAR_BY_OBSERVATION,
    classify_soil_pixels,
    display_scope_indexes,
)
from greenwave_local_layers.landsat_urban_atlas import _subpixel_majority


def test_jaarbak_majority_truth_table():
    coverage = np.array([1, 1, 1, .5, .499, 1, np.nan], dtype=np.float32)
    sealed = np.array([.51, .49, .5, .75, .9, np.nan, .8], dtype=np.float32)
    assert classify_soil_pixels(coverage, sealed).tolist() == [1, 2, 0, 1, 0, 0, 0]


def test_observation_year_mapping_is_exact():
    assert YEAR_BY_OBSERVATION == {
        "landsat-2020-08-07": 2020,
        "landsat-2022-08-14": 2022,
        "landsat-2023-06-13": 2023,
        "landsat-2023-09-09": 2023,
        "landsat-2025-08-13": 2024,
        "landsat-2026-06-22": 2024,
    }


def test_display_scope_dissolves_internal_sector_boundaries():
    grid = {
        "width": 1,
        "height": 1,
        "transform": Affine.translation(0, 30) * Affine.scale(30, -30),
        "crs": "EPSG:32631",
    }
    sectors = gpd.GeoDataFrame({
        "sectorId": ["left", "right"],
        "municipality": ["Halle", "Halle"],
        "geometry": [box(0, 0, 15, 30), box(15, 0, 30, 30)],
    }, crs=grid["crs"])
    analytical_sector = _subpixel_majority(
        ((geometry, index + 1) for index, geometry in enumerate(sectors.geometry)), grid,
    )
    region, municipality, municipality_lookup = display_scope_indexes(sectors, grid)

    assert analytical_sector[0, 0] == 0  # intentional statistical tie
    assert region[0, 0] == 1  # no visual hole inside the dissolved region
    assert municipality[0, 0] == municipality_lookup["Halle"]
