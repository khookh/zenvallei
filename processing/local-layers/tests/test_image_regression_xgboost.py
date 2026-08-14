"""Contracts for compact radial-band XGBoost regression."""

import numpy as np
import pytest

pytest.importorskip("xgboost")

from greenwave_local_layers.image_regression import SpatialFold
from greenwave_local_layers.image_regression_training import InnerValidationSplit
from greenwave_local_layers.image_regression_xgboost import (
    XGBoostConfig,
    train_xgboost_fold,
)
from greenwave_local_layers.image_regression_xgboost_pipeline import (
    bounded_parameter_search,
    outside_training_ranges,
    radial_feature_names,
    select_configuration,
)
import greenwave_local_layers.image_regression_xgboost_pipeline as scenario_pipeline


def _folds():
    outer = SpatialFold(
        fold=0, train_indices=np.arange(80), test_indices=np.arange(80, 120),
        excluded_buffer_indices=np.array([], dtype=np.int64),
        train_sector_ids=("A", "B"), test_sector_ids=("C",), diagnostics={},
    )
    inner = InnerValidationSplit(
        outer_fold=0, fit_indices=np.arange(60), validation_indices=np.arange(60, 80),
        excluded_buffer_indices=np.array([], dtype=np.int64), fit_sector_ids=("A",),
        validation_sector_ids=("B",), diagnostics={},
    )
    return outer, inner


def test_xgboost_fold_uses_inner_partitions_and_returns_raw_test_predictions():
    rng = np.random.default_rng(42)
    features = rng.uniform(0, 1, size=(120, 12)).astype(np.float32)
    targets = (28 + 4 * features[:, 0] - 3 * features[:, 7]).astype(np.float32)
    outer, inner = _folds()
    config = XGBoostConfig(
        num_boost_round=100, early_stopping_rounds=10, learning_rate=0.1,
        max_depth=2, subsample=1.0, colsample_bytree=1.0,
    )
    names = tuple(f"feature_{index}" for index in range(features.shape[1]))
    result = train_xgboost_fold(
        features, targets, outer, inner, names, config, device="cpu", verbose=False,
    )
    assert np.array_equal(result.fit_indices, inner.fit_indices)
    assert np.array_equal(result.validation_indices, inner.validation_indices)
    assert np.array_equal(result.catalog_indices, outer.test_indices)
    assert np.array_equal(result.targets_c, targets[outer.test_indices])
    assert np.all(np.isfinite(result.predictions_c))
    assert result.metrics["count"] == len(outer.test_indices)
    assert 1 <= result.best_round <= result.stopped_round <= config.num_boost_round
    assert set(result.feature_importance_gain) == set(names)


def test_xgboost_fold_rejects_test_leakage():
    features = np.zeros((120, 12), dtype=np.float32)
    targets = np.arange(120, dtype=np.float32)
    outer, inner = _folds()
    leaking = InnerValidationSplit(
        outer_fold=0, fit_indices=np.arange(60), validation_indices=np.array([80]),
        excluded_buffer_indices=np.array([], dtype=np.int64), fit_sector_ids=("A",),
        validation_sector_ids=("C",), diagnostics={},
    )
    with pytest.raises(ValueError, match="outer training"):
        train_xgboost_fold(
            features, targets, outer, leaking,
            tuple(f"feature_{index}" for index in range(12)),
            XGBoostConfig(num_boost_round=2, early_stopping_rounds=1),
            device="cpu", verbose=False,
        )


def test_scenario_search_is_bounded_deterministic_and_uses_twenty_physical_features():
    assert radial_feature_names() == tuple(
        f"{channel}_{lower}_{upper}m"
        for channel in ("soil_sealing", "high_green", "low_green", "agriculture", "water")
        for lower, upper in ((0, 25), (25, 50), (50, 75), (75, 100))
    )
    first = bounded_parameter_search()
    second = bounded_parameter_search()
    assert first == second
    assert 1 < len(first) <= 32
    assert len({
        (item.learning_rate, item.max_depth, item.min_child_weight, item.subsample,
         item.colsample_bytree, item.reg_alpha, item.reg_lambda)
        for item in first
    }) == len(first)


def test_configuration_near_ties_prefer_the_simpler_tree(monkeypatch):
    complex_config = XGBoostConfig(max_depth=6, min_child_weight=1, learning_rate=.05)
    simple_config = XGBoostConfig(max_depth=3, min_child_weight=3, learning_rate=.05)

    def fake_evaluation(_features, _targets, _names, _folds, config, **_kwargs):
        return {
            "meanRmseC": 2.0 if config.max_depth == 6 else 2.003,
            "bestRounds": [25], "folds": [],
        }

    monkeypatch.setattr(scenario_pipeline, "evaluate_configuration", fake_evaluation)
    selected, tested = select_configuration(
        np.zeros((2, 1), dtype=np.float32), np.zeros(2, dtype=np.float32),
        ("feature",), (), (complex_config, simple_config), device="cpu",
    )
    assert len(tested) == 2
    assert selected["config"] == simple_config


def test_counterfactual_rows_outside_training_ranges_are_flagged():
    features = np.array([[.2, .5], [.1, .8], [.4, .3]], dtype=np.float32)
    outside = outside_training_ranges(
        features, ("soil", "green"), {"soil": [.1, .4], "green": [.3, .7]},
    )
    assert outside.tolist() == [False, True, False]
