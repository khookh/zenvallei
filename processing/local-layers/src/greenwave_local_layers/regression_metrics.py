"""Regression metrics shared by training, validation, and notebook diagnostics."""

from __future__ import annotations

import numpy as np


def regression_metrics(targets_c, predictions_c) -> dict:
    """Return raw-Celsius metrics for aligned observed and predicted values."""
    targets = np.asarray(targets_c, dtype=np.float64)
    predictions = np.asarray(predictions_c, dtype=np.float64)
    if targets.shape != predictions.shape or targets.ndim != 1 or not len(targets):
        raise ValueError("Regression metrics require equally shaped non-empty vectors.")
    if not np.all(np.isfinite(targets)) or not np.all(np.isfinite(predictions)):
        raise ValueError("Regression metrics require finite values.")
    residuals = predictions - targets
    squared_error = float(np.sum(residuals ** 2))
    total_variance = float(np.sum((targets - np.mean(targets)) ** 2))
    return {
        "count": int(len(targets)),
        "mae_c": float(np.mean(np.abs(residuals))),
        "rmse_c": float(np.sqrt(np.mean(residuals ** 2))),
        "r2": None if total_variance <= 0 else float(1.0 - squared_error / total_variance),
        "mean_error_c": float(np.mean(residuals)),
    }
