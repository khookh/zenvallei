"""Contracts for the lazy Landsat image-regression experiment."""

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from greenwave_local_layers.image_regression import (
    ImageRegressionDataset,
    LAND_COVER_CHANNEL_NAMES,
    PATCH_SIZE,
    RegressionCatalog,
    SUPPORT_MASK,
    UA_URBAN_FABRIC,
    UA_VALID,
    UA_WATER,
    _signature_is_current,
    _source_signature,
    _xgboost_input_contract,
    annular_profiles,
    center_is_eligible,
    make_sector_folds,
    profiles_to_line_tensor,
    radial_band_fractions,
)


def _write_raster(path: Path, values):
    with rasterio.open(
        path, "w", driver="GTiff", width=values.shape[1], height=values.shape[0],
        count=1, dtype=values.dtype, crs="EPSG:31370",
        transform=from_origin(0, values.shape[0], 1, 1), nodata=0,
    ) as output:
        output.write(values, 1)


def _synthetic_catalog(tmp_path):
    shape = (400, 400)
    soil = np.ones(shape, dtype=np.uint8)
    green = np.full(shape, 4, dtype=np.uint8)
    green[:, 200:] = 1
    urban = np.full(shape, UA_VALID | UA_URBAN_FABRIC, dtype=np.uint8)
    urban[:200] |= UA_WATER
    water = ((urban & UA_WATER) != 0).astype(np.uint8)
    water[180:220, 240:280] |= np.uint8(2)
    soil_path, green_path, urban_path, water_path = (
        tmp_path / "soil.tif", tmp_path / "green.tif", tmp_path / "urban.tif",
        tmp_path / "water.tif",
    )
    _write_raster(soil_path, soil)
    _write_raster(green_path, green)
    _write_raster(urban_path, urban)
    _write_raster(water_path, water)
    samples = pd.DataFrame([{
        "sample_id": "obs:1:2", "site_id": "1:2", "observation_id": "obs",
        "sector_id": "A", "municipality": "Example", "landsat_row": 1,
        "landsat_col": 2, "patch_center_row": 200, "patch_center_col": 200,
        "x_lambert": 200.0, "y_lambert": 200.0,
        "snapped_x_lambert": 200.0, "snapped_y_lambert": 200.0,
        "snap_offset_m": 0.0, "lst_c": 31.25, "uncertainty_k": 0.4,
        "ground_coverage": 1.0, "soil_year": 2024, "green_year": 2021,
        "urban_year": 2021,
    }])
    return RegressionCatalog(
        observation_id="obs", samples=samples, manifest={}, cache_dir=tmp_path,
        soil_path=soil_path, green_path=green_path, urban_context_path=urban_path,
        water_context_path=water_path,
    )


def test_center_eligibility_uses_all_clear_finite_landsat_cells():
    urban = int(UA_VALID | UA_URBAN_FABRIC)
    assert center_is_eligible(1, urban, 1, 32.0)
    assert center_is_eligible(0, urban, 1, 32.0)
    assert center_is_eligible(1, int(UA_VALID), 1, 32.0)
    assert not center_is_eligible(1, urban, 2, 32.0)
    assert not center_is_eligible(1, urban, 1, np.nan)


def test_xgboost_contract_has_five_channels_and_twenty_radial_features():
    assert _xgboost_input_contract() == {
        "channels": ["soil_sealing", "high_green", "low_green", "agriculture", "water"],
        "radialBandEdgesMeters": [0, 25, 50, 75, 100],
        "featureCount": 20,
        "implicitRemainder": "other-unsealed-bare-soil-proxy",
        "surfaceContract": "mutually-exclusive-upper-surface-v5-landgebruik-water",
        "priority": [
            "water", "agriculture", "high_green", "soil_sealing",
            "low_green", "other_unsealed",
        ],
        "waterContract": {
            "rule": "urban-atlas-water-union-landgebruik-2025-water",
            "urbanAtlasCode": "50000", "landUseYear": 2025,
            "landUseCode": 17, "landUseResampling": "nearest",
        },
    }


def test_lazy_spatial_dataset_reads_aligned_binary_channels_and_masks_disk(tmp_path):
    dataset = ImageRegressionDataset(_synthetic_catalog(tmp_path), "spatial")
    sample = dataset[0]
    values = sample["input"]
    assert values.shape == (3, PATCH_SIZE, PATCH_SIZE)
    assert values.dtype == np.float32
    assert np.all(values[0, SUPPORT_MASK] == 1)
    assert np.all(values[:, ~SUPPORT_MASK] == 0)
    assert 0.49 < values[1, SUPPORT_MASK].mean() < 0.51
    assert 0.49 < values[2, SUPPORT_MASK].mean() < 0.51
    assert sample["target"] == np.float32(31.25)
    assert sample["metadata"]["uncertainty_k"] == 0.4
    dataset.close()


def test_land_cover_patch_adds_low_green_and_agriculture_channels(tmp_path):
    catalog = _synthetic_catalog(tmp_path)
    green = np.full((400, 400), 4, dtype=np.uint8)
    green[:, 100:150] = 1
    green[:, 150:200] = 2
    green[:, 200:250] = 3
    with rasterio.open(catalog.green_path, "r+") as output:
        output.write(green, 1)
    dataset = ImageRegressionDataset(catalog, "spatial")
    patch = dataset.land_cover_patch(0)
    assert LAND_COVER_CHANNEL_NAMES == (
        "soil_sealing", "high_green", "low_green", "agriculture", "water",
    )
    assert patch.shape == (5, PATCH_SIZE, PATCH_SIZE)
    # Every explicit predictor is one mutually exclusive upper-surface class.
    assert np.all(patch.sum(axis=0)[SUPPORT_MASK] <= 1)
    assert patch[0, SUPPORT_MASK].sum() > 0
    assert patch[1, SUPPORT_MASK].sum() > 0
    assert patch[2, SUPPORT_MASK].sum() == 0
    assert patch[3, SUPPORT_MASK].sum() > 0
    assert np.all(patch[:, ~SUPPORT_MASK] == 0)
    features = radial_band_fractions(patch)
    assert features.shape == (5, 4)
    assert np.all((0 <= features) & (features <= 1))
    dataset.close()


def test_annular_profiles_are_fractions_not_ring_counts():
    patch = np.zeros((3, PATCH_SIZE, PATCH_SIZE), dtype=np.float32)
    patch[0, SUPPORT_MASK] = 1
    columns = np.indices(SUPPORT_MASK.shape)[1]
    patch[1, SUPPORT_MASK & (columns >= PATCH_SIZE // 2)] = 1
    profile = annular_profiles(patch)
    assert profile.shape == (3, 100)
    assert np.all(profile[0] == 1)
    assert np.all(profile[2] == 0)
    assert np.allclose(profile[1], 0.5, atol=0.12)


def test_radial_band_features_are_area_weighted_channel_fractions():
    patch = np.zeros((3, PATCH_SIZE, PATCH_SIZE), dtype=np.float32)
    _, columns = np.indices(SUPPORT_MASK.shape)
    offsets = np.arange(PATCH_SIZE, dtype=np.float32) + 0.5 - PATCH_SIZE / 2
    yy, xx = np.meshgrid(offsets, offsets, indexing="ij")
    distances = np.sqrt(xx * xx + yy * yy)
    patch[0, SUPPORT_MASK & (distances < 25)] = 1
    patch[1, SUPPORT_MASK & (columns >= PATCH_SIZE // 2)] = 1
    patch[2, SUPPORT_MASK] = 1
    features = radial_band_fractions(patch)
    assert features.shape == (3, 4)
    assert np.array_equal(features[0], np.array([1, 0, 0, 0], dtype=np.float32))
    assert np.allclose(features[1], 0.5)
    assert np.array_equal(features[2], np.ones(4, dtype=np.float32))


def test_profiles_become_connected_axis_free_line_tensor():
    profiles = np.stack([
        np.zeros(100), np.ones(100), np.linspace(0, 1, 100),
    ]).astype(np.float32)
    image = profiles_to_line_tensor(profiles)
    assert image.shape == (3, 100, 100)
    assert np.all(image[0, -1] == 1)
    assert np.all(image[1, 0] == 1)
    assert image[2, -1, 0] == 1
    assert image[2, 0, -1] == 1
    assert np.all(image.sum(axis=1) >= 1)


def test_dataset_radial_representation_exposes_model_tensor_and_profiles(tmp_path):
    dataset = ImageRegressionDataset(_synthetic_catalog(tmp_path), "radial")
    assert dataset[0]["input"].shape == (3, 100, 100)
    assert dataset.profiles(0).shape == (3, 100)
    dataset.close()


def test_source_signature_detects_changed_cache_input(tmp_path):
    source = tmp_path / "source.bin"
    source.write_bytes(b"first")
    signature = _source_signature(source)
    assert _signature_is_current(signature)
    source.write_bytes(b"a changed source")
    assert not _signature_is_current(signature)


def _split_fixture():
    samples = pd.DataFrame([
        {"site_id": "a", "sector_id": "A", "municipality": "One", "x_lambert": 50.0, "y_lambert": 50.0},
        {"site_id": "a", "sector_id": "A", "municipality": "One", "x_lambert": 50.0, "y_lambert": 50.0},
        {"site_id": "near", "sector_id": "B", "municipality": "Two", "x_lambert": 150.0, "y_lambert": 50.0},
        {"site_id": "far", "sector_id": "B", "municipality": "Two", "x_lambert": 400.0, "y_lambert": 50.0},
    ])
    sectors = gpd.GeoDataFrame(
        {"sectorId": ["A", "B"], "municipality": ["One", "Two"]},
        geometry=[box(0, 0, 100, 100), box(100, 0, 500, 100)], crs="EPSG:31370",
    )
    return samples, sectors


def test_sector_folds_group_repeated_sites_and_apply_200m_embargo():
    samples, sectors = _split_fixture()
    folds = make_sector_folds(samples, n_splits=2, buffer_m=200, seed=42, sectors=sectors)
    fold_a = next(fold for fold in folds if fold.test_sector_ids == ("A",))
    assert fold_a.test_indices.tolist() == [0, 1]
    assert fold_a.excluded_buffer_indices.tolist() == [2]
    assert fold_a.train_indices.tolist() == [3]
    assert fold_a.train_sector_ids == ("B",)
    assert fold_a.diagnostics["bufferMeters"] == 200


def test_sector_folds_are_deterministic_and_sector_disjoint():
    samples, sectors = _split_fixture()
    first = make_sector_folds(samples, n_splits=2, buffer_m=200, seed=7, sectors=sectors)
    second = make_sector_folds(samples, n_splits=2, buffer_m=200, seed=7, sectors=sectors)
    assert [fold.test_sector_ids for fold in first] == [fold.test_sector_ids for fold in second]
    for left, right in zip(first, second):
        assert np.array_equal(left.train_indices, right.train_indices)
        train_sectors = set(samples.iloc[left.train_indices]["sector_id"])
        test_sectors = set(samples.iloc[left.test_indices]["sector_id"])
        assert train_sectors.isdisjoint(test_sectors)
