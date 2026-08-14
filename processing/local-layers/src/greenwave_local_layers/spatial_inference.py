"""Spatially adjusted inference for the dashboard's bivariate regressions.

The implementation follows ``SpatialPack::modified.ttest`` (CRH/Dutilleul):
Pearson's correlation is left unchanged while its effective sample size is
estimated from 13 distance-class Moran coefficients for both spatial fields.
The lattice implementation evaluates the same equations with FFT
autocorrelations, avoiding an intractable all-pairs matrix for Landsat grids.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from affine import Affine
from scipy.signal import fftconvolve
from scipy.spatial import ConvexHull, QhullError, distance
from scipy.stats import f as f_distribution


METHOD = "crh-dutilleul-modified-t"
HYPOTHESIS = "pearson-r-equals-zero"
SIDEDNESS = "two-sided"
DISTANCE_CLASS_COUNT = 13
MINIMUM_OBSERVATIONS = 10
MINIMUM_EFFECTIVE_SAMPLE = 10.0


def _unavailable(status: str, *, count: int, effective_sample_size=None, nclass=DISTANCE_CLASS_COUNT):
    return {
        "method": METHOD,
        "hypothesis": HYPOTHESIS,
        "sidedness": SIDEDNESS,
        "pValue": None,
        "effectiveSampleSize": (
            None if effective_sample_size is None or not np.isfinite(effective_sample_size)
            else round(float(effective_sample_size), 8)
        ),
        "distanceClassCount": int(nclass),
        "observationCount": int(count),
        "status": status,
    }


def _finish(correlation: float, effective_sample_size: float, count: int, nclass: int):
    if not np.isfinite(effective_sample_size):
        return _unavailable("numerical-failure", count=count, nclass=nclass)
    if effective_sample_size < MINIMUM_EFFECTIVE_SAMPLE:
        return _unavailable(
            "insufficient-effective-sample", count=count,
            effective_sample_size=effective_sample_size, nclass=nclass,
        )
    degrees_of_freedom = effective_sample_size - 2.0
    squared = min(1.0 - np.finfo(np.float64).eps, float(correlation) ** 2)
    statistic = degrees_of_freedom * squared / (1.0 - squared)
    p_value = float(f_distribution.sf(statistic, 1.0, degrees_of_freedom))
    if not np.isfinite(p_value):
        return _unavailable(
            "numerical-failure", count=count,
            effective_sample_size=effective_sample_size, nclass=nclass,
        )
    return {
        "method": METHOD,
        "hypothesis": HYPOTHESIS,
        "sidedness": SIDEDNESS,
        "pValue": round(p_value, 12),
        "effectiveSampleSize": round(float(effective_sample_size), 8),
        "distanceClassCount": int(nclass),
        "observationCount": int(count),
        "status": "available",
    }


def _effective_sample_size(correlation_x, correlation_y, row_counts, pair_counts):
    """Evaluate SpatialPack's matrix-trace ESS equations without dense matrices."""
    count = row_counts.shape[0]
    row_x = 1.0 + row_counts @ correlation_x
    row_y = 1.0 + row_counts @ correlation_y
    sum_x = float(np.sum(row_x))
    sum_y = float(np.sum(row_y))
    sum_xy = float(np.dot(row_x, row_y))
    trace_xy = float(count + 2.0 * np.dot(pair_counts, correlation_x * correlation_y))
    trace_x = count - sum_x / count
    trace_y = count - sum_y / count
    centered_trace_xy = trace_xy + (sum_x * sum_y / count - 2.0 * sum_xy) / count
    if centered_trace_xy == 0:
        return np.nan
    return trace_x * trace_y / centered_trace_xy + 1.0


def spatial_modified_t_test(x_values, y_values, coordinates, *, nclass=DISTANCE_CLASS_COUNT):
    """Direct CRH/Dutilleul test for the small sector-centroid regressions."""
    x = np.asarray(x_values, dtype=np.float64)
    y = np.asarray(y_values, dtype=np.float64)
    coords = np.asarray(coordinates, dtype=np.float64)
    valid = np.isfinite(x) & np.isfinite(y) & np.all(np.isfinite(coords[:, :2]), axis=1)
    x, y, coords = x[valid], y[valid], coords[valid, :2]
    count = int(x.size)
    if count < MINIMUM_OBSERVATIONS:
        return _unavailable("insufficient-observations", count=count, nclass=nclass)
    # SpatialPack's fastmatrix covariance routine returns the second central
    # moment (divisor n), which is required for fixture-identical Moran values.
    variance_x = float(np.var(x, ddof=0))
    variance_y = float(np.var(y, ddof=0))
    if variance_x <= 0 or variance_y <= 0:
        return _unavailable("undefined-variance", count=count, nclass=nclass)

    pair_distances = distance.pdist(coords)
    maximum_distance = float(np.max(pair_distances)) if pair_distances.size else 0.0
    if maximum_distance <= 0:
        return _unavailable("undefined-spatial-structure", count=count, nclass=nclass)
    upper_bounds = maximum_distance / nclass * np.arange(1, nclass + 1)
    classes = np.searchsorted(upper_bounds, pair_distances, side="left")
    classes = np.minimum(classes, nclass - 1)
    pair_counts = np.bincount(classes, minlength=nclass).astype(np.float64)
    if np.any(pair_counts == 0):
        return _unavailable("insufficient-distance-classes", count=count, nclass=nclass)

    left, right = np.triu_indices(count, 1)
    centered_x = x - np.mean(x)
    centered_y = y - np.mean(y)
    covariance_x = np.bincount(
        classes, weights=centered_x[left] * centered_x[right], minlength=nclass,
    ) / pair_counts
    covariance_y = np.bincount(
        classes, weights=centered_y[left] * centered_y[right], minlength=nclass,
    ) / pair_counts
    moran_x = covariance_x / variance_x
    moran_y = covariance_y / variance_y

    row_counts = np.zeros((count, nclass), dtype=np.float64)
    np.add.at(row_counts, (left, classes), 1.0)
    np.add.at(row_counts, (right, classes), 1.0)
    effective = _effective_sample_size(moran_x, moran_y, row_counts, pair_counts)
    correlation = float(np.corrcoef(x, y)[0, 1])
    return _finish(correlation, effective, count, nclass)


def _physical_coordinates(rows, columns, transform):
    x = transform.c + (columns + 0.5) * transform.a + (rows + 0.5) * transform.b
    y = transform.f + (columns + 0.5) * transform.d + (rows + 0.5) * transform.e
    return np.column_stack((x, y))


def _maximum_pair_distance(coordinates):
    centered = coordinates - coordinates[0]
    if np.linalg.matrix_rank(centered) < 2:
        _, _, vectors = np.linalg.svd(centered, full_matrices=False)
        projected = centered @ vectors[0]
        return float(np.max(projected) - np.min(projected))
    try:
        hull = ConvexHull(coordinates)
        boundary = coordinates[hull.vertices]
    except QhullError:
        boundary = coordinates
    return float(np.max(distance.pdist(boundary)))


def _lag_classes(shape, transform, maximum_distance, nclass):
    height, width = shape
    row_offsets = np.arange(-(height - 1), height)
    column_offsets = np.arange(-(width - 1), width)
    delta_columns, delta_rows = np.meshgrid(column_offsets, row_offsets)
    delta_x = delta_columns * transform.a + delta_rows * transform.b
    delta_y = delta_columns * transform.d + delta_rows * transform.e
    distances = np.hypot(delta_x, delta_y)
    upper_bounds = maximum_distance / nclass * np.arange(1, nclass + 1)
    classes = np.searchsorted(upper_bounds, distances, side="left")
    classes = np.minimum(classes, nclass - 1).astype(np.int16)
    classes[height - 1, width - 1] = -1
    return classes


def _moran_from_lattice(values, valid, lag_classes, pair_counts, variance, nclass):
    centered = np.zeros(valid.shape, dtype=np.float64)
    centered[valid] = values[valid] - np.mean(values[valid])
    autocorrelation = fftconvolve(centered, centered[::-1, ::-1], mode="full")
    selected = lag_classes >= 0
    sums = np.bincount(
        lag_classes[selected], weights=autocorrelation[selected], minlength=nclass,
    )
    # Full autocorrelation contains both directions; its ratio to the directed
    # pair count is the same covariance used by SpatialPack's unordered loop.
    return (sums / (pair_counts * 2.0)) / variance


@dataclass
class LatticeSpatialSupport:
    """Reusable geometry and response-field terms for one masked raster scope."""

    valid: np.ndarray
    y_values: np.ndarray
    transform: Affine
    lag_classes: np.ndarray
    pair_counts: np.ndarray
    row_counts: np.ndarray
    moran_y: np.ndarray
    nclass: int
    original_slices: tuple[slice, slice]

    def inference(self, x_grid):
        x_full = np.asarray(x_grid, dtype=np.float64)
        x = x_full[self.original_slices]
        valid = self.valid & np.isfinite(x)
        count = int(np.count_nonzero(valid))
        if count != int(np.count_nonzero(self.valid)):
            # The cached row counts are valid only for the support used when it
            # was prepared. Rebuild when a selector changes data availability.
            return spatial_modified_t_test_lattice(
                x, self.y_values, valid, self.transform, nclass=self.nclass,
            )
        variance_x = float(np.var(x[valid], ddof=0))
        if variance_x <= 0:
            return _unavailable("undefined-variance", count=count, nclass=self.nclass)
        moran_x = _moran_from_lattice(
            x, valid, self.lag_classes, self.pair_counts, variance_x, self.nclass,
        )
        if not np.all(np.isfinite(moran_x)):
            return _unavailable("numerical-failure", count=count, nclass=self.nclass)
        effective = _effective_sample_size(
            moran_x, self.moran_y, self.row_counts, self.pair_counts,
        )
        correlation = float(np.corrcoef(x[valid], self.y_values[valid])[0, 1])
        return _finish(correlation, effective, count, self.nclass)


def prepare_lattice_spatial_support(y_grid, valid_mask, transform, *, nclass=DISTANCE_CLASS_COUNT):
    """Prepare FFT distance-class terms for one exact raster support."""
    y_full = np.asarray(y_grid, dtype=np.float64)
    valid_full = np.asarray(valid_mask, dtype=bool) & np.isfinite(y_full)
    count = int(np.count_nonzero(valid_full))
    if count < MINIMUM_OBSERVATIONS:
        return _unavailable("insufficient-observations", count=count, nclass=nclass)
    variance_y = float(np.var(y_full[valid_full], ddof=0))
    if variance_y <= 0:
        return _unavailable("undefined-variance", count=count, nclass=nclass)

    rows, columns = np.nonzero(valid_full)
    row_slice = slice(int(rows.min()), int(rows.max()) + 1)
    column_slice = slice(int(columns.min()), int(columns.max()) + 1)
    slices = (row_slice, column_slice)
    valid = valid_full[slices]
    y_values = y_full[slices]
    cropped_transform = transform * Affine.translation(column_slice.start, row_slice.start)
    coordinates = _physical_coordinates(*np.nonzero(valid), cropped_transform)
    maximum_distance = _maximum_pair_distance(coordinates)
    if maximum_distance <= 0:
        return _unavailable("undefined-spatial-structure", count=count, nclass=nclass)

    lag_classes = _lag_classes(valid.shape, cropped_transform, maximum_distance, nclass)
    overlap = fftconvolve(valid.astype(np.float64), valid[::-1, ::-1].astype(np.float64), mode="full")
    selected = lag_classes >= 0
    directed_counts = np.bincount(
        lag_classes[selected], weights=overlap[selected], minlength=nclass,
    )
    pair_counts = np.rint(directed_counts / 2.0)
    if np.any(pair_counts <= 0):
        return _unavailable("insufficient-distance-classes", count=count, nclass=nclass)

    row_counts = np.empty((count, nclass), dtype=np.float64)
    for class_index in range(nclass):
        kernel = (lag_classes == class_index).astype(np.float64)
        neighbourhood = fftconvolve(valid.astype(np.float64), kernel, mode="same")
        row_counts[:, class_index] = np.rint(neighbourhood[valid])
    moran_y = _moran_from_lattice(
        y_values, valid, lag_classes, pair_counts, variance_y, nclass,
    )
    if not np.all(np.isfinite(moran_y)):
        return _unavailable("numerical-failure", count=count, nclass=nclass)
    return LatticeSpatialSupport(
        valid=valid, y_values=y_values, transform=cropped_transform,
        lag_classes=lag_classes, pair_counts=pair_counts, row_counts=row_counts,
        moran_y=moran_y, nclass=nclass, original_slices=slices,
    )


def spatial_modified_t_test_lattice(x_grid, y_grid, valid_mask, transform, *, nclass=DISTANCE_CLASS_COUNT):
    """CRH/Dutilleul test for aligned regular grids using FFT pair aggregation."""
    support = prepare_lattice_spatial_support(y_grid, valid_mask, transform, nclass=nclass)
    if isinstance(support, dict):
        return support
    return support.inference(x_grid)
