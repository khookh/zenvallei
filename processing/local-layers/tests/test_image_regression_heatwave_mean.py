"""Contracts for the strict six-acquisition heatwave-mean target."""

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from greenwave_local_layers.image_regression_heatwave_mean import (
    EXPECTED_SAMPLE_COUNT,
    EXPECTED_SECTOR_COUNT,
    HEATWAVE_OBSERVATION_IDS,
    MANIFEST_PATH,
    _signature_matches_hash,
    load_heatwave_mean_catalog,
    strict_heatwave_mean,
    validate_aligned_heatwave_grids,
)
from greenwave_local_layers.image_regression import _source_signature


def _write_raster(path, *, transform=from_origin(0, 60, 30, 30), width=2):
    with rasterio.open(
        path, "w", driver="GTiff", width=width, height=2, count=3,
        dtype="float32", crs="EPSG:31370", transform=transform,
    ) as target:
        target.write(np.ones((3, 2, width), dtype=np.float32))


def test_strict_mean_is_equal_weighted_and_excludes_any_missing_acquisition():
    values = np.asarray([
        [30, 30, 30], [32, 32, 32], [34, 34, 34],
        [36, 36, 36], [38, np.nan, 38], [40, 40, 40],
    ], dtype=np.float64)
    clear = np.ones_like(values, dtype=bool)
    clear[2, 2] = False
    means, eligible = strict_heatwave_mean(values, clear)
    np.testing.assert_array_equal(eligible, [True, False, False])
    assert means[0] == 35.0
    assert np.isnan(means[1:]).all()


def test_target_requires_exactly_six_aligned_vectors():
    with pytest.raises(ValueError, match="shape"):
        strict_heatwave_mean(np.ones((5, 2)), np.ones((5, 2), dtype=bool))


def test_grid_mismatch_is_rejected(tmp_path):
    paths = []
    for index in range(len(HEATWAVE_OBSERVATION_IDS)):
        path = tmp_path / f"{index}.tif"
        _write_raster(path, width=3 if index == 5 else 2)
        paths.append(path)
    with pytest.raises(ValueError, match="grid mismatch"):
        validate_aligned_heatwave_grids(paths)


def test_source_hash_change_invalidates_signature(tmp_path):
    path = tmp_path / "source.bin"
    path.write_bytes(b"frozen source")
    signature = _source_signature(path)
    assert _signature_matches_hash(signature)
    path.write_bytes(b"changed source")
    assert not _signature_matches_hash(signature)


@pytest.mark.skipif(not MANIFEST_PATH.exists(), reason="local frozen target catalog is not prepared")
def test_current_frozen_sources_have_the_expected_complete_cohort():
    try:
        catalog = load_heatwave_mean_catalog()
    except ValueError as error:
        if "predictor contract is incompatible" not in str(error):
            raise
        pytest.skip("The retained offline mean-model cache predates the exclusive upper-surface contract.")
    assert len(catalog.samples) == EXPECTED_SAMPLE_COUNT
    assert catalog.samples["sector_id"].nunique() == EXPECTED_SECTOR_COUNT
    assert catalog.samples[[
        f"lst_{item.removeprefix('landsat-').replace('-', '_')}_c"
        for item in HEATWAVE_OBSERVATION_IDS
    ]].notna().all(axis=None)


def test_reused_predictor_cache_is_an_exact_coordinate_subset():
    pytest.importorskip("xgboost")
    from greenwave_local_layers.image_regression import load_regression_catalog
    from greenwave_local_layers.image_regression_heatwave_mean_xgboost import (
        ARTIFACTS, prepare_heatwave_mean_feature_cache,
    )

    path = prepare_heatwave_mean_feature_cache()
    mean_catalog = load_heatwave_mean_catalog()
    base_catalog = load_regression_catalog()
    with np.load(path, allow_pickle=False) as cached:
        indexes = cached["source_indexes"].copy()
        targets = cached["targets"].copy()
    expected = base_catalog.samples.iloc[indexes][["landsat_row", "landsat_col"]].to_numpy()
    actual = mean_catalog.samples[["landsat_row", "landsat_col"]].to_numpy()
    np.testing.assert_array_equal(actual, expected)
    np.testing.assert_allclose(targets, mean_catalog.samples["lst_c"], rtol=0, atol=2e-6)
