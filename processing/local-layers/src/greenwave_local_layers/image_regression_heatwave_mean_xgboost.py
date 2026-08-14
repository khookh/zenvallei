"""Train and verify the heatwave-mean scenario XGBoost model."""

from __future__ import annotations

import argparse
import json

import numpy as np
import xgboost as xgb

from .constants import CACHE_ROOT
from .image_regression_heatwave_mean import (
    HEATWAVE_MEAN_TARGET_ID,
    load_heatwave_mean_catalog,
    prepare_heatwave_mean_catalog,
)
from .image_regression import DEFAULT_OBSERVATION_ID, prepare_regression_catalog
from .image_regression_smoothing_benchmark import (
    BOOTSTRAP_DRAWS,
    run_smoothing_benchmark,
)
from .image_regression_xgboost_pipeline import (
    DEFAULT_ARTIFACTS,
    FEATURE_CONTRACT_VERSION,
    XGBoostArtifactPaths,
    extract_feature_matrix,
    load_scenario_model,
)
from .sources import file_hash


ARTIFACTS = XGBoostArtifactPaths.under(
    CACHE_ROOT / "image-regression" / "xgboost-heatwave-mean-2020-2026",
)
BENCHMARK_ROOT = ARTIFACTS.root / "smoothing-benchmark"


def prepare_heatwave_mean_feature_cache(*, force=False):
    """Reuse identical cached predictor patches after an exact coordinate join."""
    catalog = prepare_heatwave_mean_catalog(force=force)
    if ARTIFACTS.features.exists() and not force:
        return ARTIFACTS.features
    base = prepare_regression_catalog(DEFAULT_OBSERVATION_ID)
    base_features, _, names = extract_feature_matrix(base, artifacts=DEFAULT_ARTIFACTS)
    base_keys = {
        (int(row), int(column)): index
        for index, (row, column) in enumerate(zip(base.samples.landsat_row, base.samples.landsat_col))
    }
    indexes = np.asarray([
        base_keys.get((int(row), int(column)), -1)
        for row, column in zip(catalog.samples.landsat_row, catalog.samples.landsat_col)
    ], dtype=np.int64)
    if np.any(indexes < 0) or len(np.unique(indexes)) != len(indexes):
        raise ValueError("The heatwave-mean cohort is not an exact subset of the 2026 predictor catalog.")
    # The join is asserted by coordinates before the lossless feature subset is
    # cached. The six-date target never participates in this predictor reuse.
    features = base_features[indexes]
    targets = catalog.samples["lst_c"].to_numpy(dtype=np.float32)
    ARTIFACTS.root.mkdir(parents=True, exist_ok=True)
    temporary = ARTIFACTS.features.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary,
        features=features,
        targets=targets,
        feature_names=np.asarray(names),
        catalog_signature=np.asarray(file_hash(catalog.cache_dir / "manifest.json")),
        feature_contract_version=np.asarray(FEATURE_CONTRACT_VERSION),
        source_feature_cache_sha256=np.asarray(file_hash(DEFAULT_ARTIFACTS.features)),
        source_catalog_manifest_sha256=np.asarray(file_hash(base.cache_dir / "manifest.json")),
        source_indexes=indexes,
    )
    temporary.replace(ARTIFACTS.features)
    return ARTIFACTS.features


def resolve_training_device(requested="cuda"):
    """Prefer CUDA, but prove it works before beginning the expensive search."""
    if requested != "cuda":
        return requested
    matrix = xgb.DMatrix(np.asarray([[0.0], [1.0]], dtype=np.float32), label=[0.0, 1.0])
    try:
        xgb.train(
            {
                "objective": "reg:squarederror", "tree_method": "hist",
                "device": "cuda", "verbosity": 0,
            },
            matrix, num_boost_round=1,
        )
        return "cuda"
    except xgb.core.XGBoostError:
        print("CUDA is unavailable; using the deterministic CPU fallback.", flush=True)
        return "cpu"


def train_heatwave_mean_model(
        *, force=False, device="cuda", search_budget=None,
        bootstrap_draws=BOOTSTRAP_DRAWS):
    device = resolve_training_device(device)
    prepare_heatwave_mean_feature_cache(force=force)
    run_smoothing_benchmark(
        force_features=False,
        device=device,
        search_budget=search_budget,
        bootstrap_draws=bootstrap_draws,
        catalog_factory=prepare_heatwave_mean_catalog,
        observation_id=HEATWAVE_MEAN_TARGET_ID,
        artifacts=ARTIFACTS,
        benchmark_root=BENCHMARK_ROOT,
    )
    return json.loads(ARTIFACTS.report.read_text(encoding="utf-8"))


def load_heatwave_mean_scenario_model():
    """Load only a model whose catalog, inference grid and six sources verify."""
    loaded = load_scenario_model(ARTIFACTS)
    if loaded is None:
        return None
    booster, report = loaded
    if report.get("observationId") != HEATWAVE_MEAN_TARGET_ID:
        raise ValueError("The heatwave-mean XGBoost report identifies the wrong target.")
    catalog = load_heatwave_mean_catalog()
    if report.get("catalogManifestSha256") != file_hash(catalog.cache_dir / "manifest.json"):
        raise ValueError("The heatwave-mean XGBoost catalog hash does not match its report.")
    inference = report.get("inferenceGrid", {})
    if inference.get("sha256") != file_hash(ARTIFACTS.inference_grid):
        raise ValueError("The heatwave-mean baseline inference grid hash is invalid.")
    return booster, report, catalog


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Train the strict six-date heatwave-mean scenario XGBoost model.",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--search-budget", type=int)
    parser.add_argument("--bootstrap-draws", type=int, default=BOOTSTRAP_DRAWS)
    args = parser.parse_args(argv)
    report = train_heatwave_mean_model(
        force=args.force,
        device=args.device,
        search_budget=args.search_budget,
        bootstrap_draws=args.bootstrap_draws,
    )
    print(json.dumps({
        "model": str(ARTIFACTS.model),
        "target": report.get("target"),
        "pooled": report["pooledOuterMetrics"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
