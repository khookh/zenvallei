"""Truth-table tests for the local Landsat x JaarBAK comparison."""

import numpy as np

from greenwave_local_layers.landsat_jaarbak import YEAR_BY_OBSERVATION, classify_soil_pixels


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
