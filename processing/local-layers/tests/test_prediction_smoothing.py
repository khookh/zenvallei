import numpy as np
import pytest

from greenwave_local_layers.prediction_smoothing import (
    smooth_masked_predictions,
    smoothing_is_embargo_safe,
    smoothing_support_meters,
)


def test_sigma_zero_is_identity_without_mutation():
    values = np.asarray([1.0, 3.0, 9.0])
    original = values.copy()
    result = smooth_masked_predictions(values, [2, 2, 2], [2, 3, 4], 0)
    np.testing.assert_array_equal(result, values)
    np.testing.assert_array_equal(values, original)


def test_masked_gaussian_is_normalised_at_boundaries():
    constant = np.full(5, 7.25)
    result = smooth_masked_predictions(constant, [0] * 5, range(5), 60)
    np.testing.assert_allclose(result, constant, atol=1e-12)


def test_smoothing_uses_predictions_and_rejects_duplicate_positions():
    result = smooth_masked_predictions([0.0, 10.0, 0.0], [0, 0, 0], [0, 1, 2], 30)
    assert result[1] < 10.0
    assert result[0] > 0.0
    with pytest.raises(ValueError, match="unique"):
        smooth_masked_predictions([1.0, 2.0], [4, 4], [7, 7], 30)


def test_smoothing_support_stays_inside_spatial_embargo():
    assert smoothing_support_meters(60) == 180
    assert smoothing_is_embargo_safe(60, 200)
    assert not smoothing_is_embargo_safe(75, 200)
