"""Contracts for fold-safe XGBoost prediction smoothing."""

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("xgboost")

from greenwave_local_layers.image_regression_smoothing_benchmark import (
    EMBARGO_METERS,
    SIGMA_CANDIDATES_METERS,
    _metric_comparison,
    _sector_bootstrap,
    smooth_masked_predictions,
    smoothing_is_embargo_safe,
    smoothing_support_meters,
)


def test_sigma_zero_is_an_exact_identity_and_inputs_are_not_mutated():
    values = np.asarray([1.0, 3.0, 9.0])
    original = values.copy()
    result = smooth_masked_predictions(values, [2, 2, 2], [2, 3, 4], 0)
    np.testing.assert_array_equal(result, values)
    np.testing.assert_array_equal(values, original)


def test_masked_gaussian_is_normalised_at_boundaries():
    constant = np.full(5, 7.25)
    result = smooth_masked_predictions(constant, [0, 0, 0, 0, 0], range(5), 60)
    np.testing.assert_allclose(result, constant, atol=1e-12)


def test_gaussian_smoothing_uses_predictions_not_observed_targets():
    predictions = np.asarray([0.0, 10.0, 0.0])
    first = smooth_masked_predictions(predictions, [0, 0, 0], [0, 1, 2], 30)
    # Changing an unrelated target vector cannot affect this pure prediction function.
    targets = np.asarray([500.0, -500.0, 500.0])
    second = smooth_masked_predictions(predictions, [0, 0, 0], [0, 1, 2], 30)
    assert targets[0] != predictions[0]
    np.testing.assert_array_equal(first, second)
    assert first[1] < 10.0
    assert first[0] > 0.0


def test_all_candidate_supports_remain_inside_the_spatial_embargo():
    assert EMBARGO_METERS == 200
    assert SIGMA_CANDIDATES_METERS == (0, 15, 30, 45, 60)
    assert smoothing_support_meters(60) == 180
    assert all(smoothing_is_embargo_safe(sigma) for sigma in SIGMA_CANDIDATES_METERS)
    assert not smoothing_is_embargo_safe(75)


def test_sector_bootstrap_is_deterministic_and_requires_complete_rmse_support():
    sectors = np.repeat([f"S{index}" for index in range(12)], 5)
    samples = pd.DataFrame({"sector_id": sectors})
    observed = np.linspace(25, 40, len(samples))
    raw = observed + np.sin(np.arange(len(samples)))
    smoothed = observed + np.sin(np.arange(len(samples))) * .3
    first = _sector_bootstrap(samples, observed, raw, smoothed, draws=1_000, seed=42)
    second = _sector_bootstrap(samples, observed, raw, smoothed, draws=1_000, seed=42)
    assert first == second
    assert first["promoteSmoothing"]
    assert first["smoothedMinusRawCi95"]["rmseC"][1] < 0


def test_duplicate_grid_positions_are_rejected():
    with pytest.raises(ValueError, match="unique"):
        smooth_masked_predictions([1.0, 2.0], [4, 4], [7, 7], 30)


def test_metric_comparison_reports_signed_absolute_and_percentage_changes():
    comparison = _metric_comparison(
        {"rmse_c": 2.0, "mae_c": 1.0, "r2": .5, "mean_error_c": 0.0},
        {"rmse_c": 1.5, "mae_c": .8, "r2": .6, "mean_error_c": -.1},
    )
    assert comparison["rmse_c"] == {"absolute": -.5, "percent": -25.0}
    assert comparison["r2"]["absolute"] == pytest.approx(.1)
    assert comparison["mean_error_c"]["percent"] is None
