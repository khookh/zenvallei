"""Verified production artifacts for the 2026 Heatwave XGBoost model.

Optuna training lives in :mod:`image_regression_optuna`. This module owns the
stable feature naming, inference-grid construction, and artifact validation
shared by training, the notebook, and the live scenario.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import numpy as np
import xgboost as xgb

from .constants import CACHE_ROOT
from .image_regression import (
    DEFAULT_OBSERVATION_ID,
    LAND_COVER_CHANNEL_NAMES,
    SUPPORT_MASK,
    radial_band_fractions,
)
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
FEATURE_REMOVAL_TOLERANCE_C = 0.01
FEATURE_CONTRACT_VERSION = 5


def feature_removal_within_tolerance(candidate_rmse_c, reference_rmse_c):
    """Accept a simpler model only within the fixed 0.01 C RMSE tolerance."""
    return float(candidate_rmse_c) <= float(reference_rmse_c) + FEATURE_REMOVAL_TOLERANCE_C


def radial_band_edges(ring_width_meters=25):
    width = int(ring_width_meters)
    if width not in (5, 10, 20, 25, 50) or 100 % width:
        raise ValueError("Ring width must be 5, 10, 20, 25 or 50 metres over the fixed 100 m support.")
    return tuple(range(0, 101, width))


def radial_feature_names(ring_width_meters=25):
    bands = tuple(zip(radial_band_edges(ring_width_meters)[:-1],
                      radial_band_edges(ring_width_meters)[1:]))
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


def prepare_inference_grid(
        catalog, booster, report, *, artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS,
        output_observation_id: str = DEFAULT_OBSERVATION_ID):
    """Cache baseline features/predictions for every valid 30 m scenario centre."""
    import geopandas as gpd
    import rasterio
    from pyproj import Transformer
    from rasterio.features import rasterize
    from rasterio.transform import rowcol

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
                    "path": str(artifacts.inference_grid),
                    "sha256": file_hash(artifacts.inference_grid),
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
            ((geometry, 1) for geometry in sectors.geometry),
            out_shape=output.shape,
            transform=output.transform,
            fill=0,
            dtype="uint8",
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
            patch = xgboost_land_cover_channels(green_values, soil_values, water_values != 0)
            values.append(radial_band_fractions(
                patch, SUPPORT_MASK, band_edges=band_edges,
            ).reshape(-1)[selected_columns])
            positions.append((output_row, output_column, source_row, source_column))

    features = np.asarray(values, dtype=np.float32)
    raw_predictions = booster.predict(xgb.DMatrix(features, feature_names=list(selected_names)))
    positions = np.asarray(positions, dtype=np.int32)
    if requested_sigma:
        from .prediction_smoothing import smooth_masked_predictions
        predictions = smooth_masked_predictions(
            raw_predictions, positions[:, 0], positions[:, 1], requested_sigma,
        ).astype(np.float32)
    else:
        predictions = raw_predictions.astype(np.float32)
    temporary = artifacts.inference_grid.with_suffix(".partial.npz")
    np.savez_compressed(
        temporary,
        positions=positions,
        features=features,
        predictions=predictions,
        raw_predictions=np.asarray(raw_predictions, dtype=np.float32),
        feature_names=np.asarray(selected_names),
        output_shape=np.asarray(output_shape),
        output_transform=output_transform,
        smoothing_sigma_meters=np.asarray(requested_sigma),
    )
    temporary.replace(artifacts.inference_grid)
    return {
        "path": str(artifacts.inference_grid),
        "sha256": file_hash(artifacts.inference_grid),
        "validCentreCount": int(len(positions)),
    }


def load_scenario_model(artifacts: XGBoostArtifactPaths = DEFAULT_ARTIFACTS):
    """Load a model only when its model, report, and feature hashes agree."""
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
