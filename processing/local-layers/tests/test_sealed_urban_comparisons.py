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
    exact_area_weighted_sums,
    landsat_display_status,
    ordinary_least_squares,
    sealed_urban_analysis_masks,
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


def test_green_density_uses_exact_sealed_urban_area_weights():
    # The unweighted mean is 50%, but nine eligible 1 m pixels in the first
    # parent cell make the scientifically correct result 18%.
    sums = exact_area_weighted_sums(np.array([[10, 90]], dtype=np.float32), np.array([9, 1]))
    assert sums.tolist() == [180.0]
    assert sums[0] / 10 == 18.0


def test_display_status_is_independent_from_graph_eligibility():
    temperature = np.array([[35.0, 36.0, np.nan, np.nan]], dtype=np.float32)
    status = np.array([[1, 1, 2, 0]], dtype=np.uint8)
    encoded = landsat_display_status(temperature, status)
    assert encoded.tolist() == [[POINT_CLEAR, POINT_CLEAR, POINT_CLOUD, POINT_OTHER_MISSING]]

    masks = sealed_urban_analysis_masks(
        urban=np.array([[True, True, True, True]]),
        soil=np.array([[1, 1, 1, 0]], dtype=np.uint8),
        status=status,
        temperature=temperature,
        density_coverage=np.array([[.9, .2, .9, .9]], dtype=np.float32),
    )
    # The second clear observation remains displayable but is intentionally
    # excluded only from the Green Map scatter. Income has no Green Map gate.
    assert masks["greenClear"].tolist() == [[True, False, False, False]]
    assert masks["incomeClear"].tolist() == [[True, True, False, False]]
