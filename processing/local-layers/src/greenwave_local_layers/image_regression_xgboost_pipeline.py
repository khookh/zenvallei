"""Spatially validated XGBoost model used by the local ΔLST scenario.

The notebook is deliberately only a report front-end.  Feature extraction,
nested sector folds, parameter selection, leakage-safe feature elimination and
production-model persistence all live here so the runtime and verification use
the same implementation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import argparse
import json
from pathlib import Path

import numpy as np
import xgboost as xgb

from .constants import CACHE_ROOT
from .image_regression import (
    DEFAULT_OBSERVATION_ID,
    LAND_COVER_CHANNEL_NAMES,
    RADIAL_BAND_EDGES_METERS,
    SUPPORT_MASK,
    ImageRegressionDataset,
    make_sector_folds,
    prepare_regression_catalog,
    radial_band_fractions,
)
from .image_regression_training import regression_metrics
from .image_regression_xgboost import XGBoostConfig
from .scenario_land_cover import xgboost_land_cover_channels
from .sources import file_hash


@dataclass(frozen=True)
class XGBoostArtifactPaths:
    """One isolated, verifiable set of model-training artifacts."""

    root: Path
    model: Path
    report: Path
    features: Path
    outer_predictions: Path
    inference_grid: Path

    @classmethod
    def under(cls, root: Path):
        root = Path(root)
        return cls(
            root=root,
            model=root / "model.json",
            report=root / "report.json",
            features=root / "features.npz",
            outer_predictions=root / "outer-predictions.npz",
            inference_grid=root / "baseline-inference-grid.npz",
        )


DEFAULT_ARTIFACTS = XGBoostArtifactPaths.under(
    CACHE_ROOT / "image-regression" / "xgboost-2026",
)
MODEL_ROOT = DEFAULT_ARTIFACTS.root
MODEL_PATH = DEFAULT_ARTIFACTS.model
REPORT_PATH = DEFAULT_ARTIFACTS.report
FEATURE_CACHE_PATH = DEFAULT_ARTIFACTS.features
OUTER_PREDICTIONS_PATH = DEFAULT_ARTIFACTS.outer_predictions
INFERENCE_GRID_PATH = DEFAULT_ARTIFACTS.inference_grid
SEED = 42
EMBARGO_METERS = 200
OUTER_FOLDS = 5
INNER_FOLDS = 4
FEATURE_REMOVAL_TOLERANCE_C = 0.01
CONFIGURATION_NEAR_TIE_C = 0.005
FEATURE_CONTRACT_VERSION = 5


def feature_removal_within_tolerance(candidate_rmse_c, reference_rmse_c):
    """Return whether a simpler model stays inside the fixed 0.01°C RMSE tolerance."""
    return float(candidate_rmse_c) <= float(reference_rmse_c) + FEATURE_REMOVAL_TOLERANCE_C


def radial_band_edges(ring_width_meters=25):
    width = int(ring_width_meters)
    if width not in (5, 10, 20, 25, 50) or 100 % width:
        raise ValueError("Ring width must be 10, 20 or 25 metres over the fixed 100 m support.")
    return tuple(range(0, 101, width))


def radial_feature_names(ring_width_meters=25):
    edges = radial_band_edges(ring_width_meters)
    bands = tuple(zip(edges[:-1], edges[1:]))
    return tuple(
        f"{channel}_{lower}_{upper}m"
        for channel in LAND_COVER_CHANNEL_NAMES
        for lower, upper in bands
    )


def outside_training_ranges(features, feature_names, training_ranges):
    """Flag counterfactual rows beyond any retained training-feature range."""
    values = np.asarray(features, dtype=np.float32)
    names = tuple(feature_names)
    if values.ndim != 2 or values.shape[1] != len(names):
        raise ValueError("Feature rows do not match their names.")
    outside = np.zeros(len(values), dtype=bool)
    for column, name in enumerate(names):
        minimum, maximum = training_ranges[name]
        outside |= (values[:, column] < minimum) | (values[:, column] > maximum)
    return outside


def bounded_parameter_search(seed: int = SEED):
    """Return a deterministic search spanning every requested parameter."""
    recipes = (
        (.03, 3, 1, .85, .85, 0, 1), (.03, 5, 3, .85, .7, .05, 2),
        (.05, 3, 3, 1, .85, 0, 2), (.05, 4, 1, .8, 1, .05, 1),
        (.05, 6, 5, .8, .7, .1, 4), (.08, 2, 1, 1, 1, 0, 1),
        (.08, 4, 5, .75, .85, .1, 2), (.1, 3, 1, .7, .7, .2, 4),
    )
    return tuple(XGBoostConfig(
        num_boost_round=2_000, early_stopping_rounds=60,
        learning_rate=eta, max_depth=depth, min_child_weight=child,
        subsample=rows, colsample_bytree=columns, reg_alpha=alpha,
        reg_lambda=regularisation, seed=seed,
    ) for eta, depth, child, rows, columns, alpha, regularisation in recipes)


def extract_feature_matrix(
        catalog, *, force: bool = False,
        artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS):
    """Extract the 20 physical radial fractions once and cache them losslessly."""
    names = radial_feature_names()
    signature = file_hash(catalog.cache_dir / "manifest.json")
    if artifacts.features.exists() and not force:
        # np.load keeps the ZIP archive open on Windows.  Copy cache hits while
        # the context is active, and close cache misses before atomically
        # replacing the archive below.
        with np.load(artifacts.features, allow_pickle=False) as cached:
            if str(cached["catalog_signature"].item()) == signature \
                    and tuple(cached["feature_names"].tolist()) == names \
                    and int(cached.get("feature_contract_version", np.asarray(0)).item()) \
                    == FEATURE_CONTRACT_VERSION:
                return cached["features"].copy(), cached["targets"].copy(), names
    artifacts.root.mkdir(parents=True, exist_ok=True)
    features = np.empty((len(catalog.samples), len(names)), dtype=np.float32)
    dataset = ImageRegressionDataset(catalog)
    try:
        for index in range(len(dataset)):
            features[index] = radial_band_fractions(
                dataset.land_cover_patch(index), SUPPORT_MASK,
            ).reshape(-1)
            if index and index % 5_000 == 0:
                print(f"Extracted radial features for {index:,}/{len(dataset):,} Landsat observations…", flush=True)
    finally:
        dataset.close()
    targets = catalog.samples["lst_c"].to_numpy(dtype=np.float32)
    temporary = artifacts.features.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary, features=features, targets=targets,
        feature_names=np.asarray(names), catalog_signature=np.asarray(signature),
        feature_contract_version=np.asarray(FEATURE_CONTRACT_VERSION),
    )
    temporary.replace(artifacts.features)
    return features, targets, names


def _params(config: XGBoostConfig, device: str):
    return {
        "objective": "reg:squarederror", "eval_metric": "rmse",
        "tree_method": "hist", "device": device, "eta": config.learning_rate,
        "max_depth": config.max_depth, "min_child_weight": config.min_child_weight,
        "subsample": config.subsample, "colsample_bytree": config.colsample_bytree,
        "alpha": config.reg_alpha, "lambda": config.reg_lambda,
        "seed": config.seed, "verbosity": 0,
    }


def fit_validation(features, targets, fit_indices, validation_indices, feature_names,
                   config: XGBoostConfig, *, device="cpu"):
    names = tuple(feature_names)
    fit = xgb.DMatrix(features[fit_indices], label=targets[fit_indices], feature_names=list(names))
    validation = xgb.DMatrix(
        features[validation_indices], label=targets[validation_indices], feature_names=list(names),
    )
    history = {}
    booster = xgb.train(
        _params(config, device), fit, num_boost_round=config.num_boost_round,
        evals=[(validation, "validation")], early_stopping_rounds=config.early_stopping_rounds,
        evals_result=history, verbose_eval=False,
    )
    predictions = booster.predict(
        validation, iteration_range=(0, int(booster.best_iteration) + 1),
    )
    return {
        "booster": booster, "predictions": predictions,
        "rmse": float(np.sqrt(np.mean((predictions - targets[validation_indices]) ** 2))),
        "bestRound": int(booster.best_iteration) + 1,
    }


def inner_spatial_folds(samples, outer_fold, *, seed=SEED):
    """Build sector-grouped inner folds using only an outer fold's training data."""
    outer_indices = np.asarray(outer_fold.train_indices, dtype=np.int64)
    subset = samples.iloc[outer_indices].reset_index(drop=True)
    local = make_sector_folds(
        subset, n_splits=min(INNER_FOLDS, subset["sector_id"].nunique()),
        buffer_m=EMBARGO_METERS, seed=seed,
    )
    return tuple({
        "fit": outer_indices[np.asarray(fold.train_indices, dtype=np.int64)],
        "validation": outer_indices[np.asarray(fold.test_indices, dtype=np.int64)],
        "excluded": outer_indices[np.asarray(fold.excluded_buffer_indices, dtype=np.int64)],
        "fold": int(fold.fold),
    } for fold in local)


def evaluate_configuration(features, targets, names, inner_folds, config, *, device="cpu"):
    results = [fit_validation(
        features, targets, fold["fit"], fold["validation"], names, config, device=device,
    ) for fold in inner_folds]
    return {
        "meanRmseC": float(np.mean([item["rmse"] for item in results])),
        "bestRounds": [item["bestRound"] for item in results],
        "folds": results,
    }


def select_configuration(features, targets, names, inner_folds, candidates, *, device="cpu"):
    tested = []
    for config in candidates:
        evaluation = evaluate_configuration(features, targets, names, inner_folds, config, device=device)
        tested.append({"config": config, **evaluation})
    tested.sort(key=lambda item: (
        item["meanRmseC"], item["config"].max_depth,
        -item["config"].learning_rate, item["config"].reg_lambda,
    ))
    minimum_rmse = tested[0]["meanRmseC"]
    near_ties = [item for item in tested if item["meanRmseC"] <= minimum_rmse + CONFIGURATION_NEAR_TIE_C]
    near_ties.sort(key=lambda item: (
        item["config"].max_depth, -item["config"].min_child_weight,
        -item["config"].reg_lambda, -item["config"].reg_alpha,
        -item["config"].learning_rate,
    ))
    return near_ties[0], tested


def _permutation_importance(features, targets, names, inner_folds, config, *, device="cpu", seed=SEED):
    importance = np.zeros(len(names), dtype=np.float64)
    rng = np.random.default_rng(seed)
    for fold in inner_folds:
        fitted = fit_validation(
            features, targets, fold["fit"], fold["validation"], names, config, device=device,
        )
        validation = features[fold["validation"]]
        base = fitted["rmse"]
        for column in range(len(names)):
            permuted = validation.copy()
            permuted[:, column] = permuted[rng.permutation(len(permuted)), column]
            matrix = xgb.DMatrix(permuted, feature_names=list(names))
            prediction = fitted["booster"].predict(
                matrix, iteration_range=(0, fitted["bestRound"]),
            )
            rmse = np.sqrt(np.mean((prediction - targets[fold["validation"]]) ** 2))
            importance[column] += float(rmse - base)
    return importance / len(inner_folds)


def backward_feature_elimination(features, targets, all_names, inner_folds, config, *, device="cpu"):
    """Remove a validation-least-useful feature only within the 0.01°C rule."""
    active = list(range(len(all_names)))
    decisions = []
    current = evaluate_configuration(
        features[:, active], targets, tuple(all_names[i] for i in active), inner_folds, config, device=device,
    )["meanRmseC"]
    while len(active) > 1:
        names = tuple(all_names[i] for i in active)
        importance = _permutation_importance(
            features[:, active], targets, names, inner_folds, config, device=device,
            seed=SEED + len(decisions),
        )
        candidate_position = min(range(len(active)), key=lambda index: (importance[index], names[index]))
        candidate_active = active[:candidate_position] + active[candidate_position + 1:]
        candidate_names = tuple(all_names[i] for i in candidate_active)
        candidate_rmse = evaluate_configuration(
            features[:, candidate_active], targets, candidate_names, inner_folds, config, device=device,
        )["meanRmseC"]
        accepted = feature_removal_within_tolerance(candidate_rmse, current)
        decisions.append({
            "feature": names[candidate_position], "permutationImportanceC": float(importance[candidate_position]),
            "beforeRmseC": float(current), "afterRmseC": float(candidate_rmse), "removed": bool(accepted),
        })
        if not accepted:
            break
        active = candidate_active
        current = candidate_rmse
    return tuple(active), decisions, current


def _fit_fixed_rounds(features, targets, names, config, rounds, *, device="cpu"):
    matrix = xgb.DMatrix(features, label=targets, feature_names=list(names))
    return xgb.train(_params(config, device), matrix, num_boost_round=int(rounds), verbose_eval=False)


def prepare_inference_grid(
        catalog, booster, report, *, artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS,
        output_observation_id: str = DEFAULT_OBSERVATION_ID):
    """Cache baseline features/predictions for every valid 30 m scenario centre."""
    import geopandas as gpd
    import rasterio
    from pyproj import Transformer
    from rasterio.features import rasterize
    from rasterio.transform import array_bounds, rowcol

    from .constants import SECTORS_PATH
    from .image_regression import _ground_valid, _read_ground_arrays

    landsat_path = CACHE_ROOT / "landsat-temperature" / "analysis" / f"{output_observation_id}.tif"
    selected_names = tuple(report["final"]["retainedFeatures"])
    requested_sigma = int(report.get("final", {}).get("smoothingSigmaMeters", 0))
    if artifacts.inference_grid.exists() and artifacts.report.exists():
        try:
            previous = json.loads(artifacts.report.read_text(encoding="utf-8"))
            with np.load(artifacts.inference_grid, allow_pickle=False) as cached:
                same_model = previous.get("final", {}).get("modelSha256") \
                    == report.get("final", {}).get("modelSha256")
                same_features = tuple(cached["feature_names"].tolist()) == selected_names
                same_smoothing = "raw_predictions" in cached.files \
                    and int(cached.get("smoothing_sigma_meters", np.asarray(0)).item()) == requested_sigma
                valid_centre_count = int(len(cached["positions"]))
            verified_grid = previous.get("inferenceGrid", {}).get("sha256") \
                == file_hash(artifacts.inference_grid)
            if same_model and same_features and same_smoothing and verified_grid:
                return {
                    "path": str(artifacts.inference_grid), "sha256": file_hash(artifacts.inference_grid),
                    "validCentreCount": valid_centre_count,
                }
        except (json.JSONDecodeError, OSError, KeyError, ValueError):
            pass
    ring_width = int(report.get("final", {}).get("ringWidthMeters", 25))
    band_edges = radial_band_edges(ring_width)
    all_names = radial_feature_names(ring_width)
    selected_columns = [all_names.index(name) for name in selected_names]
    with rasterio.open(landsat_path) as output:
        sectors = gpd.read_file(SECTORS_PATH).to_crs(output.crs)
        scope = rasterize(
            ((geometry, 1) for geometry in sectors.geometry), out_shape=output.shape,
            transform=output.transform, fill=0, dtype="uint8",
        ).astype(bool)
        output_rows, output_columns = np.nonzero(scope)
        xs = output.transform.c + (output_columns + .5) * output.transform.a
        ys = output.transform.f + (output_rows + .5) * output.transform.e
        x_lambert, y_lambert = Transformer.from_crs(
            output.crs, "EPSG:31370", always_xy=True,
        ).transform(xs, ys)
        output_shape = output.shape
        output_transform = np.asarray(tuple(output.transform)[:6], dtype=np.float64)
    values, positions = [], []
    with rasterio.open(catalog.soil_path) as soil, rasterio.open(catalog.green_path) as green, \
            rasterio.open(catalog.urban_context_path) as urban, \
            rasterio.open(catalog.water_context_path) as water_context:
        for output_row, output_column, x, y in zip(
                output_rows, output_columns, x_lambert, y_lambert):
            source_row, source_column = rowcol(soil.transform, x, y)
            arrays = _read_ground_arrays((soil, green, urban, water_context), source_row, source_column)
            if arrays[0].shape != (200, 200) or not _ground_valid(*arrays[:3])[SUPPORT_MASK].all():
                continue
            soil_values, green_values, _urban_values, water_values = arrays
            patch = xgboost_land_cover_channels(
                green_values, soil_values, water_values != 0,
            )
            values.append(radial_band_fractions(
                patch, SUPPORT_MASK, band_edges=band_edges,
            ).reshape(-1)[selected_columns])
            positions.append((output_row, output_column, source_row, source_column))
    features = np.asarray(values, dtype=np.float32)
    raw_predictions = booster.predict(xgb.DMatrix(features, feature_names=list(selected_names)))
    positions = np.asarray(positions, dtype=np.int32)
    sigma_meters = requested_sigma
    if sigma_meters:
        from .image_regression_smoothing_benchmark import smooth_masked_predictions
        predictions = smooth_masked_predictions(
            raw_predictions, positions[:, 0], positions[:, 1], sigma_meters,
        ).astype(np.float32)
    else:
        predictions = raw_predictions.astype(np.float32)
    temporary = artifacts.inference_grid.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary, positions=positions, features=features, predictions=predictions,
        raw_predictions=np.asarray(raw_predictions, dtype=np.float32),
        feature_names=np.asarray(selected_names), output_shape=np.asarray(output_shape),
        output_transform=output_transform, smoothing_sigma_meters=np.asarray(sigma_meters),
    )
    temporary.replace(artifacts.inference_grid)
    return {"path": str(artifacts.inference_grid), "sha256": file_hash(artifacts.inference_grid),
            "validCentreCount": int(len(positions))}


def tune_and_train_scenario_model(
        *, force=False, device="cuda", search_budget=None,
        catalog_factory=prepare_regression_catalog,
        observation_id: str = DEFAULT_OBSERVATION_ID,
        artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS,
        output_observation_id: str = DEFAULT_OBSERVATION_ID):
    """Run nested spatial validation and persist the all-Zennevallei booster."""
    catalog = catalog_factory(observation_id, force=force)
    features, targets, names = extract_feature_matrix(
        catalog, force=force, artifacts=artifacts,
    )
    candidates = bounded_parameter_search()
    if search_budget is not None:
        candidates = candidates[:max(1, int(search_budget))]
    outer_folds = make_sector_folds(
        catalog.samples, n_splits=OUTER_FOLDS, buffer_m=EMBARGO_METERS, seed=SEED,
    )
    outer_reports = []
    outer_targets, outer_predictions = [], []
    for outer in outer_folds:
        print(f"Tuning outer spatial fold {outer.fold + 1}/{len(outer_folds)}…", flush=True)
        inner = inner_spatial_folds(catalog.samples, outer)
        selected, tested = select_configuration(
            features, targets, names, inner, candidates, device=device,
        )
        active, decisions, _ = backward_feature_elimination(
            features, targets, names, inner, selected["config"], device=device,
        )
        selected_names = tuple(names[index] for index in active)
        rounds = int(np.median(selected["bestRounds"]))
        booster = _fit_fixed_rounds(
            features[outer.train_indices][:, active], targets[outer.train_indices],
            selected_names, selected["config"], rounds, device=device,
        )
        test_matrix = xgb.DMatrix(features[outer.test_indices][:, active], feature_names=list(selected_names))
        predictions = booster.predict(test_matrix)
        metrics = regression_metrics(targets[outer.test_indices], predictions)
        outer_targets.append(targets[outer.test_indices])
        outer_predictions.append(predictions)
        outer_reports.append({
            "fold": int(outer.fold), "metrics": metrics, "bestRounds": rounds,
            "parameters": asdict(selected["config"]), "retainedFeatures": list(selected_names),
            "featureSelection": decisions,
            "testedConfigurations": [{
                "parameters": asdict(item["config"]), "meanSpatialRmseC": item["meanRmseC"],
                "bestRounds": item["bestRounds"],
            } for item in tested],
            "diagnostics": outer.diagnostics,
        })

    # The final recipe is selected once more using only full-data spatial folds;
    # outer-fold metrics above remain the unbiased performance estimate.
    full_outer = type(outer_folds[0])(
        fold=-1, train_indices=np.arange(len(features)), test_indices=np.array([], dtype=np.int64),
        excluded_buffer_indices=np.array([], dtype=np.int64),
        train_sector_ids=tuple(sorted(catalog.samples["sector_id"].unique())),
        test_sector_ids=(), diagnostics={},
    )
    full_folds = inner_spatial_folds(catalog.samples, full_outer)
    print("Selecting the full-data production recipe…", flush=True)
    selected, tested = select_configuration(features, targets, names, full_folds, candidates, device=device)
    active, decisions, selected_rmse = backward_feature_elimination(
        features, targets, names, full_folds, selected["config"], device=device,
    )
    selected_names = tuple(names[index] for index in active)
    selected_features = features[:, active]
    round_evaluation = evaluate_configuration(
        selected_features, targets, selected_names, full_folds, selected["config"], device=device,
    )
    rounds = int(np.median(round_evaluation["bestRounds"]))
    booster = _fit_fixed_rounds(
        selected_features, targets, selected_names, selected["config"], rounds, device=device,
    )
    artifacts.root.mkdir(parents=True, exist_ok=True)
    temporary_model = artifacts.model.with_suffix(".partial.json")
    booster.save_model(temporary_model)
    temporary_model.replace(artifacts.model)
    pooled_targets = np.concatenate(outer_targets)
    pooled_predictions = np.concatenate(outer_predictions)
    pooled = regression_metrics(pooled_targets, pooled_predictions)
    temporary_predictions = artifacts.outer_predictions.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary_predictions, observed_c=pooled_targets, predicted_c=pooled_predictions,
        residual_c=pooled_predictions - pooled_targets,
    )
    temporary_predictions.replace(artifacts.outer_predictions)
    gain = booster.get_score(importance_type="gain")
    report = {
        "schemaVersion": 4, "modelContractVersion": FEATURE_CONTRACT_VERSION,
        "observationId": observation_id,
        "target": catalog.manifest.get("target"),
        "sampleCount": int(len(features)), "sectorCount": int(catalog.samples["sector_id"].nunique()),
        "outerFolds": outer_reports, "pooledOuterMetrics": pooled,
        "final": {
            "parameters": asdict(selected["config"]), "boostRounds": rounds,
            "retainedFeatures": list(selected_names),
            "rejectedFeatures": [name for name in names if name not in selected_names],
            "featureSelection": decisions, "spatialCvRmseC": float(selected_rmse),
            "smoothingSigmaMeters": 0, "smoothingPromoted": False,
            "trainingRanges": {
                name: [float(selected_features[:, index].min()), float(selected_features[:, index].max())]
                for index, name in enumerate(selected_names)
            },
            "featureImportanceGain": {name: float(gain.get(name, 0.0)) for name in selected_names},
            "modelSha256": file_hash(artifacts.model), "xgboostVersion": xgb.__version__,
        },
        "featureNames": list(names), "folds": {"outer": OUTER_FOLDS, "inner": INNER_FOLDS,
                                                   "embargoMeters": EMBARGO_METERS, "seed": SEED},
        "catalogManifestSha256": file_hash(catalog.cache_dir / "manifest.json"),
        "outerPredictionsSha256": file_hash(artifacts.outer_predictions),
        "testedFullDataConfigurations": [{
            "parameters": asdict(item["config"]), "meanSpatialRmseC": item["meanRmseC"],
            "bestRounds": item["bestRounds"],
        } for item in tested],
    }
    print("Preparing baseline predictions on the common 30 m scenario grid…", flush=True)
    report["inferenceGrid"] = prepare_inference_grid(
        catalog, booster, report, artifacts=artifacts,
        output_observation_id=output_observation_id,
    )
    temporary_report = artifacts.report.with_suffix(".partial.json")
    temporary_report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_report.replace(artifacts.report)
    return report


def load_scenario_model(artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS):
    if not artifacts.model.exists() or not artifacts.report.exists() or not artifacts.features.exists():
        return None
    report = json.loads(artifacts.report.read_text(encoding="utf-8"))
    if report.get("modelContractVersion") != FEATURE_CONTRACT_VERSION:
        raise ValueError("The cached XGBoost scenario model uses an obsolete feature contract.")
    if report.get("final", {}).get("modelSha256") != file_hash(artifacts.model):
        raise ValueError("The cached XGBoost scenario model hash does not match its report.")
    if report.get("featureArtifactSha256") != file_hash(artifacts.features):
        raise ValueError("The cached XGBoost feature-contract artifact does not match its report.")
    with np.load(artifacts.features, allow_pickle=False) as feature_artifact:
        if int(feature_artifact["feature_contract_version"].item()) != FEATURE_CONTRACT_VERSION \
                or tuple(feature_artifact["feature_names"].tolist()) \
                != tuple(report.get("final", {}).get("retainedFeatures", ())):
            raise ValueError("The cached XGBoost feature artifact uses an incompatible contract.")
    booster = xgb.Booster()
    booster.load_model(artifacts.model)
    return booster, report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Tune and train the local scenario XGBoost model.")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--search-budget", type=int)
    args = parser.parse_args(argv)
    report = tune_and_train_scenario_model(
        force=args.force, device=args.device, search_budget=args.search_budget,
    )
    print(json.dumps({"model": str(MODEL_PATH), "pooled": report["pooledOuterMetrics"]}, indent=2))


if __name__ == "__main__":
    main()
