"""Leakage-safe XGBoost benchmark for 100, 150 and 200 m land-cover support.

This experiment is intentionally isolated from the production scenario model.
It prepares one 200 m-complete cohort and one 40-column feature matrix, then
uses exact column prefixes for the smaller radii.  All radii therefore see the
same targets, sites, sectors and spatial folds.
"""

from __future__ import annotations

from dataclasses import asdict
import argparse
import gc
import json
import math
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import xgboost as xgb
from scipy.spatial import cKDTree

from .analysis_water import analysis_water_union, prepare_analysis_water_context
from .constants import CACHE_ROOT, SECTORS_PATH
from .density import aligned_bounds, ensure_halo_source
from .image_regression import (
    DEFAULT_OBSERVATION_ID,
    GREEN_YEAR,
    LAND_COVER_CHANNEL_NAMES,
    UA_VALID,
    _default_urban_atlas_source,
    _prepare_urban_context,
    _source_signature,
    _validate_aligned_sources,
    make_sector_folds,
    prepare_regression_catalog,
)
from .image_regression_training import regression_metrics
from .image_regression_xgboost_pipeline import (
    INFERENCE_GRID_PATH,
    MODEL_PATH,
    OUTER_PREDICTIONS_PATH,
    REPORT_PATH as PRODUCTION_REPORT_PATH,
    _fit_fixed_rounds,
    backward_feature_elimination,
    bounded_parameter_search,
    evaluate_configuration,
    select_configuration,
)
from .sources import file_hash


BENCHMARK_ROOT = (
    CACHE_ROOT / "image-regression" / "xgboost-radius-benchmark-2026"
)
SOURCE_ROOT = BENCHMARK_ROOT / "sources"
FEATURE_CACHE_PATH = BENCHMARK_ROOT / "features-200m-common-cohort.npz"
SAMPLES_PATH = BENCHMARK_ROOT / "samples-200m-common-cohort.csv.gz"
FOLDS_PATH = BENCHMARK_ROOT / "shared-folds.json"
PREDICTIONS_PATH = BENCHMARK_ROOT / "outer-predictions.npz"
REPORT_PATH = BENCHMARK_ROOT / "report.json"
RADII_METERS = (100, 150, 200)
RING_WIDTH_METERS = 25
MAX_RADIUS_METERS = max(RADII_METERS)
EMBARGO_METERS = 2 * MAX_RADIUS_METERS
OUTER_FOLDS = 5
INNER_FOLDS = 4
SEED = 42
BOOTSTRAP_DRAWS = 20_000
SOIL_YEAR = 2024


def benchmark_feature_names(max_radius: int = MAX_RADIUS_METERS):
    """Return ring-major names so smaller radii are exact matrix prefixes."""
    if max_radius <= 0 or max_radius % RING_WIDTH_METERS:
        raise ValueError("The maximum radius must be a positive multiple of 25 m.")
    return tuple(
        f"{channel}_{lower}_{lower + RING_WIDTH_METERS}m"
        for lower in range(0, max_radius, RING_WIDTH_METERS)
        for channel in LAND_COVER_CHANNEL_NAMES
    )


def feature_count_for_radius(radius_m: int) -> int:
    if radius_m not in RADII_METERS:
        raise ValueError(f"Unsupported benchmark radius: {radius_m}")
    return len(LAND_COVER_CHANNEL_NAMES) * radius_m // RING_WIDTH_METERS


def feature_view_for_radius(features, names, radius_m: int):
    """Return the exact prefix view used by one radius, without recomputation."""
    count = feature_count_for_radius(radius_m)
    values = np.asarray(features)
    if values.ndim != 2 or values.shape[1] < count or len(names) < count:
        raise ValueError("The complete benchmark matrix is missing radius features.")
    return values[:, :count], tuple(names[:count])


def _atomic_json(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _atomic_npz(path: Path, **arrays):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial.npz")
    np.savez_compressed(temporary, **arrays)
    temporary.replace(path)


def _production_hashes():
    return {
        str(path): file_hash(path)
        for path in (MODEL_PATH, PRODUCTION_REPORT_PATH, OUTER_PREDICTIONS_PATH, INFERENCE_GRID_PATH)
        if path.exists()
    }


def _raw_source(dataset_id: str, year: int) -> Path:
    path = CACHE_ROOT / "raw" / dataset_id / f"{dataset_id}-{year}.tif"
    if not path.exists():
        raise FileNotFoundError(
            f"Missing cached {dataset_id} {year} source: {path}. "
            "Prepare the official local layers first."
        )
    return path


def prepare_benchmark_sources(*, force: bool = False):
    """Prepare separate, aligned 1 m inputs with a complete 200 m halo."""
    sectors = gpd.read_file(SECTORS_PATH)
    projected = sectors.to_crs("EPSG:31370")
    display_bounds = aligned_bounds(projected.total_bounds, resolution=10)
    target_bounds = (
        display_bounds[0] - MAX_RADIUS_METERS,
        display_bounds[1] - MAX_RADIUS_METERS,
        display_bounds[2] + MAX_RADIUS_METERS,
        display_bounds[3] + MAX_RADIUS_METERS,
    )
    soil_source = _raw_source("jaarbak", SOIL_YEAR)
    green_source = _raw_source("groenkaart", GREEN_YEAR)
    soil_path = SOURCE_ROOT / f"jaarbak-{SOIL_YEAR}-halo-{MAX_RADIUS_METERS}m.tif"
    green_path = SOURCE_ROOT / f"groenkaart-{GREEN_YEAR}-halo-{MAX_RADIUS_METERS}m.tif"
    if force:
        soil_path.unlink(missing_ok=True)
        green_path.unlink(missing_ok=True)
    ensure_halo_source(
        soil_source, "jaarbak", SOIL_YEAR, target_bounds, soil_path,
        radius_m=MAX_RADIUS_METERS,
        # The official raster ends just north of the requested southern halo.
        # Keep that strip unavailable; the strict cohort check excludes any
        # centre whose 200 m support touches it.
        download_missing=False,
    )
    ensure_halo_source(
        green_source, "groenkaart", GREEN_YEAR, target_bounds, green_path,
        radius_m=MAX_RADIUS_METERS,
    )
    _validate_aligned_sources(soil_path, green_path)
    urban_source = _default_urban_atlas_source()
    urban_signature = _source_signature(urban_source)
    urban_path = _prepare_urban_context(
        urban_source, urban_signature["sha256"], soil_path, sectors,
        force=force,
        destination=SOURCE_ROOT / f"urban-atlas-2021-context-{MAX_RADIUS_METERS}m.tif",
        radius_m=MAX_RADIUS_METERS,
    )
    water_path = prepare_analysis_water_context(
        urban_path, soil_path, sectors_path=SECTORS_PATH, force=force,
        destination=SOURCE_ROOT / f"analysis-water-2021-2025-{MAX_RADIUS_METERS}m.tif",
    )
    return {
        "soil": soil_path,
        "green": green_path,
        "urban": urban_path,
        "water": water_path,
        "bounds": target_bounds,
        "signatures": {
            "soil": _source_signature(soil_path),
            "green": _source_signature(green_path),
            "urban": _source_signature(urban_path),
            "water": _source_signature(water_path),
            "urbanAtlas": urban_signature,
            "sectors": _source_signature(SECTORS_PATH),
        },
    }


def disk_row_spans(radius_m: int):
    """Return half-open X spans for exact 1 m pixel-centre disk membership."""
    if radius_m <= 0:
        raise ValueError("A disk radius must be positive.")
    offsets = np.arange(radius_m * 2, dtype=np.float64) + 0.5 - radius_m
    spans = []
    for y in offsets:
        inside = np.flatnonzero(offsets * offsets + y * y < radius_m * radius_m)
        if not len(inside):
            spans.append((0, 0))
        else:
            spans.append((int(inside[0]), int(inside[-1]) + 1))
    return tuple(spans)


def _row_prefix(mask):
    values = np.asarray(mask, dtype=np.uint8)
    prefix = np.empty((values.shape[0], values.shape[1] + 1), dtype=np.uint32)
    prefix[:, 0] = 0
    np.cumsum(values, axis=1, dtype=np.uint32, out=prefix[:, 1:])
    return prefix


def disk_sums_from_prefix(prefix, center_rows, center_columns, radius_m: int):
    """Sum a binary raster inside exact pixel-centre disks at many centres."""
    rows = np.asarray(center_rows, dtype=np.int64)
    columns = np.asarray(center_columns, dtype=np.int64)
    if rows.shape != columns.shape or rows.ndim != 1:
        raise ValueError("Disk centres must be equally shaped one-dimensional arrays.")
    spans = disk_row_spans(radius_m)
    result = np.zeros(len(rows), dtype=np.uint32)
    top = rows - radius_m
    left = columns - radius_m
    height, width_plus_one = prefix.shape
    if len(rows) and (
        np.min(top) < 0 or np.max(top + 2 * radius_m) > height
        or np.min(left) < 0 or np.max(left + 2 * radius_m) >= width_plus_one
    ):
        raise ValueError("A benchmark disk extends beyond its prepared source halo.")
    for dy, (start, stop) in enumerate(spans):
        if stop > start:
            source_row = top + dy
            result += prefix[source_row, left + stop] - prefix[source_row, left + start]
    return result


def _disk_pixel_count(radius_m: int) -> int:
    return int(sum(stop - start for start, stop in disk_row_spans(radius_m)))


def _sample_centres(samples: pd.DataFrame, source_path: Path):
    with rasterio.open(source_path) as source:
        transform = source.transform
        columns = np.rint(
            (samples["x_lambert"].to_numpy(dtype=np.float64) - transform.c) / transform.a
        ).astype(np.int32)
        rows = np.rint(
            (transform.f - samples["y_lambert"].to_numpy(dtype=np.float64)) / abs(transform.e)
        ).astype(np.int32)
    return rows, columns


def _validity_mask(paths):
    with rasterio.open(paths["soil"]) as soil, rasterio.open(paths["green"]) as green, \
            rasterio.open(paths["urban"]) as urban:
        valid = np.isin(soil.read(1), (0, 1))
        valid &= np.isin(green.read(1), (1, 2, 3, 4))
        valid &= (urban.read(1) & UA_VALID) != 0
    return valid


def _channel_values(paths, channel: str):
    if channel == "soil_sealing":
        with rasterio.open(paths["soil"]) as source:
            return source.read(1) == 1
    if channel in ("high_green", "low_green", "agriculture"):
        code = {"high_green": 1, "low_green": 2, "agriculture": 3}[channel]
        with rasterio.open(paths["green"]) as source:
            return source.read(1) == code
    if channel == "water":
        with rasterio.open(paths["water"]) as source:
            return analysis_water_union(source.read(1))
    raise ValueError(f"Unknown benchmark channel: {channel}")


def _source_signature_key(sources):
    return "|".join(
        f"{name}:{signature['sha256']}" for name, signature in sorted(sources["signatures"].items())
    )


def extract_common_feature_matrix(*, force: bool = False, force_sources: bool = False):
    """Extract the common 200 m cohort and complete ring-major feature matrix."""
    production_catalog = prepare_regression_catalog(DEFAULT_OBSERVATION_ID)
    sources = prepare_benchmark_sources(force=force_sources)
    signature = _source_signature_key(sources)
    names = benchmark_feature_names()
    if FEATURE_CACHE_PATH.exists() and SAMPLES_PATH.exists() and not force:
        with np.load(FEATURE_CACHE_PATH, allow_pickle=False) as cached:
            if str(cached["source_signature"].item()) == signature \
                    and tuple(cached["feature_names"].tolist()) == names:
                samples = pd.read_csv(SAMPLES_PATH, compression="gzip")
                return (
                    samples, cached["features"].copy(), cached["targets"].copy(), names, sources,
                )

    candidate_samples = production_catalog.samples.reset_index(drop=True).copy()
    center_rows, center_columns = _sample_centres(candidate_samples, sources["soil"])
    print("Checking complete 200 m support for the shared cohort...", flush=True)
    valid = _validity_mask(sources)
    invalid_prefix = _row_prefix(~valid)
    del valid
    invalid_counts = disk_sums_from_prefix(
        invalid_prefix, center_rows, center_columns, MAX_RADIUS_METERS,
    )
    del invalid_prefix
    gc.collect()
    keep = invalid_counts == 0
    samples = candidate_samples.loc[keep].reset_index(drop=True)
    center_rows = center_rows[keep]
    center_columns = center_columns[keep]
    if samples.empty or samples["sector_id"].nunique() != 154:
        raise ValueError(
            "The strict common cohort must remain non-empty and cover all 154 statistical sectors."
        )

    radii = tuple(range(RING_WIDTH_METERS, MAX_RADIUS_METERS + 1, RING_WIDTH_METERS))
    cumulative_denominators = np.asarray([_disk_pixel_count(radius) for radius in radii])
    ring_denominators = np.diff(np.r_[0, cumulative_denominators]).astype(np.float32)
    features = np.empty((len(samples), len(names)), dtype=np.float32)
    for channel_index, channel in enumerate(LAND_COVER_CHANNEL_NAMES):
        print(f"Extracting exact 1 m ring fractions: {channel}...", flush=True)
        prefix = _row_prefix(_channel_values(sources, channel))
        previous = np.zeros(len(samples), dtype=np.uint32)
        for ring_index, radius in enumerate(radii):
            cumulative = disk_sums_from_prefix(prefix, center_rows, center_columns, radius)
            column = ring_index * len(LAND_COVER_CHANNEL_NAMES) + channel_index
            features[:, column] = (cumulative - previous) / ring_denominators[ring_index]
            previous = cumulative
        del prefix
        gc.collect()
    if not np.all(np.isfinite(features)) or np.any(features < 0) or np.any(features > 1):
        raise ValueError("The benchmark feature matrix contains invalid land-cover fractions.")

    targets = samples["lst_c"].to_numpy(dtype=np.float32)
    BENCHMARK_ROOT.mkdir(parents=True, exist_ok=True)
    temporary_samples = SAMPLES_PATH.with_suffix(".partial.csv.gz")
    samples.to_csv(temporary_samples, index=False, compression="gzip")
    temporary_samples.replace(SAMPLES_PATH)
    _atomic_npz(
        FEATURE_CACHE_PATH,
        features=features,
        targets=targets,
        feature_names=np.asarray(names),
        source_signature=np.asarray(signature),
        common_sample_ids=samples["sample_id"].astype(str).to_numpy(),
        ring_denominators=ring_denominators,
    )
    return samples, features, targets, names, sources


def _inner_folds(samples, outer_indices, *, seed=SEED):
    subset = samples.iloc[np.asarray(outer_indices, dtype=np.int64)].reset_index(drop=True)
    local = make_sector_folds(
        subset,
        n_splits=min(INNER_FOLDS, subset["sector_id"].nunique()),
        buffer_m=EMBARGO_METERS,
        seed=seed,
    )
    outer_indices = np.asarray(outer_indices, dtype=np.int64)
    return tuple({
        "fit": outer_indices[np.asarray(fold.train_indices, dtype=np.int64)],
        "validation": outer_indices[np.asarray(fold.test_indices, dtype=np.int64)],
        "excluded": outer_indices[np.asarray(fold.excluded_buffer_indices, dtype=np.int64)],
        "fold": int(fold.fold),
        "diagnostics": fold.diagnostics,
        "testSectorIds": list(fold.test_sector_ids),
    } for fold in local)


def prepare_shared_folds(samples: pd.DataFrame):
    """Create one immutable outer/inner fold set reused for every radius."""
    outer = make_sector_folds(
        samples, n_splits=OUTER_FOLDS, buffer_m=EMBARGO_METERS, seed=SEED,
    )
    inner_by_outer = {
        int(fold.fold): _inner_folds(samples, fold.train_indices)
        for fold in outer
    }
    full_inner = _inner_folds(samples, np.arange(len(samples), dtype=np.int64))
    for fold in outer:
        fold.diagnostics["minimumTrainTestCentreDistanceMeters"] = verify_support_separation(
            samples, fold.train_indices, fold.test_indices, EMBARGO_METERS,
        )
        for item in inner_by_outer[int(fold.fold)]:
            item["diagnostics"]["minimumTrainTestCentreDistanceMeters"] = verify_support_separation(
                samples, item["fit"], item["validation"], EMBARGO_METERS,
            )
    for item in full_inner:
        item["diagnostics"]["minimumTrainTestCentreDistanceMeters"] = verify_support_separation(
            samples, item["fit"], item["validation"], EMBARGO_METERS,
        )
    payload = {
        "seed": SEED,
        "embargoMeters": EMBARGO_METERS,
        "outerFoldCount": OUTER_FOLDS,
        "innerFoldCount": INNER_FOLDS,
        "sampleCount": int(len(samples)),
        "sampleIdSha256": _array_sha256(samples["sample_id"].astype(str).to_numpy()),
        "outer": [{
            "fold": int(fold.fold),
            "testSectorIds": list(fold.test_sector_ids),
            "diagnostics": fold.diagnostics,
            "trainIndicesSha256": _array_sha256(fold.train_indices),
            "testIndicesSha256": _array_sha256(fold.test_indices),
            "inner": [{
                "fold": item["fold"],
                "testSectorIds": item["testSectorIds"],
                "diagnostics": item["diagnostics"],
                "fitIndicesSha256": _array_sha256(item["fit"]),
                "validationIndicesSha256": _array_sha256(item["validation"]),
            } for item in inner_by_outer[int(fold.fold)]],
        } for fold in outer],
        "fullDataInner": [{
            "fold": item["fold"],
            "testSectorIds": item["testSectorIds"],
            "diagnostics": item["diagnostics"],
            "fitIndicesSha256": _array_sha256(item["fit"]),
            "validationIndicesSha256": _array_sha256(item["validation"]),
        } for item in full_inner],
    }
    _atomic_json(FOLDS_PATH, payload)
    return outer, inner_by_outer, full_inner, payload


def verify_support_separation(samples, train_indices, test_indices, embargo_m):
    """Reject overlapping feature-support disks and return nearest separation."""
    train = samples.iloc[np.asarray(train_indices, dtype=np.int64)][
        ["x_lambert", "y_lambert"]
    ].to_numpy(dtype=np.float64)
    test = samples.iloc[np.asarray(test_indices, dtype=np.int64)][
        ["x_lambert", "y_lambert"]
    ].to_numpy(dtype=np.float64)
    if not len(train) or not len(test):
        raise ValueError("Embargo verification requires non-empty train and test centres.")
    distances, _ = cKDTree(test).query(train, k=1, workers=-1)
    minimum = float(np.min(distances))
    if minimum + 1e-6 < float(embargo_m):
        raise AssertionError(
            f"Train/test support overlaps: nearest centres are {minimum:.3f} m apart, "
            f"below the {embargo_m:.3f} m embargo."
        )
    return minimum


def _array_sha256(values):
    import hashlib
    array = np.ascontiguousarray(values)
    if array.dtype.kind in "OUS":
        payload = "\0".join(map(str, array.tolist())).encode("utf-8")
    else:
        payload = array.view(np.uint8)
    return hashlib.sha256(payload).hexdigest()


def _compact_tested(tested):
    return [{
        "parameters": asdict(item["config"]),
        "meanSpatialRmseC": float(item["meanRmseC"]),
        "bestRounds": [int(value) for value in item["bestRounds"]],
    } for item in tested]


def resolve_training_device(requested="cuda"):
    """Probe CUDA once and explicitly record the fallback when unavailable."""
    if requested != "cuda":
        return requested, None
    try:
        matrix = xgb.DMatrix(
            np.asarray([[0.0], [1.0]], dtype=np.float32),
            label=np.asarray([0.0, 1.0], dtype=np.float32),
        )
        xgb.train(
            {"objective": "reg:squarederror", "tree_method": "hist", "device": "cuda", "verbosity": 0},
            matrix,
            num_boost_round=1,
        )
        return "cuda", None
    except xgb.core.XGBoostError as error:
        return "cpu", f"CUDA probe failed; benchmark used CPU: {error}"


def _checkpoint_paths(radius_m, fold_index):
    root = BENCHMARK_ROOT / f"radius-{radius_m}m" / "outer-folds"
    return root / f"fold-{fold_index}.json", root / f"fold-{fold_index}.npz"


def _load_outer_checkpoint(radius_m, fold_index, signature):
    report_path, prediction_path = _checkpoint_paths(radius_m, fold_index)
    if not report_path.exists() or not prediction_path.exists():
        return None
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    if payload.get("benchmarkSignature") != signature:
        return None
    with np.load(prediction_path, allow_pickle=False) as cached:
        return payload, cached["test_indices"].copy(), cached["predictions"].copy()


def _save_outer_checkpoint(radius_m, fold_index, signature, report, indices, predictions):
    report_path, prediction_path = _checkpoint_paths(radius_m, fold_index)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_npz(
        prediction_path,
        test_indices=np.asarray(indices, dtype=np.int64),
        predictions=np.asarray(predictions, dtype=np.float32),
    )
    _atomic_json(report_path, {"benchmarkSignature": signature, **report})


def _train_radius(
        radius_m, samples, features, targets, names, outer_folds, inner_by_outer,
        full_inner, candidates, *, device, signature, force=False):
    feature_count = feature_count_for_radius(radius_m)
    radius_features, radius_names = feature_view_for_radius(features, names, radius_m)
    oof = np.full(len(samples), np.nan, dtype=np.float32)
    outer_reports = []
    for outer in outer_folds:
        cached = None if force else _load_outer_checkpoint(radius_m, outer.fold, signature)
        if cached is not None:
            report, test_indices, predictions = cached
            oof[test_indices] = predictions
            outer_reports.append({key: value for key, value in report.items() if key != "benchmarkSignature"})
            print(f"Reused {radius_m} m outer fold {outer.fold + 1}/{len(outer_folds)}.", flush=True)
            continue
        print(f"{radius_m} m: tuning outer fold {outer.fold + 1}/{len(outer_folds)}...", flush=True)
        inner = inner_by_outer[int(outer.fold)]
        selected, tested = select_configuration(
            radius_features, targets, radius_names, inner, candidates, device=device,
        )
        active, decisions, selected_rmse = backward_feature_elimination(
            radius_features, targets, radius_names, inner, selected["config"], device=device,
        )
        selected_names = tuple(radius_names[index] for index in active)
        rounds = int(np.median(selected["bestRounds"]))
        booster = _fit_fixed_rounds(
            radius_features[outer.train_indices][:, active], targets[outer.train_indices],
            selected_names, selected["config"], rounds, device=device,
        )
        test_matrix = xgb.DMatrix(
            radius_features[outer.test_indices][:, active], feature_names=list(selected_names),
        )
        predictions = booster.predict(test_matrix).astype(np.float32)
        oof[outer.test_indices] = predictions
        report = {
            "fold": int(outer.fold),
            "metrics": regression_metrics(targets[outer.test_indices], predictions),
            "bestRounds": rounds,
            "parameters": asdict(selected["config"]),
            "retainedFeatures": list(selected_names),
            "featureSelection": decisions,
            "selectedInnerRmseC": float(selected_rmse),
            "testedConfigurations": _compact_tested(tested),
            "diagnostics": outer.diagnostics,
        }
        _save_outer_checkpoint(
            radius_m, outer.fold, signature, report, outer.test_indices, predictions,
        )
        outer_reports.append(report)
        del booster, tested
        gc.collect()
    if not np.all(np.isfinite(oof)):
        raise AssertionError(f"The {radius_m} m out-of-fold prediction vector is incomplete.")

    print(f"{radius_m} m: selecting the full-data benchmark recipe...", flush=True)
    selected, tested = select_configuration(
        radius_features, targets, radius_names, full_inner, candidates, device=device,
    )
    active, decisions, selected_rmse = backward_feature_elimination(
        radius_features, targets, radius_names, full_inner, selected["config"], device=device,
    )
    selected_names = tuple(radius_names[index] for index in active)
    round_evaluation = evaluate_configuration(
        radius_features[:, active], targets, selected_names, full_inner,
        selected["config"], device=device,
    )
    rounds = int(np.median(round_evaluation["bestRounds"]))
    booster = _fit_fixed_rounds(
        radius_features[:, active], targets, selected_names,
        selected["config"], rounds, device=device,
    )
    model_path = BENCHMARK_ROOT / f"radius-{radius_m}m" / "model.json"
    model_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_model = model_path.with_suffix(".partial.json")
    booster.save_model(temporary_model)
    temporary_model.replace(model_path)
    gain = booster.get_score(importance_type="gain")
    return {
        "radiusMeters": radius_m,
        "featureCount": feature_count,
        "featureNames": list(radius_names),
        "outerFolds": outer_reports,
        "pooledOuterMetrics": regression_metrics(targets, oof),
        "final": {
            "parameters": asdict(selected["config"]),
            "boostRounds": rounds,
            "retainedFeatures": list(selected_names),
            "rejectedFeatures": [name for name in radius_names if name not in selected_names],
            "featureSelection": decisions,
            "spatialCvRmseC": float(selected_rmse),
            "featureImportanceGain": {
                name: float(gain.get(name, 0.0)) for name in selected_names
            },
            "modelPath": str(model_path),
            "modelSha256": file_hash(model_path),
        },
        "testedFullDataConfigurations": _compact_tested(tested),
    }, oof


def _bootstrap_sufficient_statistics(samples, observed, predicted):
    sectors = np.asarray(sorted(samples["sector_id"].astype(str).unique()))
    sector_index = pd.Categorical(samples["sector_id"].astype(str), categories=sectors).codes
    residual = np.asarray(predicted, dtype=np.float64) - np.asarray(observed, dtype=np.float64)
    return sectors, {
        "count": np.bincount(sector_index, minlength=len(sectors)).astype(np.float64),
        "absoluteError": np.bincount(
            sector_index, weights=np.abs(residual), minlength=len(sectors),
        ),
        "squaredError": np.bincount(
            sector_index, weights=residual ** 2, minlength=len(sectors),
        ),
        "sumY": np.bincount(sector_index, weights=observed, minlength=len(sectors)),
        "sumY2": np.bincount(sector_index, weights=np.asarray(observed) ** 2, minlength=len(sectors)),
    }


def _metrics_from_sector_resamples(draws, common, errors):
    count = common["count"][draws].sum(axis=1)
    sum_y = common["sumY"][draws].sum(axis=1)
    sum_y2 = common["sumY2"][draws].sum(axis=1)
    sse = errors["squaredError"][draws].sum(axis=1)
    sae = errors["absoluteError"][draws].sum(axis=1)
    sst = sum_y2 - sum_y * sum_y / count
    r2 = np.full(len(sst), np.nan, dtype=np.float64)
    valid_variance = sst > 0
    r2[valid_variance] = 1.0 - sse[valid_variance] / sst[valid_variance]
    return {
        "rmse_c": np.sqrt(sse / count),
        "mae_c": sae / count,
        "r2": r2,
    }


def paired_sector_bootstrap(
        samples, observed, predictions_by_radius, *, draws=BOOTSTRAP_DRAWS, seed=SEED):
    """Paired cluster bootstrap over sectors on identical OOF observations."""
    if draws <= 0:
        raise ValueError("At least one bootstrap resample is required.")
    radii = tuple(sorted(predictions_by_radius))
    if not radii or any(len(predictions_by_radius[radius]) != len(observed) for radius in radii):
        raise ValueError("Every radius needs one prediction per common observation.")
    sectors, first = _bootstrap_sufficient_statistics(
        samples, observed, predictions_by_radius[radii[0]],
    )
    errors = {radii[0]: first}
    for radius in radii[1:]:
        other_sectors, stats = _bootstrap_sufficient_statistics(
            samples, observed, predictions_by_radius[radius],
        )
        if not np.array_equal(sectors, other_sectors):
            raise AssertionError("Paired bootstrap sector ordering changed between radii.")
        errors[radius] = stats
    rng = np.random.default_rng(seed)
    sampled = rng.integers(0, len(sectors), size=(draws, len(sectors)), dtype=np.int16)
    sampled_metrics = {
        radius: _metrics_from_sector_resamples(sampled, first, error)
        for radius, error in errors.items()
    }
    comparisons = {}
    for baseline, candidate in ((100, 150), (100, 200), (150, 200)):
        if baseline not in radii or candidate not in radii:
            continue
        baseline_point = regression_metrics(observed, predictions_by_radius[baseline])
        candidate_point = regression_metrics(observed, predictions_by_radius[candidate])
        metric_rows = {}
        for metric in ("rmse_c", "mae_c", "r2"):
            delta = sampled_metrics[candidate][metric] - sampled_metrics[baseline][metric]
            finite = delta[np.isfinite(delta)]
            baseline_value = baseline_point[metric]
            candidate_value = candidate_point[metric]
            point_delta = None if baseline_value is None or candidate_value is None \
                else float(candidate_value - baseline_value)
            metric_rows[metric] = {
                "candidateMinusBaseline": point_delta,
                "ci95": None if not len(finite) else [
                    float(np.percentile(finite, 2.5)), float(np.percentile(finite, 97.5)),
                ],
            }
        absolute_improvement = baseline_point["rmse_c"] - candidate_point["rmse_c"]
        rmse_interval = metric_rows["rmse_c"]["ci95"]
        comparisons[f"{candidate}m-vs-{baseline}m"] = {
            "baselineRadiusMeters": baseline,
            "candidateRadiusMeters": candidate,
            "metrics": metric_rows,
            "rmseImprovementC": float(absolute_improvement),
            "rmseImprovementPercent": None if baseline_point["rmse_c"] == 0 else float(
                absolute_improvement / baseline_point["rmse_c"] * 100
            ),
            "statisticallySupportedRmseImprovement": bool(
                rmse_interval is not None and rmse_interval[1] < 0
            ),
        }
    return {
        "method": "paired sector-cluster bootstrap",
        "draws": int(draws),
        "seed": int(seed),
        "sectorCount": int(len(sectors)),
        "decisionRule": "candidate-minus-baseline RMSE 95% interval entirely below zero",
        "comparisons": comparisons,
    }


def run_radius_benchmark(
        *, force_sources=False, force_features=False, force_training=False,
        device="cuda", search_budget=None, bootstrap_draws=BOOTSTRAP_DRAWS):
    """Execute the isolated common-cohort nested spatial benchmark."""
    before = _production_hashes()
    samples, features, targets, names, sources = extract_common_feature_matrix(
        force=force_features, force_sources=force_sources,
    )
    expected_names = benchmark_feature_names()
    if tuple(names) != expected_names or features.shape != (len(samples), 40):
        raise AssertionError("The common 200 m matrix does not satisfy the 40-feature contract.")
    # These are views, not recomputed matrices: identity is exact by construction.
    for radius in RADII_METERS:
        radius_features, radius_names = feature_view_for_radius(features, names, radius)
        count = feature_count_for_radius(radius)
        if not np.shares_memory(radius_features, features) \
                or radius_names != tuple(expected_names[:count]):
            raise AssertionError(f"The {radius} m matrix is not an exact feature prefix view.")
    outer, inner_by_outer, full_inner, folds_payload = prepare_shared_folds(samples)
    actual_device, fallback_reason = resolve_training_device(device)
    candidates = bounded_parameter_search()
    if search_budget is not None:
        candidates = candidates[:max(1, int(search_budget))]
    signature = "|".join((
        file_hash(FEATURE_CACHE_PATH),
        file_hash(FOLDS_PATH),
        actual_device,
        str(len(candidates)),
        xgb.__version__,
    ))
    radius_reports = {}
    predictions = {}
    for radius in RADII_METERS:
        report, oof = _train_radius(
            radius, samples, features, targets, names, outer, inner_by_outer,
            full_inner, candidates, device=actual_device, signature=signature,
            force=force_training,
        )
        radius_reports[str(radius)] = report
        predictions[radius] = oof
    bootstrap = paired_sector_bootstrap(
        samples, targets, predictions, draws=bootstrap_draws, seed=SEED,
    )
    _atomic_npz(
        PREDICTIONS_PATH,
        observed_c=targets,
        sample_ids=samples["sample_id"].astype(str).to_numpy(),
        sector_ids=samples["sector_id"].astype(str).to_numpy(),
        **{f"predicted_{radius}m_c": values for radius, values in predictions.items()},
    )
    report = {
        "schemaVersion": 1,
        "experiment": "xgboost-land-cover-support-radius",
        "observationId": DEFAULT_OBSERVATION_ID,
        "productionModelChanged": False,
        "commonCohort": {
            "sampleCount": int(len(samples)),
            "sectorCount": int(samples["sector_id"].nunique()),
            "municipalityCount": int(samples["municipality"].nunique()),
            "completeRadiusMeters": MAX_RADIUS_METERS,
            "sampleIdSha256": _array_sha256(samples["sample_id"].astype(str).to_numpy()),
            "targetSha256": _array_sha256(targets),
        },
        "features": {
            "channels": list(LAND_COVER_CHANNEL_NAMES),
            "ringWidthMeters": RING_WIDTH_METERS,
            "radiiMeters": list(RADII_METERS),
            "featureCounts": {
                str(radius): feature_count_for_radius(radius) for radius in RADII_METERS
            },
            "completeMatrixNames": list(names),
            "prefixContract": True,
        },
        "folds": folds_payload,
        "training": {
            "requestedDevice": device,
            "device": actual_device,
            "fallbackReason": fallback_reason,
            "xgboostVersion": xgb.__version__,
            "configurationCount": len(candidates),
        },
        "radii": radius_reports,
        "pairedBootstrap": bootstrap,
        "sources": sources["signatures"],
        "artifacts": {
            "featureMatrix": str(FEATURE_CACHE_PATH),
            "samples": str(SAMPLES_PATH),
            "folds": str(FOLDS_PATH),
            "outerPredictions": str(PREDICTIONS_PATH),
            "outerPredictionsSha256": file_hash(PREDICTIONS_PATH),
        },
        "productionReference": {
            "rmseC": 2.4344575,
            "maeC": 1.8659113,
            "r2": 0.6266854,
            "note": "Context only; it used a different 100 m-complete cohort and 200 m embargo.",
        },
        "productionArtifactHashes": before,
    }
    after = _production_hashes()
    if before != after:
        raise AssertionError("The isolated radius benchmark modified a production model artifact.")
    _atomic_json(REPORT_PATH, report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Benchmark 100, 150 and 200 m XGBoost land-cover support radii.",
    )
    parser.add_argument("--force-sources", action="store_true")
    parser.add_argument("--force-features", action="store_true")
    parser.add_argument("--force-training", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--search-budget", type=int)
    parser.add_argument("--bootstrap-draws", type=int, default=BOOTSTRAP_DRAWS)
    args = parser.parse_args(argv)
    report = run_radius_benchmark(
        force_sources=args.force_sources,
        force_features=args.force_features,
        force_training=args.force_training,
        device=args.device,
        search_budget=args.search_budget,
        bootstrap_draws=args.bootstrap_draws,
    )
    print(json.dumps({
        "report": str(REPORT_PATH),
        "device": report["training"]["device"],
        "commonSampleCount": report["commonCohort"]["sampleCount"],
        "pooled": {
            radius: values["pooledOuterMetrics"]
            for radius, values in report["radii"].items()
        },
        "comparisons": report["pairedBootstrap"]["comparisons"],
    }, indent=2))


if __name__ == "__main__":
    main()
