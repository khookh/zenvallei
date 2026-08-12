"""Contracts for the fixed PyTorch LST regression illustration."""

from pathlib import Path
from types import SimpleNamespace

import geopandas as gpd
import numpy as np
import pandas as pd
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

torch = pytest.importorskip("torch")
from torch import nn
from torch.utils.data import DataLoader, Dataset

import greenwave_local_layers.image_regression_training as training
from greenwave_local_layers.image_regression import RegressionCatalog, SpatialFold
from greenwave_local_layers.image_regression_training import (
    EarlyStoppingConfig,
    InnerValidationSplit,
    LSTRegressionCNN,
    RandomDihedral,
    TargetStandardizer,
    TrainingConfig,
    TrainingLoaders,
    ValidationTrainingLoaders,
    count_trainable_parameters,
    create_early_stopping_loaders,
    create_training_loaders,
    make_sector_validation_split,
    pooled_regression_metrics,
    regression_metrics,
    set_reproducible_seed,
    train_and_evaluate,
    train_with_early_stopping,
)


def _write_raster(path: Path, values):
    with rasterio.open(
        path, "w", driver="GTiff", width=values.shape[1], height=values.shape[0],
        count=1, dtype=values.dtype, crs="EPSG:31370",
        transform=from_origin(0, values.shape[0], 1, 1), nodata=0,
    ) as output:
        output.write(values, 1)


def _catalog_and_fold(tmp_path):
    shape = (500, 500)
    soil = np.ones(shape, dtype=np.uint8)
    green = np.full(shape, 4, dtype=np.uint8)
    urban = np.ones(shape, dtype=np.uint8)
    soil_path, green_path, urban_path = (
        tmp_path / "soil.tif", tmp_path / "green.tif", tmp_path / "urban.tif",
    )
    _write_raster(soil_path, soil)
    _write_raster(green_path, green)
    _write_raster(urban_path, urban)
    records = []
    for index, target in enumerate((30.0, 32.0, 100.0, 50.0)):
        records.append({
            "sample_id": f"obs:{index}", "site_id": f"site:{index}",
            "observation_id": "obs", "sector_id": chr(65 + index),
            "municipality": "Example", "landsat_row": index, "landsat_col": index,
            "patch_center_row": 200 + index, "patch_center_col": 200 + index,
            "x_lambert": 200.0 + index, "y_lambert": 300.0 - index,
            "snapped_x_lambert": 200.0 + index, "snapped_y_lambert": 300.0 - index,
            "snap_offset_m": 0.0, "lst_c": target, "uncertainty_k": 0.5,
            "ground_coverage": 1.0, "soil_year": 2024, "green_year": 2021,
            "urban_year": 2021,
        })
    catalog = RegressionCatalog(
        observation_id="obs", samples=pd.DataFrame(records), manifest={}, cache_dir=tmp_path,
        soil_path=soil_path, green_path=green_path, urban_context_path=urban_path,
    )
    fold = SpatialFold(
        fold=0, train_indices=np.array([0, 1]), test_indices=np.array([2]),
        excluded_buffer_indices=np.array([3]), train_sector_ids=("A", "B"),
        test_sector_ids=("C",), diagnostics={},
    )
    return catalog, fold


def _sector_samples(counts):
    records = []
    geometries = []
    for sector_number, count in enumerate(counts):
        sector_id = f"S{sector_number:02d}"
        left = sector_number * 1_000.0
        geometries.append({"sectorId": sector_id, "geometry": box(left, 0, left + 1_000, 1_000)})
        for sample_number in range(count):
            records.append({
                "sample_id": f"sample:{sector_id}:{sample_number}",
                "site_id": f"site:{sector_id}:{sample_number}",
                "sector_id": sector_id,
                "municipality": f"M{sector_number % 3}",
                "x_lambert": left + 500 + sample_number,
                "y_lambert": 500.0,
                "lst_c": 25.0 + sector_number,
            })
    return pd.DataFrame(records), gpd.GeoDataFrame(geometries, crs="EPSG:31370")


def test_shared_cnn_accepts_both_input_shapes_with_identical_parameter_count():
    spatial_model = LSTRegressionCNN().to("meta")
    radial_model = LSTRegressionCNN().to("meta")
    assert spatial_model(torch.empty(4, 3, 200, 200, device="meta")).shape == (4,)
    assert radial_model(torch.empty(4, 3, 100, 100, device="meta")).shape == (4,)
    assert count_trainable_parameters(spatial_model) == count_trainable_parameters(radial_model)
    assert count_trainable_parameters(spatial_model) == 406_945


def test_target_standardizer_uses_supplied_training_values_and_inverts():
    standardizer = TargetStandardizer.fit(np.array([30.0, 32.0]))
    assert standardizer.mean_c == 31.0
    assert standardizer.std_c == 1.0
    normalized = standardizer.normalize(torch.tensor([30.0, 32.0]))
    assert torch.equal(normalized, torch.tensor([-1.0, 1.0]))
    assert torch.equal(standardizer.inverse(normalized), torch.tensor([30.0, 32.0]))


def test_inner_validation_split_is_deterministic_balanced_and_disjoint():
    samples, sectors = _sector_samples([5 + index % 4 for index in range(20)])
    test_mask = samples.sector_id == "S19"
    fold = SpatialFold(
        fold=2,
        train_indices=np.flatnonzero(~test_mask),
        test_indices=np.flatnonzero(test_mask),
        excluded_buffer_indices=np.array([], dtype=np.int64),
        train_sector_ids=tuple(f"S{index:02d}" for index in range(19)),
        test_sector_ids=("S19",), diagnostics={},
    )
    first = make_sector_validation_split(samples, fold, sectors=sectors)
    second = make_sector_validation_split(samples, fold, sectors=sectors)
    assert first.validation_sector_ids == second.validation_sector_ids
    assert np.array_equal(first.fit_indices, second.fit_indices)
    assert np.array_equal(first.validation_indices, second.validation_indices)
    assert abs(first.diagnostics["validationFractionBeforeBuffer"] - 0.15) < 0.03
    partitions = [
        set(first.fit_indices), set(first.validation_indices),
        set(first.excluded_buffer_indices),
    ]
    assert set.union(*partitions) == set(fold.train_indices)
    assert all(
        partitions[left].isdisjoint(partitions[right])
        for left, right in ((0, 1), (0, 2), (1, 2))
    )
    assert set(fold.test_indices).isdisjoint(set.union(*partitions))
    assert set(first.fit_sector_ids).isdisjoint(first.validation_sector_ids)


def test_inner_validation_split_applies_200_m_embargo():
    samples = pd.DataFrame([
        {"site_id": "a-far", "sector_id": "A", "municipality": "M", "x_lambert": 500, "y_lambert": 500},
        {"site_id": "a-near", "sector_id": "A", "municipality": "M", "x_lambert": 950, "y_lambert": 500},
        {"site_id": "b-near", "sector_id": "B", "municipality": "M", "x_lambert": 1050, "y_lambert": 500},
        {"site_id": "b-far", "sector_id": "B", "municipality": "M", "x_lambert": 1500, "y_lambert": 500},
        {"site_id": "test", "sector_id": "C", "municipality": "M", "x_lambert": 5500, "y_lambert": 500},
    ])
    samples["sample_id"] = samples.site_id
    sectors = gpd.GeoDataFrame([
        {"sectorId": "A", "geometry": box(0, 0, 1000, 1000)},
        {"sectorId": "B", "geometry": box(1000, 0, 2000, 1000)},
        {"sectorId": "C", "geometry": box(5000, 0, 6000, 1000)},
    ], crs="EPSG:31370")
    fold = SpatialFold(
        fold=0, train_indices=np.arange(4), test_indices=np.array([4]),
        excluded_buffer_indices=np.array([], dtype=np.int64), train_sector_ids=("A", "B"),
        test_sector_ids=("C",), diagnostics={},
    )
    split = make_sector_validation_split(
        samples, fold, validation_fraction=0.5, buffer_m=200, sectors=sectors,
    )
    assert len(split.validation_indices) == 2
    assert len(split.excluded_buffer_indices) == 1
    assert len(split.fit_indices) == 1
    excluded_site = samples.iloc[split.excluded_buffer_indices[0]].site_id
    assert excluded_site.endswith("near")


def test_dihedral_augmentation_preserves_shape_and_binary_values():
    transform = RandomDihedral()
    values = torch.zeros(3, 20, 20)
    values[0, 2:7, 4:11] = 1
    for seed in range(16):
        torch.manual_seed(seed)
        augmented = transform(values)
        assert augmented.shape == values.shape
        assert set(torch.unique(augmented).tolist()) == {0.0, 1.0}
        assert torch.equal(augmented.sum(dim=(-2, -1)), values.sum(dim=(-2, -1)))


def test_loaders_use_only_fold_indices_and_augment_spatial_training(tmp_path):
    catalog, fold = _catalog_and_fold(tmp_path)
    config = TrainingConfig(batch_size=2, num_workers=0)
    spatial = create_training_loaders(catalog, fold, "spatial", config)
    radial = create_training_loaders(
        catalog, fold, "radial", config, standardizer=spatial.standardizer,
    )
    assert spatial.standardizer.mean_c == 31.0
    assert spatial.train.dataset.catalog_indices.tolist() == [0, 1]
    assert spatial.test.dataset.catalog_indices.tolist() == [2]
    assert 3 not in spatial.train.dataset.catalog_indices
    assert spatial.train.dataset.augmentation is not None
    assert spatial.test.dataset.augmentation is None
    assert radial.train.dataset.augmentation is None
    assert radial.test.dataset.augmentation is None
    spatial.train.dataset.close()
    spatial.test.dataset.close()
    radial.train.dataset.close()
    radial.test.dataset.close()


def test_early_stopping_loaders_scale_only_fit_targets_and_limit_augmentation(tmp_path):
    catalog, _ = _catalog_and_fold(tmp_path)
    outer = SpatialFold(
        fold=0, train_indices=np.array([0, 1, 2]), test_indices=np.array([3]),
        excluded_buffer_indices=np.array([], dtype=np.int64),
        train_sector_ids=("A", "B", "C"), test_sector_ids=("D",), diagnostics={},
    )
    inner = InnerValidationSplit(
        outer_fold=0, fit_indices=np.array([0, 1]), validation_indices=np.array([2]),
        excluded_buffer_indices=np.array([], dtype=np.int64), fit_sector_ids=("A", "B"),
        validation_sector_ids=("C",), diagnostics={},
    )
    config = TrainingConfig(batch_size=2, num_workers=0)
    spatial = create_early_stopping_loaders(catalog, outer, inner, "spatial", config)
    radial = create_early_stopping_loaders(catalog, outer, inner, "radial", config)
    assert spatial.standardizer.mean_c == 31.0
    assert spatial.standardizer.std_c == 1.0
    assert spatial.fit.dataset.catalog_indices.tolist() == [0, 1]
    assert spatial.validation.dataset.catalog_indices.tolist() == [2]
    assert spatial.test.dataset.catalog_indices.tolist() == [3]
    assert spatial.fit.dataset.augmentation is not None
    assert spatial.validation.dataset.augmentation is None
    assert spatial.test.dataset.augmentation is None
    assert radial.fit.dataset.augmentation is None
    assert radial.validation.dataset.augmentation is None
    assert radial.test.dataset.augmentation is None
    for loaders in (spatial, radial):
        loaders.fit.dataset.close()
        loaders.validation.dataset.close()
        loaders.test.dataset.close()


def test_regression_metrics_match_known_raw_celsius_values():
    metrics = regression_metrics([1.0, 2.0, 3.0], [2.0, 2.0, 4.0])
    assert metrics["count"] == 3
    assert metrics["mae_c"] == pytest.approx(2 / 3)
    assert metrics["rmse_c"] == pytest.approx(np.sqrt(2 / 3))
    assert metrics["r2"] == pytest.approx(0.0)
    assert metrics["mean_error_c"] == pytest.approx(2 / 3)


def test_pooled_metrics_match_directly_concatenated_fold_predictions():
    folds = [
        SimpleNamespace(targets_c=np.array([1.0, 2.0]), predictions_c=np.array([1.5, 1.5])),
        SimpleNamespace(targets_c=np.array([3.0]), predictions_c=np.array([4.0])),
    ]
    pooled = pooled_regression_metrics(folds)
    direct = regression_metrics([1.0, 2.0, 3.0], [1.5, 1.5, 4.0])
    assert pooled == direct


class _TinyDictionaryDataset(Dataset):
    def __init__(self, count, seed):
        generator = torch.Generator().manual_seed(seed)
        self.inputs = torch.rand(count, 3, 32, 32, generator=generator)
        self.targets = self.inputs.mean(dim=(1, 2, 3))

    def __len__(self):
        return len(self.inputs)

    def __getitem__(self, index):
        target = self.targets[index]
        return {
            "input": self.inputs[index], "target": target, "target_c": target + 30,
            "catalog_index": torch.tensor(index, dtype=torch.int64),
        }

    def close(self):
        pass


def test_fixed_training_routine_updates_parameters_and_returns_finite_predictions(monkeypatch):
    config = TrainingConfig(
        epochs=1, learning_rate=1e-3, batch_size=4, num_workers=0,
        dropout=0.0, amp=False,
    )
    standardizer = TargetStandardizer(mean_c=30.0, std_c=1.0)
    train_loader = DataLoader(_TinyDictionaryDataset(8, 1), batch_size=4, shuffle=False)
    test_loader = DataLoader(_TinyDictionaryDataset(4, 2), batch_size=4, shuffle=False)
    monkeypatch.setattr(
        training, "create_training_loaders",
        lambda *args, **kwargs: TrainingLoaders(train_loader, test_loader, standardizer),
    )
    set_reproducible_seed(config.seed)
    reference = LSTRegressionCNN(dropout=0.0)
    initial = {name: value.detach().clone() for name, value in reference.state_dict().items()}
    result = train_and_evaluate(
        None, None, "spatial", config, standardizer=standardizer,
        device="cpu", verbose=False,
    )
    changed = any(
        not torch.equal(initial[name], value.detach().cpu())
        for name, value in result.model.state_dict().items()
    )
    assert changed
    assert len(result.history) == 1
    assert result.metrics["count"] == 4
    assert np.all(np.isfinite(result.predictions_c))
    assert result.catalog_indices.tolist() == [0, 1, 2, 3]


def test_early_stopping_obeys_patience_and_restores_best_state(monkeypatch):
    config = TrainingConfig(
        learning_rate=1e-3, batch_size=4, num_workers=0, dropout=0.0, amp=False,
    )
    stopping = EarlyStoppingConfig(max_epochs=10, patience=3, min_delta=1e-4)
    standardizer = TargetStandardizer(mean_c=30.0, std_c=1.0)
    loaders = ValidationTrainingLoaders(
        fit=DataLoader(_TinyDictionaryDataset(8, 1), batch_size=4, shuffle=False),
        validation=DataLoader(_TinyDictionaryDataset(4, 2), batch_size=4, shuffle=False),
        test=DataLoader(_TinyDictionaryDataset(4, 3), batch_size=4, shuffle=False),
        standardizer=standardizer,
    )
    monkeypatch.setattr(training, "create_early_stopping_loaders", lambda *args, **kwargs: loaders)
    validation_losses = iter([1.0, 0.8, 0.80005, 0.81, 0.82])
    observed_states = []

    def fake_validation_mse(model, *args, **kwargs):
        observed_states.append({
            name: value.detach().cpu().clone() for name, value in model.state_dict().items()
        })
        return next(validation_losses)

    monkeypatch.setattr(training, "_validation_mse", fake_validation_mse)
    result = train_with_early_stopping(
        None, SpatialFold(0, np.array([]), np.array([]), np.array([]), (), (), {}),
        InnerValidationSplit(0, np.array([]), np.array([]), np.array([]), (), (), {}),
        "spatial", config, stopping, device="cpu", verbose=False,
    )
    assert result.best_epoch == 2
    assert result.stopped_epoch == 5
    assert len(result.history) == 5
    assert result.best_validation_mse == pytest.approx(0.8)
    assert all(
        torch.equal(value, observed_states[1][name])
        for name, value in result.model.state_dict().items()
    )
    assert np.all(np.isfinite(result.predictions_c))


def test_early_stopping_respects_maximum_epoch_budget(monkeypatch):
    config = TrainingConfig(
        learning_rate=1e-3, batch_size=4, num_workers=0, dropout=0.0, amp=False,
    )
    stopping = EarlyStoppingConfig(max_epochs=3, patience=5, min_delta=1e-4)
    standardizer = TargetStandardizer(mean_c=30.0, std_c=1.0)
    loaders = ValidationTrainingLoaders(
        fit=DataLoader(_TinyDictionaryDataset(8, 1), batch_size=4, shuffle=False),
        validation=DataLoader(_TinyDictionaryDataset(4, 2), batch_size=4, shuffle=False),
        test=DataLoader(_TinyDictionaryDataset(4, 3), batch_size=4, shuffle=False),
        standardizer=standardizer,
    )
    monkeypatch.setattr(training, "create_early_stopping_loaders", lambda *args, **kwargs: loaders)
    validation_losses = iter([1.0, 0.9, 0.8])
    monkeypatch.setattr(
        training, "_validation_mse", lambda *args, **kwargs: next(validation_losses),
    )
    result = train_with_early_stopping(
        None, SpatialFold(0, np.array([]), np.array([]), np.array([]), (), (), {}),
        InnerValidationSplit(0, np.array([]), np.array([]), np.array([]), (), (), {}),
        "radial", config, stopping, device="cpu", verbose=False,
    )
    assert result.stopped_epoch == 3
    assert result.best_epoch == 3
