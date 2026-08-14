"""Fold-safe Gaussian smoothing benchmark for the 100 m XGBoost model.

Only predictions are smoothed. Landsat targets never enter the convolution.
Validation and test predictions are accompanied by predictions in their
spatial embargo buffers so the Gaussian support is complete without borrowing
from model-fitting sectors.
"""

from __future__ import annotations

from dataclasses import asdict
import argparse
import json
from pathlib import Path

import numpy as np
import xgboost as xgb
from scipy.ndimage import gaussian_filter

from .constants import CACHE_ROOT
from .image_regression import DEFAULT_OBSERVATION_ID, make_sector_folds, prepare_regression_catalog
from .image_regression_training import regression_metrics
from .image_regression_xgboost_pipeline import (
    EMBARGO_METERS,
    FEATURE_CONTRACT_VERSION,
    FEATURE_REMOVAL_TOLERANCE_C,
    INNER_FOLDS,
    OUTER_FOLDS,
    DEFAULT_ARTIFACTS,
    SEED,
    XGBoostArtifactPaths,
    _fit_fixed_rounds,
    _permutation_importance,
    backward_feature_elimination,
    bounded_parameter_search,
    evaluate_configuration,
    extract_feature_matrix,
    prepare_inference_grid,
    select_configuration,
)
from .sources import file_hash


BENCHMARK_ROOT = CACHE_ROOT / "image-regression" / "xgboost-smoothing-benchmark-2026"
BENCHMARK_REPORT_PATH = BENCHMARK_ROOT / "report.json"
BENCHMARK_PREDICTIONS_PATH = BENCHMARK_ROOT / "outer-predictions.npz"
SIGMA_CANDIDATES_METERS = (0, 15, 30, 45, 60)
GRID_RESOLUTION_METERS = 30
KERNEL_TRUNCATION_SIGMA = 3
BOOTSTRAP_DRAWS = 20_000


def smooth_masked_predictions(predictions, rows, columns, sigma_meters):
    """Normalised Gaussian convolution on sparse aligned 30 m centres."""
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
        numerator, sigma=sigma_pixels, mode="constant", cval=0.0,
        radius=radius,
    )
    normaliser = gaussian_filter(
        weights, sigma=sigma_pixels, mode="constant", cval=0.0,
        radius=radius,
    )
    selected_weights = normaliser[local_rows, local_columns]
    if np.any(selected_weights <= 0):
        raise AssertionError("Masked Gaussian smoothing lost a prediction centre.")
    return filtered[local_rows, local_columns] / selected_weights


def smoothing_support_meters(sigma_meters):
    return int(np.ceil(float(sigma_meters) * KERNEL_TRUNCATION_SIGMA))


def smoothing_is_embargo_safe(sigma_meters, embargo_meters=EMBARGO_METERS):
    return smoothing_support_meters(sigma_meters) <= int(embargo_meters)


def _params(config, device):
    return {
        "objective": "reg:squarederror", "eval_metric": "rmse",
        "tree_method": "hist", "device": device, "eta": config.learning_rate,
        "max_depth": config.max_depth, "min_child_weight": config.min_child_weight,
        "subsample": config.subsample, "colsample_bytree": config.colsample_bytree,
        "alpha": config.reg_alpha, "lambda": config.reg_lambda,
        "seed": config.seed, "verbosity": 0,
    }


def _fit_and_predict_pool(features, targets, fold, names, config, *, device):
    fitting = xgb.DMatrix(
        features[fold["fit"]], label=targets[fold["fit"]], feature_names=list(names),
    )
    validation = xgb.DMatrix(
        features[fold["validation"]], label=targets[fold["validation"]],
        feature_names=list(names),
    )
    booster = xgb.train(
        _params(config, device), fitting, num_boost_round=config.num_boost_round,
        evals=[(validation, "validation")],
        early_stopping_rounds=config.early_stopping_rounds, verbose_eval=False,
    )
    pool = np.concatenate((fold["validation"], fold["excluded"]))
    predictions = booster.predict(
        xgb.DMatrix(features[pool], feature_names=list(names)),
        iteration_range=(0, int(booster.best_iteration) + 1),
    )
    return predictions, pool, int(booster.best_iteration) + 1


def evaluate_smoothing_configuration(
        features, targets, samples, names, folds, config, *, device="cpu",
        sigmas=SIGMA_CANDIDATES_METERS):
    """Score all sigma candidates without ever smoothing observed targets."""
    squared_error = {int(sigma): 0.0 for sigma in sigmas}
    counts = {int(sigma): 0 for sigma in sigmas}
    rounds = []
    per_fold = []
    for fold in folds:
        predictions, pool, best_round = _fit_and_predict_pool(
            features, targets, fold, names, config, device=device,
        )
        rounds.append(best_round)
        rows = samples.iloc[pool]["landsat_row"].to_numpy(dtype=np.int64)
        columns = samples.iloc[pool]["landsat_col"].to_numpy(dtype=np.int64)
        validation_count = len(fold["validation"])
        fold_scores = {}
        for sigma in sigmas:
            smoothed = smooth_masked_predictions(predictions, rows, columns, sigma)
            residual = smoothed[:validation_count] - targets[fold["validation"]]
            squared_error[int(sigma)] += float(np.sum(residual ** 2))
            counts[int(sigma)] += validation_count
            fold_scores[str(int(sigma))] = float(np.sqrt(np.mean(residual ** 2)))
        per_fold.append({"fold": int(fold["fold"]), "rmseBySigmaC": fold_scores})
    rmse = {
        sigma: float(np.sqrt(squared_error[sigma] / counts[sigma]))
        for sigma in squared_error
    }
    selected_sigma = min(rmse, key=lambda sigma: (rmse[sigma], sigma))
    return {
        "selectedSigmaMeters": int(selected_sigma),
        "selectedRmseC": rmse[selected_sigma],
        "rmseBySigmaC": {str(key): value for key, value in rmse.items()},
        "bestRounds": rounds,
        "folds": per_fold,
    }


def select_smoothing_configuration(
        features, targets, samples, names, folds, candidates, *, device="cpu"):
    tested = []
    for config in candidates:
        evaluation = evaluate_smoothing_configuration(
            features, targets, samples, names, folds, config, device=device,
        )
        tested.append({"config": config, **evaluation})
    tested.sort(key=lambda item: (
        item["selectedRmseC"], item["config"].max_depth,
        -item["config"].learning_rate, item["selectedSigmaMeters"],
    ))
    return tested[0], tested


def smoothing_aware_feature_elimination(
        features, targets, samples, all_names, folds, config, *, device="cpu"):
    """Use fold-only importance and fold-only smoothed RMSE for removals."""
    active = list(range(len(all_names)))
    decisions = []
    current = evaluate_smoothing_configuration(
        features, targets, samples, all_names, folds, config, device=device,
    )
    while len(active) > 1:
        names = tuple(all_names[index] for index in active)
        importance = _permutation_importance(
            features[:, active], targets, names, folds, config,
            device=device, seed=SEED + len(decisions),
        )
        position = min(range(len(active)), key=lambda index: (importance[index], names[index]))
        candidate_active = active[:position] + active[position + 1:]
        candidate_names = tuple(all_names[index] for index in candidate_active)
        candidate = evaluate_smoothing_configuration(
            features[:, candidate_active], targets, samples, candidate_names,
            folds, config, device=device,
        )
        accepted = candidate["selectedRmseC"] <= current["selectedRmseC"] + FEATURE_REMOVAL_TOLERANCE_C
        decisions.append({
            "feature": names[position],
            "permutationImportanceC": float(importance[position]),
            "beforeRmseC": float(current["selectedRmseC"]),
            "afterRmseC": float(candidate["selectedRmseC"]),
            "selectedSigmaMeters": int(candidate["selectedSigmaMeters"]),
            "removed": bool(accepted),
        })
        if not accepted:
            break
        active = candidate_active
        current = candidate
    return tuple(active), decisions, current


def _inner_folds(samples, outer_indices):
    outer_indices = np.asarray(outer_indices, dtype=np.int64)
    subset = samples.iloc[outer_indices].reset_index(drop=True)
    local = make_sector_folds(
        subset, n_splits=min(INNER_FOLDS, subset["sector_id"].nunique()),
        buffer_m=EMBARGO_METERS, seed=SEED,
    )
    return tuple({
        "fit": outer_indices[np.asarray(fold.train_indices, dtype=np.int64)],
        "validation": outer_indices[np.asarray(fold.test_indices, dtype=np.int64)],
        "excluded": outer_indices[np.asarray(fold.excluded_buffer_indices, dtype=np.int64)],
        "fold": int(fold.fold),
    } for fold in local)


def _predict_outer(
        features, targets, samples, fold, names, config, rounds, sigma, *, device):
    booster = _fit_fixed_rounds(
        features[fold.train_indices], targets[fold.train_indices], names,
        config, rounds, device=device,
    )
    pool = np.concatenate((fold.test_indices, fold.excluded_buffer_indices))
    predictions = booster.predict(xgb.DMatrix(features[pool], feature_names=list(names)))
    rows = samples.iloc[pool]["landsat_row"].to_numpy(dtype=np.int64)
    columns = samples.iloc[pool]["landsat_col"].to_numpy(dtype=np.int64)
    smoothed = smooth_masked_predictions(predictions, rows, columns, sigma)
    return smoothed[:len(fold.test_indices)].astype(np.float32), booster


def _sector_bootstrap(samples, observed, raw, smoothed, *, draws=BOOTSTRAP_DRAWS, seed=SEED):
    sectors = np.asarray(sorted(samples["sector_id"].astype(str).unique()))
    codes = np.asarray([np.searchsorted(sectors, value) for value in samples["sector_id"].astype(str)])
    residuals = {
        "raw": np.asarray(raw, dtype=np.float64) - observed,
        "smoothed": np.asarray(smoothed, dtype=np.float64) - observed,
    }
    count = np.bincount(codes, minlength=len(sectors)).astype(np.float64)
    absolute = {
        key: np.bincount(codes, weights=np.abs(value), minlength=len(sectors))
        for key, value in residuals.items()
    }
    squared = {
        key: np.bincount(codes, weights=value ** 2, minlength=len(sectors))
        for key, value in residuals.items()
    }
    rng = np.random.default_rng(seed)
    sampled = rng.integers(0, len(sectors), size=(draws, len(sectors)), dtype=np.int16)
    sampled_count = count[sampled].sum(axis=1)
    metrics = {}
    for key in residuals:
        metrics[key] = {
            "rmse": np.sqrt(squared[key][sampled].sum(axis=1) / sampled_count),
            "mae": absolute[key][sampled].sum(axis=1) / sampled_count,
        }
    intervals = {}
    for metric in ("rmse", "mae"):
        delta = metrics["smoothed"][metric] - metrics["raw"][metric]
        intervals[metric] = [float(np.percentile(delta, 2.5)), float(np.percentile(delta, 97.5))]
    point_raw = regression_metrics(observed, raw)
    point_smoothed = regression_metrics(observed, smoothed)
    improvement = point_raw["rmse_c"] - point_smoothed["rmse_c"]
    return {
        "method": "paired sector-cluster bootstrap", "draws": int(draws), "seed": int(seed),
        "sectorCount": int(len(sectors)),
        "smoothedMinusRawCi95": {"rmseC": intervals["rmse"], "maeC": intervals["mae"]},
        "rmseImprovementC": float(improvement),
        "rmseImprovementPercent": float(improvement / point_raw["rmse_c"] * 100),
        "promoteSmoothing": bool(intervals["rmse"][1] < 0),
    }


def _compact(tested):
    return [{
        "parameters": asdict(item["config"]),
        "selectedSigmaMeters": int(item["selectedSigmaMeters"]),
        "selectedRmseC": float(item["selectedRmseC"]),
        "rmseBySigmaC": item["rmseBySigmaC"],
        "bestRounds": [int(value) for value in item["bestRounds"]],
    } for item in tested]


def _metric_comparison(raw, smoothed):
    """Report signed smoothed-minus-raw changes on the common OOF cohort."""
    comparison = {}
    for key in ("rmse_c", "mae_c", "r2", "mean_error_c"):
        raw_value = raw.get(key)
        smoothed_value = smoothed.get(key)
        if raw_value is None or smoothed_value is None:
            comparison[key] = {"absolute": None, "percent": None}
            continue
        absolute = float(smoothed_value - raw_value)
        comparison[key] = {
            "absolute": absolute,
            "percent": None if raw_value == 0 else float(absolute / abs(raw_value) * 100),
        }
    return comparison


def run_smoothing_benchmark(
        *, force_features=False, device="cuda", search_budget=None,
        bootstrap_draws=BOOTSTRAP_DRAWS,
        catalog_factory=prepare_regression_catalog,
        observation_id: str = DEFAULT_OBSERVATION_ID,
        artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS,
        benchmark_root: Path = BENCHMARK_ROOT,
        output_observation_id: str = DEFAULT_OBSERVATION_ID):
    """Retrain the corrected 100 m contract and conditionally promote smoothing."""
    if any(not smoothing_is_embargo_safe(sigma) for sigma in SIGMA_CANDIDATES_METERS):
        raise AssertionError("A smoothing kernel exceeds the 200 m spatial embargo.")
    catalog = catalog_factory(observation_id, force=force_features)
    features, targets, names = extract_feature_matrix(
        catalog, force=force_features, artifacts=artifacts,
    )
    samples = catalog.samples.reset_index(drop=True)
    candidates = bounded_parameter_search()
    if search_budget is not None:
        candidates = candidates[:max(1, int(search_budget))]
    outer_folds = make_sector_folds(
        samples, n_splits=OUTER_FOLDS, buffer_m=EMBARGO_METERS, seed=SEED,
    )
    raw_oof = np.full(len(samples), np.nan, dtype=np.float32)
    smooth_oof = np.full(len(samples), np.nan, dtype=np.float32)
    outer_reports = []
    for outer in outer_folds:
        print(f"Smoothing benchmark outer fold {outer.fold + 1}/{len(outer_folds)}...", flush=True)
        inner = _inner_folds(samples, outer.train_indices)
        raw_selected, raw_tested = select_configuration(
            features, targets, names, inner, candidates, device=device,
        )
        raw_active, raw_decisions, raw_inner_rmse = backward_feature_elimination(
            features, targets, names, inner, raw_selected["config"], device=device,
        )
        raw_names = tuple(names[index] for index in raw_active)
        raw_rounds = int(np.median(raw_selected["bestRounds"]))
        raw_predictions, _ = _predict_outer(
            features[:, raw_active], targets, samples, outer, raw_names,
            raw_selected["config"], raw_rounds, 0, device=device,
        )

        selected, tested = select_smoothing_configuration(
            features, targets, samples, names, inner, candidates, device=device,
        )
        active, decisions, evaluation = smoothing_aware_feature_elimination(
            features, targets, samples, names, inner, selected["config"], device=device,
        )
        selected_names = tuple(names[index] for index in active)
        rounds = int(np.median(selected["bestRounds"]))
        smooth_predictions, _ = _predict_outer(
            features[:, active], targets, samples, outer, selected_names,
            selected["config"], rounds, evaluation["selectedSigmaMeters"], device=device,
        )
        raw_oof[outer.test_indices] = raw_predictions
        smooth_oof[outer.test_indices] = smooth_predictions
        outer_reports.append({
            "fold": int(outer.fold),
            "rawPipeline": {
                "parameters": asdict(raw_selected["config"]),
                "retainedFeatures": list(raw_names), "featureSelection": raw_decisions,
                "boostRounds": raw_rounds, "selectedInnerRmseC": float(raw_inner_rmse),
                "testedConfigurations": [{
                    "parameters": asdict(item["config"]),
                    "meanSpatialRmseC": float(item["meanRmseC"]),
                    "bestRounds": [int(value) for value in item["bestRounds"]],
                } for item in raw_tested],
            },
            "smoothingAwarePipeline": {
                "parameters": asdict(selected["config"]),
                "retainedFeatures": list(selected_names), "featureSelection": decisions,
                "boostRounds": rounds, "selectedSigmaMeters": int(evaluation["selectedSigmaMeters"]),
                "sigmaRmseC": evaluation["rmseBySigmaC"],
                "testedConfigurations": _compact(tested),
            },
            "selectedSigmaMeters": int(evaluation["selectedSigmaMeters"]),
            "sigmaRmseC": evaluation["rmseBySigmaC"],
            "rawMetrics": regression_metrics(targets[outer.test_indices], raw_predictions),
            "smoothedMetrics": regression_metrics(targets[outer.test_indices], smooth_predictions),
            "diagnostics": outer.diagnostics,
        })
    if not np.all(np.isfinite(raw_oof)) or not np.all(np.isfinite(smooth_oof)):
        raise AssertionError("The smoothing benchmark did not produce complete OOF predictions.")

    bootstrap = _sector_bootstrap(
        samples, targets, raw_oof, smooth_oof, draws=bootstrap_draws, seed=SEED,
    )
    full_inner = _inner_folds(samples, np.arange(len(samples), dtype=np.int64))
    raw_selected, raw_tested = select_configuration(
        features, targets, names, full_inner, candidates, device=device,
    )
    raw_active, raw_decisions, raw_inner_rmse = backward_feature_elimination(
        features, targets, names, full_inner, raw_selected["config"], device=device,
    )
    raw_names = tuple(names[index] for index in raw_active)
    raw_round_evaluation = evaluate_configuration(
        features[:, raw_active], targets, raw_names, full_inner,
        raw_selected["config"], device=device,
    )
    raw_rounds = int(np.median(raw_round_evaluation["bestRounds"]))
    raw_booster = _fit_fixed_rounds(
        features[:, raw_active], targets, raw_names,
        raw_selected["config"], raw_rounds, device=device,
    )

    selected, tested = select_smoothing_configuration(
        features, targets, samples, names, full_inner, candidates, device=device,
    )
    active, decisions, evaluation = smoothing_aware_feature_elimination(
        features, targets, samples, names, full_inner, selected["config"], device=device,
    )
    selected_names = tuple(names[index] for index in active)
    rounds = int(np.median(selected["bestRounds"]))
    production_sigma = int(evaluation["selectedSigmaMeters"]) if bootstrap["promoteSmoothing"] else 0
    smoothing_booster = _fit_fixed_rounds(
        features[:, active], targets, selected_names, selected["config"], rounds, device=device,
    )
    if production_sigma:
        booster = smoothing_booster
        production_active = active
        production_names = selected_names
        production_config = selected["config"]
        production_rounds = rounds
        production_decisions = decisions
        production_rmse = evaluation["selectedRmseC"]
    else:
        booster = raw_booster
        production_active = raw_active
        production_names = raw_names
        production_config = raw_selected["config"]
        production_rounds = raw_rounds
        production_decisions = raw_decisions
        production_rmse = raw_inner_rmse
    artifacts.root.mkdir(parents=True, exist_ok=True)
    temporary_model = artifacts.model.with_suffix(".partial.json")
    booster.save_model(temporary_model)
    temporary_model.replace(artifacts.model)
    chosen_oof = smooth_oof if production_sigma else raw_oof
    temporary_outer = artifacts.outer_predictions.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary_outer,
        observed_c=targets, predicted_c=chosen_oof, residual_c=chosen_oof - targets,
        raw_predicted_c=raw_oof, smoothed_predicted_c=smooth_oof,
    )
    temporary_outer.replace(artifacts.outer_predictions)
    raw_metrics = regression_metrics(targets, raw_oof)
    smoothed_metrics = regression_metrics(targets, smooth_oof)
    report = {
        "schemaVersion": 4, "modelContractVersion": FEATURE_CONTRACT_VERSION,
        "observationId": observation_id, "sampleCount": int(len(samples)),
        "target": catalog.manifest.get("target"),
        "sectorCount": int(samples["sector_id"].nunique()),
        "outerFolds": outer_reports,
        "pooledOuterMetrics": regression_metrics(targets, chosen_oof),
        "pooledRawMetrics": raw_metrics,
        "pooledSmoothedMetrics": smoothed_metrics,
        "smoothedMinusRaw": _metric_comparison(raw_metrics, smoothed_metrics),
        "smoothingBenchmark": {
            "sigmaCandidatesMeters": list(SIGMA_CANDIDATES_METERS),
            "kernelTruncationSigma": KERNEL_TRUNCATION_SIGMA,
            "gridResolutionMeters": GRID_RESOLUTION_METERS,
            "bootstrap": bootstrap,
        },
        "final": {
            "parameters": asdict(production_config), "boostRounds": production_rounds,
            "retainedFeatures": list(production_names),
            "rejectedFeatures": [name for name in names if name not in production_names],
            "featureSelection": production_decisions,
            "spatialCvRmseC": float(production_rmse),
            "smoothingSigmaMeters": production_sigma,
            "smoothingCandidateSigmaMeters": int(evaluation["selectedSigmaMeters"]),
            "smoothingPromoted": bool(bootstrap["promoteSmoothing"]),
            "trainingRanges": {
                name: [
                    float(features[:, production_active[index]].min()),
                    float(features[:, production_active[index]].max()),
                ]
                for index, name in enumerate(production_names)
            },
            "featureImportanceGain": {
                name: float(booster.get_score(importance_type="gain").get(name, 0.0))
                for name in production_names
            },
            "modelSha256": file_hash(artifacts.model), "xgboostVersion": xgb.__version__,
        },
        "featureNames": list(names),
        "folds": {"outer": OUTER_FOLDS, "inner": INNER_FOLDS,
                  "embargoMeters": EMBARGO_METERS, "seed": SEED},
        "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
        "outerPredictionsSha256": file_hash(artifacts.outer_predictions),
        "testedFullDataConfigurations": {
            "raw": [{
                "parameters": asdict(item["config"]),
                "meanSpatialRmseC": float(item["meanRmseC"]),
                "bestRounds": [int(value) for value in item["bestRounds"]],
            } for item in raw_tested],
            "smoothingAware": _compact(tested),
        },
    }
    report["inferenceGrid"] = prepare_inference_grid(
        catalog, booster, report, artifacts=artifacts,
        output_observation_id=output_observation_id,
    )
    temporary_report = artifacts.report.with_suffix(".partial.json")
    temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_report.replace(artifacts.report)

    benchmark_root = Path(benchmark_root)
    benchmark_report_path = benchmark_root / "report.json"
    benchmark_predictions_path = benchmark_root / "outer-predictions.npz"
    benchmark_root.mkdir(parents=True, exist_ok=True)
    temporary_predictions = benchmark_predictions_path.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary_predictions, observed_c=targets,
        raw_predicted_c=raw_oof, smoothed_predicted_c=smooth_oof,
        sector_ids=samples["sector_id"].astype(str).to_numpy(),
    )
    temporary_predictions.replace(benchmark_predictions_path)
    benchmark_report = {
        "schemaVersion": 1, "experiment": "xgboost-100m-prediction-smoothing",
        "observationId": observation_id, "sampleCount": int(len(samples)),
        "outerFolds": outer_reports, "pooledRawMetrics": report["pooledRawMetrics"],
        "pooledSmoothedMetrics": report["pooledSmoothedMetrics"],
        "smoothedMinusRaw": report["smoothedMinusRaw"],
        "selectedSigmaByOuterFold": [item["selectedSigmaMeters"] for item in outer_reports],
        "finalCandidateSigmaMeters": int(evaluation["selectedSigmaMeters"]),
        "productionSigmaMeters": production_sigma, "pairedBootstrap": bootstrap,
        "productionModelSha256": report["final"]["modelSha256"],
        "predictionArtifactSha256": file_hash(benchmark_predictions_path),
    }
    temporary_benchmark = benchmark_report_path.with_suffix(".partial.json")
    temporary_benchmark.write_text(
        json.dumps(benchmark_report, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    temporary_benchmark.replace(benchmark_report_path)
    return benchmark_report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Benchmark fold-safe XGBoost prediction smoothing.")
    parser.add_argument("--force-features", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--search-budget", type=int)
    parser.add_argument("--bootstrap-draws", type=int, default=BOOTSTRAP_DRAWS)
    args = parser.parse_args(argv)
    report = run_smoothing_benchmark(
        force_features=args.force_features, device=args.device,
        search_budget=args.search_budget, bootstrap_draws=args.bootstrap_draws,
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
