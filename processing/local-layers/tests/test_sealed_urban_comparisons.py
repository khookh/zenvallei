"""Scientific contracts for the sealed urban-fabric comparisons."""

import numpy as np

from greenwave_local_layers.sealed_urban_comparisons import (
    DEFAULT_GREEN_CLASSES,
    EXCLUDED_URBAN_CODE,
    GREEN_CLASS_CODES,
    MINIMUM_LANDSAT_GREEN_COVERAGE,
    MINIMUM_NATIVE_JAARBAK_COVERAGE,
    POINT_CLEAR,
    POINT_CLOUD,
    POINT_OTHER_MISSING,
    URBAN_FABRIC_CODES,
    _combination_key,
    _green_combinations,
    ordinary_least_squares,
)


def test_surface_and_green_class_contract_is_exact():
    assert URBAN_FABRIC_CODES == ("11100", "11210", "11220", "11230", "11240")
    assert EXCLUDED_URBAN_CODE == "11300"
    assert GREEN_CLASS_CODES == (1, 2, 3, 4)
    assert DEFAULT_GREEN_CLASSES == (1, 2)
    assert MINIMUM_LANDSAT_GREEN_COVERAGE == 0.80
    assert MINIMUM_NATIVE_JAARBAK_COVERAGE == 0.95
    assert (POINT_CLEAR, POINT_CLOUD, POINT_OTHER_MISSING) == (255, 254, 253)


def test_every_non_empty_green_map_combination_is_prepared_once():
    combinations = _green_combinations()
    assert len(combinations) == 15
    assert len({_combination_key(item) for item in combinations}) == 15
    assert (1,) in combinations
    assert (1, 2, 3, 4) in combinations


def test_ordinary_least_squares_is_deterministic():
    result = ordinary_least_squares([10, 20, 30, np.nan], [2, 4, 6, 999])
    assert result == {
        "count": 3,
        "slope": 0.2,
        "intercept": 0.0,
        "rSquared": 1.0,
        "xMinimum": 10.0,
        "xMaximum": 30.0,
        "yMinimum": 2.0,
        "yMaximum": 6.0,
    }


def test_regression_rejects_small_or_zero_variance_samples():
    assert ordinary_least_squares([1, 2], [3, 4]) is None
    assert ordinary_least_squares([5, 5, 5], [1, 2, 3]) is None
