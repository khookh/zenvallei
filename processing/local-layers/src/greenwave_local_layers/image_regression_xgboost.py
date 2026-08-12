"""XGBoost regression on compact radial land-cover fractions."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import xgboost as xgb

from .image_regression import SpatialFold
from .image_regression_training import InnerValidationSplit, regression_metrics


@dataclass(frozen=True)
class XGBoostConfig:
    """One fixed illustrative tree-boosting recipe without parameter tuning."""

    num_boost_round: int = 2_000
    early_stopping_rounds: int = 50
    learning_rate: float = 0.05
    max_depth: int = 4
    min_child_weight: float = 1.0
    subsample: float = 0.8
    colsample_bytree: float = 0.8
    reg_alpha: float = 0.0
    reg_lambda: float = 1.0
    seed: int = 42


@dataclass
class XGBoostFoldResult:
    outer_fold: int
    booster: xgb.Booster
    history: tuple[dict, ...]
    metrics: dict
    predictions_c: np.ndarray
    targets_c: np.ndarray
    catalog_indices: np.ndarray
    fit_indices: np.ndarray
    validation_indices: np.ndarray
    feature_names: tuple[str, ...]
    feature_importance_gain: dict[str, float]
    device: str
    best_round: int
    stopped_round: int
    best_validation_rmse_c: float


def train_xgboost_fold(
        features, targets_c, outer_fold: SpatialFold,
        inner_split: InnerValidationSplit, feature_names,
        config: XGBoostConfig = XGBoostConfig(), *,
        device: str = "cuda", verbose: bool = True) -> XGBoostFoldResult:
    """Fit on the inner partition and predict one untouched outer test fold."""
    values = np.asarray(features, dtype=np.float32)
    targets = np.asarray(targets_c, dtype=np.float32)
    names = tuple(str(name) for name in feature_names)
    if values.ndim != 2 or targets.ndim != 1 or len(values) != len(targets):
        raise ValueError("Features and targets must be aligned two- and one-dimensional arrays.")
    if not np.all(np.isfinite(values)) or not np.all(np.isfinite(targets)):
        raise ValueError("XGBoost features and targets must be finite.")
    if len(names) != values.shape[1] or len(set(names)) != len(names):
        raise ValueError("Feature names must be unique and match the feature columns.")
    if inner_split.outer_fold != outer_fold.fold:
        raise ValueError("The inner validation split belongs to another outer fold.")
    if config.num_boost_round <= 0 or config.early_stopping_rounds <= 0:
        raise ValueError("Boosting and early-stopping round counts must be positive.")
    if config.learning_rate <= 0 or config.max_depth <= 0:
        raise ValueError("Learning rate and maximum depth must be positive.")
    for parameter_name, parameter_value in (
            ("subsample", config.subsample), ("colsample_bytree", config.colsample_bytree)):
        if not 0 < parameter_value <= 1:
            raise ValueError(f"{parameter_name} must lie in (0, 1].")

    fit_indices = np.asarray(inner_split.fit_indices, dtype=np.int64)
    validation_indices = np.asarray(inner_split.validation_indices, dtype=np.int64)
    test_indices = np.asarray(outer_fold.test_indices, dtype=np.int64)
    all_indices = np.concatenate((fit_indices, validation_indices, test_indices))
    if np.any(all_indices < 0) or np.any(all_indices >= len(values)):
        raise IndexError("A split contains an out-of-range feature index.")
    if not set(fit_indices).issubset(outer_fold.train_indices) \
            or not set(validation_indices).issubset(outer_fold.train_indices):
        raise ValueError("Fitting and validation indices must come from outer training.")
    if set(fit_indices).intersection(validation_indices) \
            or set(fit_indices).intersection(test_indices) \
            or set(validation_indices).intersection(test_indices):
        raise ValueError("Fitting, validation, and test indices must be disjoint.")

    fit_matrix = xgb.DMatrix(
        values[fit_indices], label=targets[fit_indices], feature_names=list(names),
    )
    validation_matrix = xgb.DMatrix(
        values[validation_indices], label=targets[validation_indices], feature_names=list(names),
    )
    parameters = {
        "objective": "reg:squarederror",
        "eval_metric": "rmse",
        "tree_method": "hist",
        "device": str(device),
        "eta": config.learning_rate,
        "max_depth": config.max_depth,
        "min_child_weight": config.min_child_weight,
        "subsample": config.subsample,
        "colsample_bytree": config.colsample_bytree,
        "alpha": config.reg_alpha,
        "lambda": config.reg_lambda,
        "seed": config.seed,
        "verbosity": 0,
    }
    evaluation_history = {}
    booster = xgb.train(
        parameters, fit_matrix, num_boost_round=config.num_boost_round,
        evals=[(fit_matrix, "fit"), (validation_matrix, "validation")],
        early_stopping_rounds=config.early_stopping_rounds,
        evals_result=evaluation_history,
        verbose_eval=100 if verbose else False,
    )
    best_iteration = int(booster.best_iteration)
    stopped_round = len(evaluation_history["validation"]["rmse"])
    history = tuple({
        "round": round_index + 1,
        "fit_rmse_c": float(evaluation_history["fit"]["rmse"][round_index]),
        "validation_rmse_c": float(evaluation_history["validation"]["rmse"][round_index]),
    } for round_index in range(stopped_round))
    test_matrix = xgb.DMatrix(values[test_indices], feature_names=list(names))
    predictions = booster.predict(
        test_matrix, iteration_range=(0, best_iteration + 1),
    ).astype(np.float32, copy=False)
    test_targets = targets[test_indices].astype(np.float32, copy=False)
    importance = booster.get_score(importance_type="gain")
    return XGBoostFoldResult(
        outer_fold=int(outer_fold.fold), booster=booster, history=history,
        metrics=regression_metrics(test_targets, predictions), predictions_c=predictions,
        targets_c=test_targets, catalog_indices=test_indices.copy(),
        fit_indices=fit_indices.copy(), validation_indices=validation_indices.copy(),
        feature_names=names,
        feature_importance_gain={name: float(importance.get(name, 0.0)) for name in names},
        device=str(device), best_round=best_iteration + 1, stopped_round=stopped_round,
        best_validation_rmse_c=float(booster.best_score),
    )
