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
