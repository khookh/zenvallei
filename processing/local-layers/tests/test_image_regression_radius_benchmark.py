"""Contracts for the isolated 100/150/200 m XGBoost benchmark."""

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("xgboost")

from greenwave_local_layers.image_regression_radius_benchmark import (
    BENCHMARK_ROOT,
    EMBARGO_METERS,
    RADII_METERS,
    benchmark_feature_names,
    disk_row_spans,
    disk_sums_from_prefix,
    feature_count_for_radius,
    feature_view_for_radius,
    paired_sector_bootstrap,
    verify_support_separation,
)
from greenwave_local_layers.image_regression_xgboost_pipeline import MODEL_ROOT


def test_radius_feature_contract_uses_exact_ring_major_prefixes():
    names = benchmark_feature_names()
    assert RADII_METERS == (100, 150, 200)
    assert [feature_count_for_radius(radius) for radius in RADII_METERS] == [20, 30, 40]
    assert names[:5] == (
        "soil_sealing_0_25m", "high_green_0_25m", "low_green_0_25m",
        "agriculture_0_25m", "water_0_25m",
    )
    values = np.arange(4 * 40, dtype=np.float32).reshape(4, 40)
    for radius, count in ((100, 20), (150, 30), (200, 40)):
        view, selected_names = feature_view_for_radius(values, names, radius)
        assert np.shares_memory(view, values)
        assert np.array_equal(view, values[:, :count])
        assert selected_names == names[:count]


def test_exact_disk_sums_match_brute_force_pixel_centres():
    raster = np.zeros((18, 19), dtype=np.uint8)
    raster[3:15, 4:17] = np.indices((12, 13)).sum(axis=0) % 2
    prefix = np.pad(np.cumsum(raster, axis=1, dtype=np.uint32), ((0, 0), (1, 0)))
    rows = np.asarray([7, 10], dtype=np.int32)
    columns = np.asarray([8, 12], dtype=np.int32)
    radius = 4
    actual = disk_sums_from_prefix(prefix, rows, columns, radius)
    spans = disk_row_spans(radius)
    expected = []
    for row, column in zip(rows, columns):
        patch = raster[row - radius:row + radius, column - radius:column + radius]
        mask = np.zeros_like(patch, dtype=bool)
        for dy, (start, stop) in enumerate(spans):
            mask[dy, start:stop] = True
        expected.append(int(patch[mask].sum()))
    assert actual.tolist() == expected


def _bootstrap_fixture(constant_target=False):
    sector_ids = np.repeat([f"S{index:03d}" for index in range(12)], 4)
    observed = np.ones(len(sector_ids), dtype=np.float64) if constant_target else np.linspace(25, 40, len(sector_ids))
    samples = pd.DataFrame({"sector_id": sector_ids})
    predictions = {
        100: observed + np.sin(np.arange(len(observed))) * .8,
        150: observed + np.sin(np.arange(len(observed))) * .6,
        200: observed + np.sin(np.arange(len(observed))) * .4,
    }
    return samples, observed, predictions


def test_paired_sector_bootstrap_is_deterministic_and_paired():
    inputs = _bootstrap_fixture()
    first = paired_sector_bootstrap(*inputs, draws=500, seed=42)
    second = paired_sector_bootstrap(*inputs, draws=500, seed=42)
    assert first == second
    assert first["sectorCount"] == 12
    assert set(first["comparisons"]) == {"150m-vs-100m", "200m-vs-100m", "200m-vs-150m"}
    assert first["comparisons"]["200m-vs-100m"]["rmseImprovementC"] > 0


def test_paired_bootstrap_handles_zero_target_variance_without_false_r2():
    result = paired_sector_bootstrap(*_bootstrap_fixture(constant_target=True), draws=50)
    comparison = result["comparisons"]["150m-vs-100m"]
    assert comparison["metrics"]["r2"]["candidateMinusBaseline"] is None
    assert comparison["metrics"]["r2"]["ci95"] is None


def test_benchmark_cache_is_isolated_and_uses_largest_support_embargo():
    assert EMBARGO_METERS == 400
    assert BENCHMARK_ROOT != MODEL_ROOT
    assert MODEL_ROOT not in BENCHMARK_ROOT.parents


def test_support_separation_rejects_overlapping_radius_disks():
    samples = pd.DataFrame({
        "x_lambert": [0.0, 500.0, 350.0],
        "y_lambert": [0.0, 0.0, 0.0],
    })
    assert verify_support_separation(samples, [1], [0], 400) == 500.0
    with pytest.raises(AssertionError, match="overlaps"):
        verify_support_separation(samples, [2], [0], 400)
