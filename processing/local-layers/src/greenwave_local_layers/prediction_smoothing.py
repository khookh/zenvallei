"""Mask-normalised smoothing used by validation and scenario inference."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter


GRID_RESOLUTION_METERS = 30
KERNEL_TRUNCATION_SIGMA = 3


def smooth_masked_predictions(predictions, rows, columns, sigma_meters):
    """Smooth sparse aligned predictions without borrowing values across gaps."""
    values = np.asarray(predictions, dtype=np.float64)
    rows = np.asarray(rows, dtype=np.int64)
    columns = np.asarray(columns, dtype=np.int64)
    if values.ndim != 1 or rows.shape != values.shape or columns.shape != values.shape:
        raise ValueError("Predictions and grid positions must be aligned vectors.")
    if len(values) != len(set(zip(rows.tolist(), columns.tolist()))):
        raise ValueError("Prediction grid positions must be unique.")
    sigma = float(sigma_meters)
    if sigma < 0:
        raise ValueError("Gaussian sigma cannot be negative.")
    if sigma == 0 or not len(values):
        return values.copy()
    sigma_pixels = sigma / GRID_RESOLUTION_METERS
    radius = int(np.ceil(KERNEL_TRUNCATION_SIGMA * sigma_pixels))
    row_min, row_max = int(rows.min()) - radius, int(rows.max()) + radius
    col_min, col_max = int(columns.min()) - radius, int(columns.max()) + radius
    shape = (row_max - row_min + 1, col_max - col_min + 1)
    numerator = np.zeros(shape, dtype=np.float64)
    weights = np.zeros(shape, dtype=np.float64)
    local_rows = rows - row_min
    local_columns = columns - col_min
    numerator[local_rows, local_columns] = values
    weights[local_rows, local_columns] = 1.0
    filtered = gaussian_filter(
        numerator, sigma=sigma_pixels, mode="constant", cval=0.0, radius=radius,
    )
    normaliser = gaussian_filter(
        weights, sigma=sigma_pixels, mode="constant", cval=0.0, radius=radius,
    )
    selected_weights = normaliser[local_rows, local_columns]
    if np.any(selected_weights <= 0):
        raise AssertionError("Masked Gaussian smoothing lost a prediction centre.")
    return filtered[local_rows, local_columns] / selected_weights


def smoothing_support_meters(sigma_meters):
    """Return the truncated Gaussian support radius in metres."""
    return int(np.ceil(float(sigma_meters) * KERNEL_TRUNCATION_SIGMA))


def smoothing_is_embargo_safe(sigma_meters, embargo_meters=200):
    """Check that smoothing support remains inside the spatial embargo."""
    return smoothing_support_meters(sigma_meters) <= int(embargo_meters)
