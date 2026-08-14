"""Resumable Optuna tuning for the local 2026 XGBoost ΔLST model.

One trial proposes the complete feature, booster and smoothing recipe and is
scored over all five sector-held-out folds.  The reported optimum is therefore
model-selection cross-validation, not an independent generalisation estimate.
Production files are replaced only when a paired sector bootstrap supports a
lower RMSE than the current production recipe on the identical folds.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import json
import math
from pathlib import Path
import os
import threading
import time

import numpy as np
import optuna
import rasterio
from rasterio.windows import Window
import xgboost as xgb

from .constants import CACHE_ROOT
from .image_regression import (
    DEFAULT_OBSERVATION_ID,
    ImageRegressionDataset,
    RING_INDEX,
    SUPPORT_MASK,
    make_sector_folds,
    prepare_regression_catalog,
)
from .image_regression_training import regression_metrics
from .image_regression_smoothing_benchmark import smooth_masked_predictions
from .image_regression_xgboost_pipeline import (
    EMBARGO_METERS,
    FEATURE_CONTRACT_VERSION,
    FEATURE_REMOVAL_TOLERANCE_C,
    INFERENCE_GRID_PATH,
    MODEL_PATH,
    MODEL_ROOT,
    OUTER_FOLDS,
    OUTER_PREDICTIONS_PATH,
    REPORT_PATH,
    SEED,
    XGBoostArtifactPaths,
    feature_removal_within_tolerance,
    prepare_inference_grid,
    radial_band_edges,
    radial_feature_names,
)
from .sources import file_hash
from .scenario_land_cover import xgboost_land_cover_channels


OPTUNA_ROOT = CACHE_ROOT / "image-regression" / "xgboost-optuna-2026-water-v5"
STUDY_PATH = OPTUNA_ROOT / "study.sqlite3"
REPORT_OUTPUT_PATH = OPTUNA_ROOT / "report.json"
PREDICTIONS_PATH = OPTUNA_ROOT / "predictions.npz"
NOTEBOOK_DIAGNOSTICS_PATH = OPTUNA_ROOT / "notebook-diagnostics.npz"
FEATURES_PATH = OPTUNA_ROOT / "features.npz"
STUDY_NAME = "zennevallei-xgboost-2026-exclusive-upper-surface-water-v5"
RING_WIDTHS_METERS = (5, 10, 20, 25, 50)
SMOOTHING_SIGMAS_METERS = (0, 15, 30, 45, 60)
MAX_BOOST_ROUNDS = 3_000
EARLY_STOPPING_ROUNDS = 80
BOOTSTRAP_DRAWS = 20_000
EXTRACTION_WORKERS = min(8, max(1, (os.cpu_count() or 2) // 2))
_worker_state = threading.local()
_ATOMIC_EDGES = tuple(sorted(set().union(*(
    radial_band_edges(width) for width in RING_WIDTHS_METERS
))))
_ATOMIC_SEGMENTS = tuple(zip(_ATOMIC_EDGES[:-1], _ATOMIC_EDGES[1:]))
_SEGMENT_OFFSETS = tuple((
    np.nonzero((RING_INDEX >= lower) & (RING_INDEX < upper))[0] - 100,
    np.nonzero((RING_INDEX >= lower) & (RING_INDEX < upper))[1] - 100,
) for lower, upper in _ATOMIC_SEGMENTS)
_SEGMENT_COUNTS = np.asarray([len(rows) for rows, _ in _SEGMENT_OFFSETS], dtype=np.float64)


def trial_parameter_contract():
    """The ten decision variables pinned by the product plan."""
    return (
        "ring_width_meters", "smoothing_sigma_meters", "learning_rate",
        "max_depth", "min_child_weight", "subsample", "colsample_bytree",
        "gamma", "reg_alpha", "reg_lambda",
    )


def suggest_parameters(trial):
    return {
        "ring_width_meters": trial.suggest_categorical(
            "ring_width_meters", list(RING_WIDTHS_METERS),
        ),
        "smoothing_sigma_meters": trial.suggest_categorical(
            "smoothing_sigma_meters", list(SMOOTHING_SIGMAS_METERS),
        ),
        "learning_rate": trial.suggest_float("learning_rate", .01, .20, log=True),
        "max_depth": trial.suggest_int("max_depth", 2, 8),
        "min_child_weight": trial.suggest_float("min_child_weight", 1, 32, log=True),
        "subsample": trial.suggest_float("subsample", .60, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", .50, 1.0),
        "gamma": trial.suggest_float("gamma", 0, 5),
        "reg_alpha": trial.suggest_float("reg_alpha", 1e-8, 10, log=True),
        "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 30, log=True),
    }


def _feature_signature(catalog):
    return {
        "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
        "contract": "mutually-exclusive-upper-surface-v5-landgebruik-water",
        "ringWidthsMeters": list(RING_WIDTHS_METERS),
    }


def _features_from_patch(patch):
    """Accumulate exact 1 m annuli once, then combine them into each ring width."""
    valid_rings = RING_INDEX[SUPPORT_MASK]
    counts = np.bincount(valid_rings, minlength=100).astype(np.float64)
    ring_sums = np.stack([
        np.bincount(valid_rings, weights=channel[SUPPORT_MASK], minlength=100)
        for channel in patch
    ])
    outputs = {}
    for width in RING_WIDTHS_METERS:
        edges = radial_band_edges(width)
        outputs[width] = np.concatenate([
            [ring_sums[channel, lower:upper].sum() / counts[lower:upper].sum()
             for lower, upper in zip(edges[:-1], edges[1:])]
            for channel in range(patch.shape[0])
        ]).astype(np.float32)
    return outputs


def _source_handles(catalog):
    key = (
        str(catalog.soil_path), str(catalog.green_path),
        str(catalog.urban_context_path), str(catalog.water_context_path),
    )
    if getattr(_worker_state, "source_key", None) != key:
        for source in getattr(_worker_state, "sources", ()):
            source.close()
        _worker_state.sources = tuple(rasterio.open(path) for path in key)
        _worker_state.source_key = key
    return _worker_state.sources


def _features_for_centres(channels, rows, columns):
    """Vectorise exact circular fractions for centres sharing one source window."""
    rows = np.asarray(rows, dtype=np.int64)
    columns = np.asarray(columns, dtype=np.int64)
    segment_sums = np.empty(
        (channels.shape[0], len(rows), len(_ATOMIC_SEGMENTS)), dtype=np.float64,
    )
    for segment, (row_offsets, column_offsets) in enumerate(_SEGMENT_OFFSETS):
        selected = channels[
            :, rows[:, None] + row_offsets[None, :],
            columns[:, None] + column_offsets[None, :],
        ]
        segment_sums[:, :, segment] = selected.sum(axis=2)
    outputs = {}
    for width in RING_WIDTHS_METERS:
        bands = []
        for lower, upper in zip(radial_band_edges(width)[:-1], radial_band_edges(width)[1:]):
            selected_segments = [
                index for index, (segment_lower, segment_upper) in enumerate(_ATOMIC_SEGMENTS)
                if segment_lower >= lower and segment_upper <= upper
            ]
            denominator = _SEGMENT_COUNTS[selected_segments].sum()
            bands.append(segment_sums[:, :, selected_segments].sum(axis=2) / denominator)
        outputs[width] = np.stack(bands, axis=2).transpose(1, 0, 2).reshape(len(rows), -1).astype(np.float32)
    return outputs


def _extract_block(catalog, indexes):
    indexes = np.asarray(indexes, dtype=np.int64)
    samples = catalog.samples.iloc[indexes]
    source_rows = samples["patch_center_row"].to_numpy(dtype=np.int64)
    source_columns = samples["patch_center_col"].to_numpy(dtype=np.int64)
    row_start, row_stop = int(source_rows.min()) - 100, int(source_rows.max()) + 100
    column_start, column_stop = int(source_columns.min()) - 100, int(source_columns.max()) + 100
    window = Window(
        column_start, row_start, column_stop - column_start, row_stop - row_start,
    )
    soil_source, green_source, urban_source, water_source = _source_handles(catalog)
    soil = soil_source.read(1, window=window)
    green = green_source.read(1, window=window)
    urban = urban_source.read(1, window=window)
    water = water_source.read(1, window=window) != 0
    channels = xgboost_land_cover_channels(green, soil, water)
    local_rows = source_rows - row_start
    local_columns = source_columns - column_start
    outputs = {
        width: np.empty((len(indexes), len(radial_feature_names(width))), dtype=np.float32)
        for width in RING_WIDTHS_METERS
    }
    batch_size = 64
    for start in range(0, len(indexes), batch_size):
        stop = min(start + batch_size, len(indexes))
        batch = _features_for_centres(
            channels, local_rows[start:stop], local_columns[start:stop],
        )
        for width in RING_WIDTHS_METERS:
            outputs[width][start:stop] = batch[width]
    return indexes, outputs


def extract_optuna_features(catalog, *, force=False, workers=EXTRACTION_WORKERS):
    """Extract all three ring representations from each physical patch once."""
    signature = _feature_signature(catalog)
    if FEATURES_PATH.exists() and not force:
        with np.load(FEATURES_PATH, allow_pickle=False) as cached:
            if json.loads(str(cached["signature"].item())) == signature:
                matrices = {
                    width: cached[f"features_{width}"].copy() for width in RING_WIDTHS_METERS
                }
                names = {
                    width: tuple(cached[f"names_{width}"].tolist()) for width in RING_WIDTHS_METERS
                }
                return matrices, cached["targets"].copy(), names

    OPTUNA_ROOT.mkdir(parents=True, exist_ok=True)
    matrices = {
        width: np.empty(
            (len(catalog.samples), len(radial_feature_names(width))), dtype=np.float32,
        ) for width in RING_WIDTHS_METERS
    }
    names = {width: radial_feature_names(width) for width in RING_WIDTHS_METERS}
    block_size = 1_024
    block_rows = catalog.samples["patch_center_row"].to_numpy(dtype=np.int64) // block_size
    block_columns = catalog.samples["patch_center_col"].to_numpy(dtype=np.int64) // block_size
    groups = {}
    for index, key in enumerate(zip(block_rows, block_columns)):
        groups.setdefault(key, []).append(index)
    blocks = [np.asarray(groups[key], dtype=np.int64) for key in sorted(groups)]
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, int(workers))) as executor:
        for indexes, extracted in executor.map(
                lambda values: _extract_block(catalog, values), blocks):
            for width in RING_WIDTHS_METERS:
                matrices[width][indexes] = extracted[width]
            completed += len(indexes)
            if completed == len(catalog.samples) or completed // 5_000 != (completed - len(indexes)) // 5_000:
                print(
                    f"Extracted Optuna features for {completed:,}/{len(catalog.samples):,} observations…",
                    flush=True,
                )
    targets = catalog.samples["lst_c"].to_numpy(dtype=np.float32)
    temporary = FEATURES_PATH.with_suffix(".partial.npz")
    values = {"targets": targets, "signature": np.asarray(json.dumps(signature, sort_keys=True))}
    for width in RING_WIDTHS_METERS:
        values[f"features_{width}"] = matrices[width]
        values[f"names_{width}"] = np.asarray(names[width])
    np.savez_compressed(temporary, **values)
    temporary.replace(FEATURES_PATH)
    return matrices, targets, names


def build_optuna_folds(samples):
    """Return the exact spatial folds shared by tuning, reporting and notebooks."""
    return make_sector_folds(
        samples, n_splits=OUTER_FOLDS, buffer_m=EMBARGO_METERS, seed=SEED,
    )


def _xgb_parameters(parameters, device):
    return {
        "objective": "reg:squarederror", "eval_metric": "rmse",
        "tree_method": "hist", "device": device,
        "eta": float(parameters["learning_rate"]),
        "max_depth": int(parameters["max_depth"]),
        "min_child_weight": float(parameters["min_child_weight"]),
        "subsample": float(parameters["subsample"]),
        "colsample_bytree": float(parameters["colsample_bytree"]),
        "gamma": float(parameters["gamma"]),
        "alpha": float(parameters["reg_alpha"]),
        "lambda": float(parameters["reg_lambda"]),
        "seed": SEED, "verbosity": 0,
    }


def _fit_fold(features, targets, samples, fold, names, parameters, *, device):
    fit = xgb.DMatrix(
        features[fold.train_indices], label=targets[fold.train_indices],
        feature_names=list(names),
    )
    validation = xgb.DMatrix(
        features[fold.test_indices], label=targets[fold.test_indices],
        feature_names=list(names),
    )
    history = {}
    booster = xgb.train(
        _xgb_parameters(parameters, device), fit,
        num_boost_round=MAX_BOOST_ROUNDS,
        evals=[(validation, "validation")],
        early_stopping_rounds=EARLY_STOPPING_ROUNDS,
        evals_result=history, verbose_eval=False,
    )
    pool = np.concatenate((fold.test_indices, fold.excluded_buffer_indices))
    raw_prediction = booster.predict(
        xgb.DMatrix(features[pool], feature_names=list(names)),
        iteration_range=(0, int(booster.best_iteration) + 1),
    )
    prediction = raw_prediction.copy()
    sigma = int(parameters["smoothing_sigma_meters"])
    if sigma:
        prediction = smooth_masked_predictions(
            prediction,
            samples.iloc[pool]["landsat_row"].to_numpy(dtype=np.int64),
            samples.iloc[pool]["landsat_col"].to_numpy(dtype=np.int64),
            sigma,
        )
    raw_selected = raw_prediction[:len(fold.test_indices)].astype(np.float32)
    selected = prediction[:len(fold.test_indices)].astype(np.float32)
    return {
        "booster": booster, "rawPredictions": raw_selected, "predictions": selected,
        "bestRound": int(booster.best_iteration) + 1,
        "metrics": regression_metrics(targets[fold.test_indices], selected),
        "pool": pool,
    }


def evaluate_parameters(
        matrices, targets, samples, names_by_width, folds, parameters, *,
        device="cuda", active_columns=None):
    """Evaluate one complete recipe across every fold and return pooled OOF values."""
    width = int(parameters["ring_width_meters"])
    features = matrices[width]
    names = names_by_width[width]
    if active_columns is not None:
        active_columns = tuple(int(value) for value in active_columns)
        features = features[:, active_columns]
        names = tuple(names[index] for index in active_columns)
    raw_predictions = np.full(len(samples), np.nan, dtype=np.float32)
    predictions = np.full(len(samples), np.nan, dtype=np.float32)
    fold_reports = []
    effective_device = str(device)
    for position, fold in enumerate(folds):
        try:
            result = _fit_fold(
                features, targets, samples, fold, names, parameters,
                device=effective_device,
            )
        except xgb.core.XGBoostError:
            if effective_device != "cuda":
                raise
            effective_device = "cpu"
            result = _fit_fold(
                features, targets, samples, fold, names, parameters, device="cpu",
            )
        raw_predictions[fold.test_indices] = result["rawPredictions"]
        predictions[fold.test_indices] = result["predictions"]
        fold_reports.append({
            "fold": int(fold.fold), "position": position,
            "bestRound": result["bestRound"], "metrics": result["metrics"],
        })
    if not np.all(np.isfinite(raw_predictions)) or not np.all(np.isfinite(predictions)):
        raise AssertionError("Every Optuna trial must produce all five held-out predictions.")
    return {
        "rawPredictions": raw_predictions, "predictions": predictions,
        "metrics": regression_metrics(targets, predictions),
        "folds": fold_reports, "device": effective_device,
        "featureNames": names,
    }


def select_smoothing_example_sector(
        sector_ids, raw_predictions, smoothed_predictions, *, minimum_observations=250):
    """Select the supported sector with the largest mean absolute smoothing change."""
    sector_ids = np.asarray(sector_ids).astype(str)
    raw_predictions = np.asarray(raw_predictions, dtype=np.float64)
    smoothed_predictions = np.asarray(smoothed_predictions, dtype=np.float64)
    if not (len(sector_ids) == len(raw_predictions) == len(smoothed_predictions)):
        raise ValueError("Smoothing-example arrays must have identical lengths.")
    if not np.all(np.isfinite(raw_predictions)) or not np.all(np.isfinite(smoothed_predictions)):
        raise ValueError("Smoothing-example predictions must be finite.")
    candidates = []
    for sector_id in sorted(np.unique(sector_ids)):
        selected = sector_ids == sector_id
        count = int(np.count_nonzero(selected))
        if count < int(minimum_observations):
            continue
        candidates.append({
            "sectorId": str(sector_id),
            "observationCount": count,
            "meanAbsoluteChangeC": float(np.mean(np.abs(
                smoothed_predictions[selected] - raw_predictions[selected],
            ))),
        })
    if not candidates:
        raise ValueError("No sector has enough observations for the smoothing illustration.")
    return min(candidates, key=lambda item: (-item["meanAbsoluteChangeC"], item["sectorId"]))


def _notebook_diagnostic_signature(catalog, experiment_report, production_report):
    return {
        "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
        "experimentReportSha256": file_hash(REPORT_OUTPUT_PATH),
        "productionReportSha256": file_hash(REPORT_PATH),
        "modelContractVersion": int(production_report["modelContractVersion"]),
        "selectedParameters": experiment_report["bestTrial"]["parameters"],
        "selectedFeatures": experiment_report["bestTrial"]["selectedFeatures"],
    }


def prepare_notebook_diagnostics(catalog=None, *, force=False, device="cuda"):
    """Cache aligned raw and smoothed out-of-fold predictions for the public notebook."""
    catalog = catalog or prepare_regression_catalog(DEFAULT_OBSERVATION_ID)
    if not REPORT_OUTPUT_PATH.exists() or not REPORT_PATH.exists():
        raise FileNotFoundError("Run the completed Optuna pipeline before notebook diagnostics.")
    experiment = json.loads(REPORT_OUTPUT_PATH.read_text(encoding="utf-8"))
    production = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    if experiment.get("observationId") != catalog.observation_id \
            or production.get("observationId") != catalog.observation_id:
        raise ValueError("Notebook diagnostics and production must use the same observation.")
    signature = _notebook_diagnostic_signature(catalog, experiment, production)
    expected_count = len(catalog.samples)
    if NOTEBOOK_DIAGNOSTICS_PATH.exists() and not force:
        with np.load(NOTEBOOK_DIAGNOSTICS_PATH, allow_pickle=False) as cached:
            cached_signature = json.loads(str(cached["signature"].item()))
            arrays = (
                cached["observed_c"], cached["predicted_raw_c"],
                cached["predicted_smoothed_c"], cached["residual_c"],
                cached["landsat_rows"], cached["landsat_columns"],
                cached["sector_ids"], cached["fold_ids"],
            )
            if cached_signature == signature and all(len(values) == expected_count for values in arrays) \
                    and all(np.all(np.isfinite(values)) for values in arrays[:4]):
                return NOTEBOOK_DIAGNOSTICS_PATH

    matrices, targets, names_by_width = extract_optuna_features(catalog)
    folds = build_optuna_folds(catalog.samples)
    best = experiment["bestTrial"]
    parameters = best["parameters"]
    width = int(parameters["ring_width_meters"])
    names = names_by_width[width]
    try:
        active_columns = tuple(names.index(name) for name in best["selectedFeatures"])
    except ValueError as error:
        raise ValueError("A selected notebook feature is absent from the cached contract.") from error
    evaluation = evaluate_parameters(
        matrices, targets, catalog.samples, names_by_width, folds, parameters,
        device=device, active_columns=active_columns,
    )
    fold_ids = np.full(expected_count, -1, dtype=np.int8)
    for fold in folds:
        fold_ids[fold.test_indices] = int(fold.fold)
    if np.any(fold_ids < 0):
        raise AssertionError("Every notebook observation must belong to one held-out fold.")
    raw = evaluation["rawPredictions"].astype(np.float32)
    smoothed = evaluation["predictions"].astype(np.float32)
    NOTEBOOK_DIAGNOSTICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = NOTEBOOK_DIAGNOSTICS_PATH.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary,
        signature=np.asarray(json.dumps(signature, sort_keys=True)),
        observed_c=np.asarray(targets, dtype=np.float32),
        predicted_raw_c=raw,
        predicted_smoothed_c=smoothed,
        residual_c=smoothed - np.asarray(targets, dtype=np.float32),
        landsat_rows=catalog.samples["landsat_row"].to_numpy(dtype=np.int64),
        landsat_columns=catalog.samples["landsat_col"].to_numpy(dtype=np.int64),
        sector_ids=catalog.samples["sector_id"].astype(str).to_numpy(dtype=str),
        fold_ids=fold_ids,
    )
    temporary.replace(NOTEBOOK_DIAGNOSTICS_PATH)
    return NOTEBOOK_DIAGNOSTICS_PATH


def create_or_load_study(path=STUDY_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sampler = optuna.samplers.TPESampler(seed=SEED)
    return optuna.create_study(
        study_name=STUDY_NAME, direction="minimize", sampler=sampler,
        pruner=optuna.pruners.NopPruner(),
        storage=f"sqlite:///{path.as_posix()}", load_if_exists=True,
    )


def completed_trials(study):
    return sum(trial.state == optuna.trial.TrialState.COMPLETE for trial in study.trials)


def optimise(study, matrices, targets, samples, names_by_width, folds, *, trials=50, device="cuda"):
    """Complete exactly the requested number of successful full-fold trials."""
    def objective(trial):
        started = time.perf_counter()
        parameters = suggest_parameters(trial)
        evaluation = evaluate_parameters(
            matrices, targets, samples, names_by_width, folds, parameters, device=device,
        )
        trial.set_user_attr("folds", evaluation["folds"])
        trial.set_user_attr("device", evaluation["device"])
        trial.set_user_attr("mae_c", evaluation["metrics"]["mae_c"])
        trial.set_user_attr("r2", evaluation["metrics"]["r2"])
        trial.set_user_attr("mean_error_c", evaluation["metrics"]["mean_error_c"])
        trial.set_user_attr("duration_seconds", time.perf_counter() - started)
        return evaluation["metrics"]["rmse_c"]

    failures = 0
    while completed_trials(study) < int(trials):
        before = completed_trials(study)
        study.optimize(objective, n_trials=int(trials) - before, catch=(RuntimeError, ValueError))
        if completed_trials(study) == before:
            failures += 1
            if failures >= 3:
                raise RuntimeError("Optuna could not complete another full five-fold trial.")
        else:
            failures = 0
    return study


def _permutation_importance(
        features, targets, samples, names, folds, parameters, *, device="cuda", seed=SEED):
    """Fold-held-out permutation importance with the selected smoothing applied."""
    squared = np.zeros(len(names), dtype=np.float64)
    counts = 0
    baseline_squared = 0.0
    rng = np.random.default_rng(seed)
    effective_device = device
    for fold in folds:
        result = _fit_fold(
            features, targets, samples, fold, names, parameters, device=effective_device,
        )
        booster = result["booster"]
        pool = result["pool"]
        validation_count = len(fold.test_indices)
        baseline_residual = result["predictions"] - targets[fold.test_indices]
        baseline_squared += float(np.sum(baseline_residual ** 2))
        pool_features = features[pool]
        for column in range(len(names)):
            permuted = pool_features.copy()
            permuted[:, column] = permuted[rng.permutation(len(permuted)), column]
            prediction = booster.predict(
                xgb.DMatrix(permuted, feature_names=list(names)),
                iteration_range=(0, result["bestRound"]),
            )
            sigma = int(parameters["smoothing_sigma_meters"])
            if sigma:
                prediction = smooth_masked_predictions(
                    prediction,
                    samples.iloc[pool]["landsat_row"].to_numpy(dtype=np.int64),
                    samples.iloc[pool]["landsat_col"].to_numpy(dtype=np.int64),
                    sigma,
                )
            residual = prediction[:validation_count] - targets[fold.test_indices]
            squared[column] += float(np.sum(residual ** 2))
        counts += validation_count
    baseline_rmse = math.sqrt(baseline_squared / counts)
    return np.sqrt(squared / counts) - baseline_rmse


def eliminate_features(
        matrices, targets, samples, names_by_width, folds, parameters, *, device="cuda"):
    width = int(parameters["ring_width_meters"])
    source = matrices[width]
    all_names = names_by_width[width]
    active = list(range(source.shape[1]))
    current = evaluate_parameters(
        matrices, targets, samples, names_by_width, folds, parameters,
        device=device, active_columns=active,
    )
    decisions = []
    effective_device = current["device"]
    optimum_rmse = current["metrics"]["rmse_c"]
    while len(active) > 1:
        names = tuple(all_names[index] for index in active)
        importance = _permutation_importance(
            source[:, active], targets, samples, names, folds, parameters,
            device=effective_device, seed=SEED + len(decisions),
        )
        position = min(range(len(active)), key=lambda index: (importance[index], names[index]))
        candidate = active[:position] + active[position + 1:]
        evaluated = evaluate_parameters(
            matrices, targets, samples, names_by_width, folds, parameters,
            device=effective_device, active_columns=candidate,
        )
        accepted = feature_removal_within_tolerance(
            evaluated["metrics"]["rmse_c"], optimum_rmse,
        )
        decisions.append({
            "feature": names[position], "permutationImportanceC": float(importance[position]),
            "beforeRmseC": current["metrics"]["rmse_c"],
            "afterRmseC": evaluated["metrics"]["rmse_c"], "removed": bool(accepted),
        })
        if not accepted:
            break
        active, current = candidate, evaluated
    return tuple(active), decisions, current


def resume_feature_elimination(report, names_by_width, matrices, targets, samples, folds,
                               parameters, *, device="cuda"):
    """Replay a completed elimination path under the global 0.01°C tolerance."""
    if not report or report.get("bestTrial", {}).get("number") is None:
        return None
    if report["bestTrial"]["parameters"] != parameters:
        return None
    width = int(parameters["ring_width_meters"])
    names = names_by_width[width]
    active = list(range(len(names)))
    accepted_decisions = []
    optimum = float(report["bestTrial"]["allFeatureRmseC"])
    for decision in report["bestTrial"].get("featureSelection", []):
        if not decision.get("removed") or decision["afterRmseC"] > optimum + FEATURE_REMOVAL_TOLERANCE_C:
            break
        position = next((index for index in active if names[index] == decision["feature"]), None)
        if position is None:
            return None
        active.remove(position)
        accepted_decisions.append(decision)
    if not accepted_decisions:
        return None
    evaluation = evaluate_parameters(
        matrices, targets, samples, names_by_width, folds, parameters,
        device=device, active_columns=active,
    )
    if evaluation["metrics"]["rmse_c"] > optimum + FEATURE_REMOVAL_TOLERANCE_C + 1e-9:
        raise AssertionError("Replayed feature selection exceeds the global tolerance.")
    return tuple(active), accepted_decisions, evaluation


def _production_recipe(report, names_by_width):
    final = report["final"]
    raw = final["parameters"]
    parameters = {
        "ring_width_meters": int(final.get("ringWidthMeters", 25)),
        "smoothing_sigma_meters": int(final.get("smoothingSigmaMeters", 0)),
        "learning_rate": float(raw.get("learning_rate", raw.get("eta", .05))),
        "max_depth": int(raw.get("max_depth", 4)),
        "min_child_weight": float(raw.get("min_child_weight", 1)),
        "subsample": float(raw.get("subsample", .8)),
        "colsample_bytree": float(raw.get("colsample_bytree", .8)),
        "gamma": float(raw.get("gamma", 0)),
        "reg_alpha": float(raw.get("reg_alpha", raw.get("alpha", 0))),
        "reg_lambda": float(raw.get("reg_lambda", raw.get("lambda", 1))),
    }
    names = names_by_width[parameters["ring_width_meters"]]
    selected = tuple(names.index(name) for name in final["retainedFeatures"])
    return parameters, selected


def paired_sector_bootstrap(samples, targets, current, tuned, *, draws=BOOTSTRAP_DRAWS, seed=SEED):
    sector_names = np.asarray(sorted(samples["sector_id"].astype(str).unique()))
    codes = np.searchsorted(sector_names, samples["sector_id"].astype(str).to_numpy())
    current_residual = np.asarray(current, dtype=np.float64) - targets
    tuned_residual = np.asarray(tuned, dtype=np.float64) - targets
    count = np.bincount(codes, minlength=len(sector_names)).astype(np.float64)
    current_squared = np.bincount(codes, weights=current_residual ** 2, minlength=len(sector_names))
    tuned_squared = np.bincount(codes, weights=tuned_residual ** 2, minlength=len(sector_names))
    rng = np.random.default_rng(seed)
    sampled = rng.integers(0, len(sector_names), size=(draws, len(sector_names)), dtype=np.int16)
    sample_count = count[sampled].sum(axis=1)
    difference = np.sqrt(tuned_squared[sampled].sum(axis=1) / sample_count) \
        - np.sqrt(current_squared[sampled].sum(axis=1) / sample_count)
    interval = [float(np.percentile(difference, 2.5)), float(np.percentile(difference, 97.5))]
    current_metrics = regression_metrics(targets, current)
    tuned_metrics = regression_metrics(targets, tuned)
    return {
        "method": "paired sector-cluster bootstrap", "draws": int(draws), "seed": int(seed),
        "sectorCount": int(len(sector_names)), "tunedMinusCurrentRmseCi95": interval,
        "pointDifferenceRmseC": tuned_metrics["rmse_c"] - current_metrics["rmse_c"],
        "pointDifferencePercent": (
            (tuned_metrics["rmse_c"] - current_metrics["rmse_c"])
            / current_metrics["rmse_c"] * 100
        ),
        "promote": bool(interval[1] < 0),
    }


def _train_all(features, targets, names, parameters, rounds, *, device):
    matrix = xgb.DMatrix(features, label=targets, feature_names=list(names))
    try:
        booster = xgb.train(
            _xgb_parameters(parameters, device), matrix, num_boost_round=int(rounds),
            verbose_eval=False,
        )
        return booster, device
    except xgb.core.XGBoostError:
        if device != "cuda":
            raise
        booster = xgb.train(
            _xgb_parameters(parameters, "cpu"), matrix, num_boost_round=int(rounds),
            verbose_eval=False,
        )
        return booster, "cpu"


def run_optuna_benchmark(
        *, trials=50, device="cuda", force_features=False,
        bootstrap_draws=BOOTSTRAP_DRAWS):
    catalog = prepare_regression_catalog(DEFAULT_OBSERVATION_ID, force=force_features)
    matrices, targets, names_by_width = extract_optuna_features(catalog, force=force_features)
    samples = catalog.samples.reset_index(drop=True)
    folds = build_optuna_folds(samples)
    study = optimise(
        create_or_load_study(), matrices, targets, samples, names_by_width, folds,
        trials=trials, device=device,
    )
    best_parameters = dict(study.best_trial.params)
    previous_experiment = None
    if REPORT_OUTPUT_PATH.exists():
        try:
            previous_experiment = json.loads(REPORT_OUTPUT_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            previous_experiment = None
    resumed = resume_feature_elimination(
        previous_experiment, names_by_width, matrices, targets, samples, folds,
        best_parameters, device=device,
    )
    if resumed is None:
        active, feature_decisions, tuned = eliminate_features(
            matrices, targets, samples, names_by_width, folds, best_parameters, device=device,
        )
    else:
        active, feature_decisions, tuned = resumed

    superseded_report = json.loads(REPORT_PATH.read_text(encoding="utf-8")) \
        if REPORT_PATH.exists() else None
    current_report = superseded_report
    if current_report and current_report.get("modelContractVersion") != FEATURE_CONTRACT_VERSION:
        # A score from an overlapping-channel model is not a promotion gate for
        # the corrected upper-surface contract. The obsolete artifact remains
        # unreadable until this fresh study publishes a complete replacement.
        current_report = None
    current = None
    if current_report:
        current_parameters, current_active = _production_recipe(current_report, names_by_width)
        current = evaluate_parameters(
            matrices, targets, samples, names_by_width, folds, current_parameters,
            device=device, active_columns=current_active,
        )
        bootstrap = paired_sector_bootstrap(
            samples, targets, current["predictions"], tuned["predictions"],
            draws=bootstrap_draws,
        )
        promote = bootstrap["promote"]
    else:
        current_parameters, current_active = None, None
        bootstrap = {"promote": True, "reason": "No current production model was available."}
        promote = True

    width = int(best_parameters["ring_width_meters"])
    selected_names = tuple(names_by_width[width][index] for index in active)
    selected_features = matrices[width][:, active]
    rounds = int(np.median([item["bestRound"] for item in tuned["folds"]]))
    candidate, final_device = _train_all(
        selected_features, targets, selected_names, best_parameters, rounds, device=device,
    )

    OPTUNA_ROOT.mkdir(parents=True, exist_ok=True)
    candidate_path = OPTUNA_ROOT / "candidate-model.json"
    candidate.save_model(candidate_path)
    trials_frame = study.trials_dataframe(attrs=("number", "value", "params", "state", "user_attrs"))
    trials_frame.to_csv(OPTUNA_ROOT / "trials.csv", index=False)
    try:
        importances = optuna.importance.get_param_importances(
            study, evaluator=optuna.importance.PedAnovaImportanceEvaluator(),
        )
    except (ImportError, RuntimeError, ValueError):
        importances = {}

    report = {
        "schemaVersion": 2, "modelContractVersion": FEATURE_CONTRACT_VERSION,
        "experiment": "xgboost-optuna-2026-exclusive-upper-surface-water-v5",
        "observationId": DEFAULT_OBSERVATION_ID,
        "interpretation": "Model-selection cross-validation; not an independent accuracy estimate.",
        "completedTrials": completed_trials(study), "requestedTrials": int(trials),
        "sampleCount": int(len(samples)), "sectorCount": int(samples["sector_id"].nunique()),
        "folds": [{"fold": int(fold.fold), **fold.diagnostics} for fold in folds],
        "bestTrial": {
            "number": int(study.best_trial.number), "parameters": best_parameters,
            "allFeatureRmseC": float(study.best_value),
            "selectedFeatureMetrics": tuned["metrics"],
            "selectedFeatureFolds": tuned["folds"],
            "selectedFeatures": list(selected_names),
            "rejectedFeatures": [name for name in names_by_width[width] if name not in selected_names],
            "featureSelection": feature_decisions, "boostRounds": rounds,
            "device": final_device, "candidateModelSha256": file_hash(candidate_path),
        },
        "parameterImportance": {key: float(value) for key, value in importances.items()},
        "currentProduction": None if current is None else {
            "parameters": current_parameters, "metrics": current["metrics"],
            "folds": current["folds"],
            "selectedFeatures": [names_by_width[current_parameters["ring_width_meters"]][i]
                                 for i in current_active],
            "modelSha256": file_hash(MODEL_PATH),
        },
        "supersededProduction": None if superseded_report is None else {
            "modelContractVersion": superseded_report.get("modelContractVersion"),
            "metrics": superseded_report.get("pooledOuterMetrics"),
            "modelSha256": superseded_report.get("final", {}).get("modelSha256"),
            "reason": (
                "Retained only for old/new validation traceability; it is not a "
                "promotion gate for the new analytical-water feature contract."
            ),
        },
        "pairedBootstrap": bootstrap, "promoted": bool(promote),
        "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
        "studyDatabaseSha256": file_hash(STUDY_PATH),
    }

    np.savez_compressed(
        PREDICTIONS_PATH, observed_c=targets,
        tuned_predicted_c=tuned["predictions"],
        current_predicted_c=(np.asarray([]) if current is None else current["predictions"]),
        sector_ids=samples["sector_id"].astype(str).to_numpy(),
        landsat_rows=samples["landsat_row"].to_numpy(),
        landsat_columns=samples["landsat_col"].to_numpy(),
    )
    report["predictionArtifactSha256"] = file_hash(PREDICTIONS_PATH)

    if promote:
        previous_model_hash = file_hash(MODEL_PATH) if MODEL_PATH.exists() else None
        staging = XGBoostArtifactPaths.under(OPTUNA_ROOT / "promotion-staging")
        staging.root.mkdir(parents=True, exist_ok=True)
        for path in (
                staging.model, staging.report, staging.features,
                staging.outer_predictions, staging.inference_grid):
            path.unlink(missing_ok=True)
        candidate.save_model(staging.model)
        gain = candidate.get_score(importance_type="gain")
        production_report = {
            "schemaVersion": 4, "modelContractVersion": FEATURE_CONTRACT_VERSION,
            "observationId": DEFAULT_OBSERVATION_ID,
            "sampleCount": int(len(samples)), "sectorCount": int(samples["sector_id"].nunique()),
            "pooledOuterMetrics": tuned["metrics"],
            "final": {
                "parameters": {
                    "num_boost_round": MAX_BOOST_ROUNDS,
                    "early_stopping_rounds": EARLY_STOPPING_ROUNDS,
                    **{key: value for key, value in best_parameters.items()
                       if key not in ("ring_width_meters", "smoothing_sigma_meters")},
                },
                "ringWidthMeters": width,
                "smoothingSigmaMeters": int(best_parameters["smoothing_sigma_meters"]),
                "smoothingPromoted": bool(best_parameters["smoothing_sigma_meters"]),
                "boostRounds": rounds, "retainedFeatures": list(selected_names),
                "rejectedFeatures": [name for name in names_by_width[width] if name not in selected_names],
                "featureSelection": feature_decisions,
                "spatialCvRmseC": tuned["metrics"]["rmse_c"],
                "trainingRanges": {
                    name: [float(selected_features[:, index].min()), float(selected_features[:, index].max())]
                    for index, name in enumerate(selected_names)
                },
                "featureImportanceGain": {
                    name: float(gain.get(name, 0.0)) for name in selected_names
                },
                "modelSha256": file_hash(staging.model), "xgboostVersion": xgb.__version__,
                "selectionMethod": "single-50-trial-five-fold-optuna",
            },
            "folds": {"outer": OUTER_FOLDS, "embargoMeters": EMBARGO_METERS, "seed": SEED},
            "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
            "optunaReport": str(REPORT_OUTPUT_PATH),
            "previousModelSha256": previous_model_hash,
            "supersededProduction": report["supersededProduction"],
        }
        np.savez_compressed(
            staging.outer_predictions, observed_c=targets, predicted_c=tuned["predictions"],
            residual_c=tuned["predictions"] - targets,
        )
        np.savez_compressed(
            staging.features,
            features=selected_features,
            targets=targets,
            feature_names=np.asarray(selected_names),
            catalog_signature=np.asarray(production_report["catalogManifestSha256"]),
            feature_contract_version=np.asarray(FEATURE_CONTRACT_VERSION),
        )
        production_report["featureArtifactSha256"] = file_hash(staging.features)
        production_report["inferenceGrid"] = prepare_inference_grid(
            catalog, candidate, production_report, artifacts=staging,
        )
        # The staged file is moved to the canonical artifact root only after
        # verification; persist its final location, not the temporary path.
        production_report["inferenceGrid"]["path"] = str(INFERENCE_GRID_PATH)
        staging.report.write_text(
            json.dumps(production_report, ensure_ascii=False, indent=2), encoding="utf-8",
        )

        with np.load(staging.features, allow_pickle=False) as staged_features, \
                np.load(staging.inference_grid, allow_pickle=False) as staged_grid:
            verified = (
                production_report["modelContractVersion"] == FEATURE_CONTRACT_VERSION
                and production_report["final"]["modelSha256"] == file_hash(staging.model)
                and production_report["catalogManifestSha256"]
                == file_hash(catalog.cache_dir / "manifest.json")
                and production_report["featureArtifactSha256"] == file_hash(staging.features)
                and production_report["inferenceGrid"]["sha256"]
                == file_hash(staging.inference_grid)
                and int(staged_features["feature_contract_version"].item())
                == FEATURE_CONTRACT_VERSION
                and tuple(staged_features["feature_names"].tolist()) == selected_names
                and tuple(staged_grid["feature_names"].tolist()) == selected_names
            )
        if not verified:
            raise RuntimeError("The staged XGBoost artifact bundle failed hash validation.")

        MODEL_ROOT.mkdir(parents=True, exist_ok=True)
        # The report is replaced last. A partial copy can therefore never make
        # a mixed artifact set appear valid to the live scenario registry.
        staging.model.replace(MODEL_PATH)
        staging.features.replace(MODEL_ROOT / "features.npz")
        staging.outer_predictions.replace(OUTER_PREDICTIONS_PATH)
        staging.inference_grid.replace(INFERENCE_GRID_PATH)
        staging.report.replace(REPORT_PATH)
        report["promotedModelSha256"] = file_hash(MODEL_PATH)

    temporary_report = REPORT_OUTPUT_PATH.with_suffix(".partial.json")
    temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_report.replace(REPORT_OUTPUT_PATH)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the five-fold Optuna scenario benchmark.")
    parser.add_argument("--trials", type=int, default=50)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--force-features", action="store_true")
    parser.add_argument("--bootstrap-draws", type=int, default=BOOTSTRAP_DRAWS)
    args = parser.parse_args(argv)
    report = run_optuna_benchmark(
        trials=args.trials, device=args.device, force_features=args.force_features,
        bootstrap_draws=args.bootstrap_draws,
    )
    print(json.dumps({
        "report": str(REPORT_OUTPUT_PATH), "completedTrials": report["completedTrials"],
        "bestRmseC": report["bestTrial"]["selectedFeatureMetrics"]["rmse_c"],
        "promoted": report["promoted"],
    }, indent=2))


if __name__ == "__main__":
    main()
