"""PyTorch tools for the illustrative Landsat LST regression experiment.

This module deliberately implements one fixed training recipe rather than a
model-selection framework.  Ground inputs remain lazy and sector holdouts come
from :mod:`greenwave_local_layers.image_regression`; only the training targets
are standardised, using statistics fitted on the selected training indices.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import random

import geopandas as gpd
import numpy as np
import torch
from shapely import contains_xy
from torch import nn
from torch.utils.data import DataLoader, Dataset

from .constants import SECTORS_PATH
from .image_regression import (
    PATCH_RADIUS_METERS,
    ImageRegressionDataset,
    RegressionCatalog,
    SpatialFold,
)


@dataclass(frozen=True)
class TrainingConfig:
    """Fixed, reproducible settings shared by both input representations."""

    epochs: int = 10
    learning_rate: float = 1e-3
    batch_size: int = 64
    weight_decay: float = 1e-4
    dropout: float = 0.2
    seed: int = 42
    num_workers: int = 4
    amp: bool = True


@dataclass(frozen=True)
class EarlyStoppingConfig:
    """Validation-loss stopping rule for each outer-fold model."""

    max_epochs: int = 50
    patience: int = 5
    min_delta: float = 1e-4


@dataclass(frozen=True)
class InnerValidationSplit:
    """Leakage-safe fitting/validation partition inside one outer fold."""

    outer_fold: int
    fit_indices: np.ndarray
    validation_indices: np.ndarray
    excluded_buffer_indices: np.ndarray
    fit_sector_ids: tuple[str, ...]
    validation_sector_ids: tuple[str, ...]
    diagnostics: dict


@dataclass(frozen=True)
class TargetStandardizer:
    """Training-only target statistics with tensor/array-safe transforms."""

    mean_c: float
    std_c: float

    @classmethod
    def fit(cls, values) -> "TargetStandardizer":
        array = np.asarray(values, dtype=np.float64)
        if array.ndim != 1 or not len(array) or not np.all(np.isfinite(array)):
            raise ValueError("Target standardisation requires a finite one-dimensional training array.")
        standard_deviation = float(np.std(array, ddof=0))
        if not math.isfinite(standard_deviation) or standard_deviation <= 0:
            raise ValueError("Training targets must have non-zero variance.")
        return cls(mean_c=float(np.mean(array)), std_c=standard_deviation)

    def normalize(self, values):
        return (values - self.mean_c) / self.std_c

    def inverse(self, values):
        return values * self.std_c + self.mean_c


class RandomDihedral:
    """Uniformly sample the eight right-angle rotations/reflections."""

    def __call__(self, tensor: torch.Tensor) -> torch.Tensor:
        if tensor.ndim != 3:
            raise ValueError("Dihedral augmentation expects a channel-first image tensor.")
        rotation = int(torch.randint(0, 4, ()).item())
        output = torch.rot90(tensor, rotation, dims=(-2, -1))
        if bool(torch.randint(0, 2, ()).item()):
            output = torch.flip(output, dims=(-1,))
        return output.contiguous()


class TorchImageRegressionDataset(Dataset):
    """Adapt lazy NumPy patches to tensors and retain sample provenance."""

    def __init__(
            self, catalog: RegressionCatalog, indices, representation: str,
            standardizer: TargetStandardizer, *, augment: bool = False):
        if augment and representation != "spatial":
            raise ValueError("Rotations and mirrors are valid only for north-up spatial patches.")
        self.base = ImageRegressionDataset(catalog, representation, indices=indices)
        self.representation = representation
        self.standardizer = standardizer
        self.augmentation = RandomDihedral() if augment else None

    @property
    def catalog_indices(self) -> np.ndarray:
        return self.base.indices

    def __len__(self):
        return len(self.base)

    def __getitem__(self, index):
        sample = self.base[index]
        input_tensor = torch.from_numpy(sample["input"])
        if self.augmentation is not None:
            input_tensor = self.augmentation(input_tensor)
        target_c = float(sample["target"])
        return {
            "input": input_tensor,
            "target": torch.tensor(self.standardizer.normalize(target_c), dtype=torch.float32),
            "target_c": torch.tensor(target_c, dtype=torch.float32),
            "catalog_index": torch.tensor(int(self.catalog_indices[index]), dtype=torch.int64),
            "sample_id": sample["sample_id"],
            "site_id": sample["site_id"],
            "metadata": sample["metadata"],
        }

    def close(self):
        self.base.close()


def make_sector_validation_split(
        samples, outer_fold: SpatialFold, validation_fraction: float = 0.15,
        buffer_m: float = 200, seed: int = 42, *,
        sectors: gpd.GeoDataFrame | None = None) -> InnerValidationSplit:
    """Create a deterministic sector validation split inside an outer fold.

    Sector allocation targets the requested *sample* fraction while keeping
    sectors whole. Only ``outer_fold.train_indices`` are candidates; fitting
    centres within ``buffer_m`` of the validation-sector union are embargoed.
    """
    required = {"site_id", "sector_id", "municipality", "x_lambert", "y_lambert"}
    missing = required.difference(samples.columns)
    if missing:
        raise ValueError(f"Samples are missing validation-split columns: {sorted(missing)}")
    if not 0 < validation_fraction < 1:
        raise ValueError("Validation fraction must lie strictly between zero and one.")
    if buffer_m < 2 * PATCH_RADIUS_METERS:
        raise ValueError("The validation buffer must be at least 200 m for 100 m disks.")

    frame = samples.reset_index(drop=True)
    candidate_indices = np.asarray(outer_fold.train_indices, dtype=np.int64)
    if not len(candidate_indices):
        raise ValueError("The outer fold has no eligible fitting/validation candidates.")
    if np.any(candidate_indices < 0) or np.any(candidate_indices >= len(frame)):
        raise IndexError("The outer fold contains an out-of-range training index.")
    candidates = frame.iloc[candidate_indices]
    site_sectors = candidates[["site_id", "sector_id"]].drop_duplicates()
    if (site_sectors.groupby("site_id")["sector_id"].nunique() > 1).any():
        raise ValueError("Every repeated site must belong to one sector.")
    sector_counts = candidates.groupby(candidates["sector_id"].astype(str), sort=True).size()
    if len(sector_counts) < 2:
        raise ValueError("At least two candidate sectors are required for validation.")

    rng = np.random.default_rng(int(seed) + int(outer_fold.fold))
    tie_order = dict(zip(sector_counts.index, rng.permutation(len(sector_counts))))
    ordered = sorted(
        sector_counts.items(),
        key=lambda item: (-int(item[1]), tie_order[item[0]], str(item[0])),
    )
    targets = np.array(
        [(1.0 - validation_fraction) * len(candidates), validation_fraction * len(candidates)],
        dtype=np.float64,
    )
    loads = np.zeros(2, dtype=np.int64)
    assignments: list[list[str]] = [[], []]
    for sector_id, count in ordered:
        bucket = min(range(2), key=lambda value: (loads[value] / targets[value], value))
        assignments[bucket].append(str(sector_id))
        loads[bucket] += int(count)
    if not assignments[0] or not assignments[1]:
        raise ValueError("Sector allocation did not produce both fitting and validation groups.")

    sector_frame = gpd.read_file(SECTORS_PATH) if sectors is None else sectors.copy()
    if "sectorId" not in sector_frame.columns:
        if "sector_id" not in sector_frame.columns:
            raise ValueError("Sector geometry needs sectorId or sector_id.")
        sector_frame = sector_frame.rename(columns={"sector_id": "sectorId"})
    sector_frame["sectorId"] = sector_frame["sectorId"].astype(str)
    sector_frame = sector_frame.to_crs("EPSG:31370")
    required_sectors = set(candidates["sector_id"].astype(str)).union(outer_fold.test_sector_ids)
    unknown = required_sectors.difference(sector_frame["sectorId"])
    if unknown:
        raise ValueError(f"Samples reference sectors without geometry: {sorted(unknown)[:3]}")

    validation_sector_ids = tuple(sorted(assignments[1]))
    candidate_sector_ids = candidates["sector_id"].astype(str)
    is_validation = candidate_sector_ids.isin(validation_sector_ids).to_numpy()
    validation_geometry = sector_frame.loc[
        sector_frame["sectorId"].isin(validation_sector_ids), "geometry"
    ].union_all()
    validation_exclusion = validation_geometry.buffer(float(buffer_m) + 1e-7)
    candidate_x = candidates["x_lambert"].to_numpy(dtype=np.float64)
    candidate_y = candidates["y_lambert"].to_numpy(dtype=np.float64)
    inner_buffer = ~is_validation & contains_xy(validation_exclusion, candidate_x, candidate_y)
    is_fit = ~is_validation & ~inner_buffer
    fit_indices = candidate_indices[is_fit]
    validation_indices = candidate_indices[is_validation]
    excluded_indices = candidate_indices[inner_buffer]
    if not len(fit_indices) or not len(validation_indices):
        raise ValueError("The validation split or its embargo left an empty partition.")

    outer_test_indices = np.asarray(outer_fold.test_indices, dtype=np.int64)
    disjoint_sets = (set(fit_indices), set(validation_indices), set(excluded_indices))
    if any(disjoint_sets[left].intersection(disjoint_sets[right])
           for left, right in ((0, 1), (0, 2), (1, 2))):
        raise AssertionError("Inner fitting, validation, and embargo indices overlap.")
    if any(values.intersection(outer_test_indices) for values in disjoint_sets):
        raise AssertionError("An outer test sample leaked into the inner split.")
    fit_sites = set(frame.iloc[fit_indices]["site_id"])
    validation_sites = set(frame.iloc[validation_indices]["site_id"])
    test_sites = set(frame.iloc[outer_test_indices]["site_id"])
    if fit_sites.intersection(validation_sites) or fit_sites.intersection(test_sites) \
            or validation_sites.intersection(test_sites):
        raise AssertionError("A site leaked between fitting, validation, and test partitions.")
    if np.any(contains_xy(
            validation_exclusion,
            frame.iloc[fit_indices]["x_lambert"].to_numpy(dtype=np.float64),
            frame.iloc[fit_indices]["y_lambert"].to_numpy(dtype=np.float64))):
        raise AssertionError("A fitting centre violates the inner validation embargo.")

    if outer_fold.test_sector_ids:
        test_geometry = sector_frame.loc[
            sector_frame["sectorId"].isin(outer_fold.test_sector_ids), "geometry"
        ].union_all()
        test_exclusion = test_geometry.buffer(float(buffer_m) + 1e-7)
        if np.any(contains_xy(
                test_exclusion,
                frame.iloc[np.concatenate((fit_indices, validation_indices))]["x_lambert"].to_numpy(
                    dtype=np.float64),
                frame.iloc[np.concatenate((fit_indices, validation_indices))]["y_lambert"].to_numpy(
                    dtype=np.float64))):
            raise AssertionError("An inner partition violates the outer test embargo.")

    fit_sector_ids = tuple(sorted(frame.iloc[fit_indices]["sector_id"].astype(str).unique()))
    if set(fit_sector_ids).intersection(validation_sector_ids):
        raise AssertionError("A validation sector leaked into fitting.")
    diagnostics = {
        "outerFold": int(outer_fold.fold),
        "outerCandidateSampleCount": int(len(candidate_indices)),
        "fitSampleCount": int(len(fit_indices)),
        "validationSampleCount": int(len(validation_indices)),
        "excludedBufferSampleCount": int(len(excluded_indices)),
        "fitSectorCount": len(fit_sector_ids),
        "validationSectorCount": len(validation_sector_ids),
        "validationFractionBeforeBuffer": float(len(validation_indices) / len(candidate_indices)),
        "fitMunicipalities": sorted(frame.iloc[fit_indices]["municipality"].astype(str).unique()),
        "validationMunicipalities": sorted(
            frame.iloc[validation_indices]["municipality"].astype(str).unique()
        ),
        "bufferMeters": float(buffer_m),
        "seed": int(seed) + int(outer_fold.fold),
    }
    return InnerValidationSplit(
        outer_fold=int(outer_fold.fold), fit_indices=fit_indices,
        validation_indices=validation_indices, excluded_buffer_indices=excluded_indices,
        fit_sector_ids=fit_sector_ids, validation_sector_ids=validation_sector_ids,
        diagnostics=diagnostics,
    )


class LSTRegressionCNN(nn.Module):
    """One compact CNN shared by 200 m maps and 100 x 100 radial images."""

    def __init__(self, in_channels: int = 3, dropout: float = 0.2):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(in_channels, 32, kernel_size=5, stride=2, padding=2, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(64, 128, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),
            nn.Conv2d(128, 256, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm2d(256),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Dropout(dropout),
            nn.Linear(256, 64),
            nn.ReLU(inplace=True),
            nn.Linear(64, 1),
        )

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(inputs)).squeeze(1)


@dataclass(frozen=True)
class TrainingLoaders:
    train: DataLoader
    test: DataLoader
    standardizer: TargetStandardizer


@dataclass(frozen=True)
class ValidationTrainingLoaders:
    fit: DataLoader
    validation: DataLoader
    test: DataLoader
    standardizer: TargetStandardizer


@dataclass
class TrainingResult:
    representation: str
    model: LSTRegressionCNN
    history: tuple[dict, ...]
    metrics: dict
    predictions_c: np.ndarray
    targets_c: np.ndarray
    catalog_indices: np.ndarray
    device: str


@dataclass
class EarlyStoppingTrainingResult:
    representation: str
    outer_fold: int
    model: LSTRegressionCNN
    history: tuple[dict, ...]
    metrics: dict
    predictions_c: np.ndarray
    targets_c: np.ndarray
    catalog_indices: np.ndarray
    device: str
    best_epoch: int
    stopped_epoch: int
    best_validation_mse: float


def count_trainable_parameters(model: nn.Module) -> int:
    return int(sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad))


def set_reproducible_seed(seed: int):
    """Seed Python, NumPy and PyTorch without silently changing the recipe."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
    torch.use_deterministic_algorithms(True, warn_only=True)


def _seed_worker(worker_id):
    del worker_id
    worker_seed = torch.initial_seed() % (2 ** 32)
    random.seed(worker_seed)
    np.random.seed(worker_seed)


def create_training_loaders(
        catalog: RegressionCatalog, fold: SpatialFold, representation: str,
        config: TrainingConfig = TrainingConfig(), *,
        standardizer: TargetStandardizer | None = None,
        augment_spatial: bool = True) -> TrainingLoaders:
    """Build the one training/test split without consulting test targets."""
    if representation not in ("spatial", "radial"):
        raise ValueError("representation must be 'spatial' or 'radial'.")
    if config.batch_size <= 0 or config.num_workers < 0:
        raise ValueError("Batch size must be positive and worker count cannot be negative.")
    if standardizer is None:
        training_targets = catalog.samples.iloc[fold.train_indices]["lst_c"].to_numpy()
        standardizer = TargetStandardizer.fit(training_targets)
    train_dataset = TorchImageRegressionDataset(
        catalog, fold.train_indices, representation, standardizer,
        augment=augment_spatial and representation == "spatial",
    )
    test_dataset = TorchImageRegressionDataset(
        catalog, fold.test_indices, representation, standardizer, augment=False,
    )
    generator = torch.Generator().manual_seed(config.seed)
    common = {
        "batch_size": config.batch_size,
        "num_workers": config.num_workers,
        "pin_memory": torch.cuda.is_available(),
        "persistent_workers": config.num_workers > 0,
        "worker_init_fn": _seed_worker,
    }
    return TrainingLoaders(
        train=DataLoader(train_dataset, shuffle=True, generator=generator, **common),
        test=DataLoader(test_dataset, shuffle=False, **common),
        standardizer=standardizer,
    )


def create_early_stopping_loaders(
        catalog: RegressionCatalog, outer_fold: SpatialFold,
        inner_split: InnerValidationSplit, representation: str,
        config: TrainingConfig = TrainingConfig(), *,
        augment_spatial: bool = True) -> ValidationTrainingLoaders:
    """Build fitting, validation, and outer-test loaders without target leakage."""
    if representation not in ("spatial", "radial"):
        raise ValueError("representation must be 'spatial' or 'radial'.")
    if inner_split.outer_fold != outer_fold.fold:
        raise ValueError("The inner validation split belongs to a different outer fold.")
    if config.batch_size <= 0 or config.num_workers < 0:
        raise ValueError("Batch size must be positive and worker count cannot be negative.")
    fit_indices = np.asarray(inner_split.fit_indices, dtype=np.int64)
    validation_indices = np.asarray(inner_split.validation_indices, dtype=np.int64)
    test_indices = np.asarray(outer_fold.test_indices, dtype=np.int64)
    if not set(fit_indices).issubset(outer_fold.train_indices) \
            or not set(validation_indices).issubset(outer_fold.train_indices):
        raise ValueError("Inner fitting and validation indices must come from outer training.")
    if set(fit_indices).intersection(validation_indices) \
            or set(fit_indices).intersection(test_indices) \
            or set(validation_indices).intersection(test_indices):
        raise ValueError("Fitting, validation, and test loader indices must be disjoint.")

    standardizer = TargetStandardizer.fit(
        catalog.samples.iloc[fit_indices]["lst_c"].to_numpy()
    )
    fit_dataset = TorchImageRegressionDataset(
        catalog, fit_indices, representation, standardizer,
        augment=augment_spatial and representation == "spatial",
    )
    validation_dataset = TorchImageRegressionDataset(
        catalog, validation_indices, representation, standardizer, augment=False,
    )
    test_dataset = TorchImageRegressionDataset(
        catalog, test_indices, representation, standardizer, augment=False,
    )
    generator = torch.Generator().manual_seed(config.seed)
    common = {
        "batch_size": config.batch_size,
        "num_workers": config.num_workers,
        "pin_memory": torch.cuda.is_available(),
        "persistent_workers": config.num_workers > 0,
        "worker_init_fn": _seed_worker,
    }
    return ValidationTrainingLoaders(
        fit=DataLoader(fit_dataset, shuffle=True, generator=generator, **common),
        validation=DataLoader(validation_dataset, shuffle=False, **common),
        test=DataLoader(test_dataset, shuffle=False, **common),
        standardizer=standardizer,
    )


def regression_metrics(targets_c, predictions_c) -> dict:
    """Return the fixed raw-Celsius metric set used by the notebook."""
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


def pooled_regression_metrics(results) -> dict:
    """Compute sample-weighted metrics from concatenated out-of-fold results."""
    result_list = tuple(results)
    if not result_list:
        raise ValueError("At least one fold result is required for pooled metrics.")
    targets = np.concatenate([np.asarray(result.targets_c) for result in result_list])
    predictions = np.concatenate([np.asarray(result.predictions_c) for result in result_list])
    return regression_metrics(targets, predictions)


def _resolve_device(device=None) -> torch.device:
    if device is None:
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    resolved = torch.device(device)
    if resolved.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available to PyTorch.")
    return resolved


def _shutdown_loader(loader: DataLoader):
    iterator = getattr(loader, "_iterator", None)
    if iterator is not None and hasattr(iterator, "_shutdown_workers"):
        iterator._shutdown_workers()
        loader._iterator = None
    if hasattr(loader.dataset, "close"):
        loader.dataset.close()


def _validation_mse(
        model: nn.Module, loader: DataLoader, criterion: nn.Module,
        device: torch.device, use_amp: bool) -> float:
    model.eval()
    loss_sum = 0.0
    sample_count = 0
    with torch.inference_mode():
        for batch in loader:
            inputs = batch["input"].to(device, non_blocking=True)
            targets = batch["target"].to(device, non_blocking=True)
            with torch.autocast(
                    device_type=device.type, dtype=torch.float16, enabled=use_amp):
                loss = criterion(model(inputs), targets)
            batch_size = int(targets.shape[0])
            loss_sum += float(loss) * batch_size
            sample_count += batch_size
    if not sample_count:
        raise ValueError("Validation loader produced no samples.")
    return loss_sum / sample_count


def train_with_early_stopping(
        catalog: RegressionCatalog, outer_fold: SpatialFold,
        inner_split: InnerValidationSplit, representation: str,
        config: TrainingConfig = TrainingConfig(),
        stopping: EarlyStoppingConfig = EarlyStoppingConfig(), *,
        augment_spatial: bool = True, device=None,
        verbose: bool = True) -> EarlyStoppingTrainingResult:
    """Train against an inner validation split and test the restored best model once."""
    if config.learning_rate <= 0 or config.weight_decay < 0:
        raise ValueError("Training configuration has invalid optimisation values.")
    if stopping.max_epochs <= 0 or stopping.patience <= 0 or stopping.min_delta < 0:
        raise ValueError("Early-stopping configuration contains invalid values.")
    set_reproducible_seed(config.seed)
    resolved_device = _resolve_device(device)
    loaders = create_early_stopping_loaders(
        catalog, outer_fold, inner_split, representation, config,
        augment_spatial=augment_spatial,
    )
    model = LSTRegressionCNN(dropout=config.dropout).to(resolved_device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay,
    )
    criterion = nn.MSELoss()
    use_amp = bool(config.amp and resolved_device.type == "cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    history = []
    best_epoch = 0
    best_validation_mse = math.inf
    best_state = None
    non_improving_epochs = 0
    try:
        for epoch in range(1, stopping.max_epochs + 1):
            model.train()
            loss_sum = 0.0
            sample_count = 0
            for batch in loaders.fit:
                inputs = batch["input"].to(resolved_device, non_blocking=True)
                targets = batch["target"].to(resolved_device, non_blocking=True)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(
                        device_type=resolved_device.type, dtype=torch.float16,
                        enabled=use_amp):
                    predictions = model(inputs)
                    loss = criterion(predictions, targets)
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
                batch_size = int(targets.shape[0])
                loss_sum += float(loss.detach()) * batch_size
                sample_count += batch_size
            if not sample_count:
                raise ValueError("Fitting loader produced no samples.")
            train_mse = loss_sum / sample_count
            validation_mse = _validation_mse(
                model, loaders.validation, criterion, resolved_device, use_amp,
            )
            improved = validation_mse < best_validation_mse - stopping.min_delta
            if improved:
                best_epoch = epoch
                best_validation_mse = validation_mse
                best_state = {
                    name: value.detach().cpu().clone()
                    for name, value in model.state_dict().items()
                }
                non_improving_epochs = 0
            else:
                non_improving_epochs += 1
            history.append({
                "epoch": epoch,
                "train_mse_standardized": train_mse,
                "validation_mse_standardized": validation_mse,
                "improved": bool(improved),
            })
            if verbose:
                marker = " *" if improved else ""
                print(
                    f"fold {outer_fold.fold} {representation} epoch "
                    f"{epoch:02d}/{stopping.max_epochs}: train MSE = {train_mse:.5f}, "
                    f"validation MSE = {validation_mse:.5f}{marker}",
                    flush=True,
                )
            if non_improving_epochs >= stopping.patience:
                break

        stopped_epoch = len(history)
        if best_state is None or best_epoch <= 0:
            raise RuntimeError("Early stopping did not record a finite best model state.")
        model.load_state_dict(best_state)
        model.eval()
        prediction_parts = []
        target_parts = []
        index_parts = []
        with torch.inference_mode():
            for batch in loaders.test:
                inputs = batch["input"].to(resolved_device, non_blocking=True)
                with torch.autocast(
                        device_type=resolved_device.type, dtype=torch.float16,
                        enabled=use_amp):
                    normalized_predictions = model(inputs)
                predictions_c = loaders.standardizer.inverse(normalized_predictions.float())
                prediction_parts.append(predictions_c.cpu().numpy())
                target_parts.append(batch["target_c"].numpy())
                index_parts.append(batch["catalog_index"].numpy())
        predictions_c = np.concatenate(prediction_parts).astype(np.float32, copy=False)
        targets_c = np.concatenate(target_parts).astype(np.float32, copy=False)
        catalog_indices = np.concatenate(index_parts).astype(np.int64, copy=False)
        metrics = regression_metrics(targets_c, predictions_c)
    finally:
        _shutdown_loader(loaders.fit)
        _shutdown_loader(loaders.validation)
        _shutdown_loader(loaders.test)
    model = model.to("cpu")
    if resolved_device.type == "cuda":
        torch.cuda.empty_cache()
    return EarlyStoppingTrainingResult(
        representation=representation, outer_fold=int(outer_fold.fold), model=model,
        history=tuple(history), metrics=metrics, predictions_c=predictions_c,
        targets_c=targets_c, catalog_indices=catalog_indices, device=str(resolved_device),
        best_epoch=best_epoch, stopped_epoch=stopped_epoch,
        best_validation_mse=float(best_validation_mse),
    )


def train_and_evaluate(
        catalog: RegressionCatalog, fold: SpatialFold, representation: str,
        config: TrainingConfig = TrainingConfig(), *,
        standardizer: TargetStandardizer | None = None,
        augment_spatial: bool = True, device=None, verbose: bool = True) -> TrainingResult:
    """Train for the fixed epoch budget, then inspect the held-out set once."""
    if config.epochs <= 0 or config.learning_rate <= 0 or config.weight_decay < 0:
        raise ValueError("Training configuration has invalid optimisation values.")
    set_reproducible_seed(config.seed)
    resolved_device = _resolve_device(device)
    loaders = create_training_loaders(
        catalog, fold, representation, config, standardizer=standardizer,
        augment_spatial=augment_spatial,
    )
    model = LSTRegressionCNN(dropout=config.dropout).to(resolved_device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay,
    )
    criterion = nn.MSELoss()
    use_amp = bool(config.amp and resolved_device.type == "cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    history = []
    try:
        for epoch in range(1, config.epochs + 1):
            model.train()
            loss_sum = 0.0
            sample_count = 0
            for batch in loaders.train:
                inputs = batch["input"].to(resolved_device, non_blocking=True)
                targets = batch["target"].to(resolved_device, non_blocking=True)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(
                        device_type=resolved_device.type, dtype=torch.float16,
                        enabled=use_amp):
                    predictions = model(inputs)
                    loss = criterion(predictions, targets)
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
                batch_size = int(targets.shape[0])
                loss_sum += float(loss.detach()) * batch_size
                sample_count += batch_size
            epoch_record = {
                "epoch": epoch,
                "train_mse_standardized": loss_sum / sample_count,
            }
            history.append(epoch_record)
            if verbose:
                print(
                    f"{representation} epoch {epoch:02d}/{config.epochs}: "
                    f"train standardized MSE = {epoch_record['train_mse_standardized']:.5f}",
                    flush=True,
                )

        model.eval()
        prediction_parts = []
        target_parts = []
        index_parts = []
        with torch.inference_mode():
            for batch in loaders.test:
                inputs = batch["input"].to(resolved_device, non_blocking=True)
                with torch.autocast(
                        device_type=resolved_device.type, dtype=torch.float16,
                        enabled=use_amp):
                    normalized_predictions = model(inputs)
                predictions_c = loaders.standardizer.inverse(normalized_predictions.float())
                prediction_parts.append(predictions_c.cpu().numpy())
                target_parts.append(batch["target_c"].numpy())
                index_parts.append(batch["catalog_index"].numpy())
        predictions_c = np.concatenate(prediction_parts).astype(np.float32, copy=False)
        targets_c = np.concatenate(target_parts).astype(np.float32, copy=False)
        catalog_indices = np.concatenate(index_parts).astype(np.int64, copy=False)
        metrics = regression_metrics(targets_c, predictions_c)
    finally:
        _shutdown_loader(loaders.train)
        _shutdown_loader(loaders.test)
    return TrainingResult(
        representation=representation, model=model, history=tuple(history), metrics=metrics,
        predictions_c=predictions_c, targets_c=targets_c,
        catalog_indices=catalog_indices, device=str(resolved_device),
    )
