"""Focused contracts for the resumable five-fold Optuna experiment."""

import json

import numpy as np
import optuna
import pandas as pd
import pytest

pytest.importorskip("xgboost")

from greenwave_local_layers.image_regression_optuna import (
    RING_WIDTHS_METERS,
    SMOOTHING_SIGMAS_METERS,
    completed_trials,
    create_or_load_study,
    _features_from_patch,
    _features_for_centres,
    paired_sector_bootstrap,
    resume_feature_elimination,
    select_smoothing_example_sector,
    trial_parameter_contract,
)
from greenwave_local_layers.image_regression_xgboost_pipeline import (
    FEATURE_REMOVAL_TOLERANCE_C,
    feature_removal_within_tolerance,
    radial_band_edges,
    radial_feature_names,
)
from greenwave_local_layers.image_regression import SUPPORT_MASK, radial_band_fractions
from greenwave_local_layers.constants import PROJECT_ROOT


def test_exact_ten_parameter_contract_and_radial_feature_counts():
    assert len(trial_parameter_contract()) == 10
    assert RING_WIDTHS_METERS == (5, 10, 20, 25, 50)
    assert SMOOTHING_SIGMAS_METERS == (0, 15, 30, 45, 60)
    assert radial_band_edges(10) == tuple(range(0, 101, 10))
    assert len(radial_feature_names(10)) == 50
    assert len(radial_feature_names(20)) == 25
    assert len(radial_feature_names(25)) == 20
    assert len(radial_feature_names(5)) == 100
    assert len(radial_feature_names(50)) == 10
    with pytest.raises(ValueError):
        radial_band_edges(30)


def test_single_annular_accumulation_matches_direct_fraction_calculation():
    rng = np.random.default_rng(42)
    patch = rng.integers(0, 2, size=(5, 200, 200)).astype(np.float32)
    patch[:, ~SUPPORT_MASK] = 0
    extracted = _features_from_patch(patch)
    for width in RING_WIDTHS_METERS:
        expected = radial_band_fractions(
            patch, SUPPORT_MASK, band_edges=radial_band_edges(width),
        ).reshape(-1)
        np.testing.assert_allclose(extracted[width], expected, atol=1e-7)

    padded = np.zeros((5, 240, 240), dtype=np.float32)
    padded[:, 20:220, 20:220] = patch
    vectorised = _features_for_centres(padded, [120], [120])
    for width in RING_WIDTHS_METERS:
        np.testing.assert_allclose(vectorised[width][0], extracted[width], atol=1e-7)


def test_sqlite_study_resumes_without_discarding_completed_trials(tmp_path):
    path = tmp_path / "study.sqlite3"
    study = create_or_load_study(path)
    study.optimize(lambda trial: trial.suggest_float("x", 0, 1), n_trials=2)
    assert completed_trials(study) == 2
    resumed = create_or_load_study(path)
    assert completed_trials(resumed) == 2
    assert [trial.number for trial in resumed.trials] == [0, 1]
    assert all(trial.state == optuna.trial.TrialState.COMPLETE for trial in resumed.trials)


def test_paired_sector_bootstrap_is_deterministic_and_controls_promotion():
    samples = pd.DataFrame({"sector_id": np.repeat([f"S{i}" for i in range(12)], 5)})
    targets = np.linspace(25, 40, len(samples))
    current = targets + np.sin(np.arange(len(samples)))
    tuned = targets + .2 * np.sin(np.arange(len(samples)))
    first = paired_sector_bootstrap(samples, targets, current, tuned, draws=2_000, seed=42)
    second = paired_sector_bootstrap(samples, targets, current, tuned, draws=2_000, seed=42)
    assert first == second
    assert first["promote"]
    assert first["tunedMinusCurrentRmseCi95"][1] < 0


def test_feature_removal_uses_the_fixed_epsilon_boundary():
    reference = 2.0
    assert FEATURE_REMOVAL_TOLERANCE_C == 0.01
    assert feature_removal_within_tolerance(reference + 0.01, reference)
    assert not feature_removal_within_tolerance(reference + 0.010001, reference)


def test_smoothing_example_selects_the_largest_supported_effect_deterministically():
    sectors = np.asarray(["small"] * 2 + ["alpha"] * 3 + ["beta"] * 3)
    raw = np.zeros(len(sectors))
    smoothed = np.asarray([10, 10, .1, .2, .3, -.8, .8, -.8])
    selected = select_smoothing_example_sector(
        sectors, raw, smoothed, minimum_observations=3,
    )
    assert selected["sectorId"] == "beta"
    assert selected["observationCount"] == 3
    assert selected["meanAbsoluteChangeC"] == pytest.approx(.8)


def test_replay_stops_before_cumulative_feature_loss_exceeds_global_tolerance(monkeypatch):
    names = {25: ("a", "b", "c")}
    report = {"bestTrial": {
        "number": 3, "parameters": {"ring_width_meters": 25}, "allFeatureRmseC": 2.0,
        "featureSelection": [
            {"feature": "a", "removed": True, "afterRmseC": 2.006},
            {"feature": "b", "removed": True, "afterRmseC": 2.012},
        ],
    }}
    monkeypatch.setattr(
        "greenwave_local_layers.image_regression_optuna.evaluate_parameters",
        lambda *args, **kwargs: {"metrics": {"rmse_c": 2.006}},
    )
    active, decisions, _ = resume_feature_elimination(
        report, names, {25: np.ones((2, 3))}, np.ones(2), pd.DataFrame(), (),
        {"ring_width_meters": 25}, device="cpu",
    )
    assert active == (1, 2)
    assert [decision["feature"] for decision in decisions] == ["a"]


def test_xgboost_notebook_exposes_the_contract_search_ranges_and_diagnostics():
    path = PROJECT_ROOT / "playground" / "xgboost_2026_heatwave_regression_zennevallei.ipynb"
    notebook = json.loads(path.read_text(encoding="utf-8"))
    text = "\n".join("".join(cell.get("source", [])) for cell in notebook["cells"])
    assert "XGBoost 2026 heatwave regression for Zennevallei" in text
    assert "RUN_FULL_TUNING = False" in text
    assert "mutually exclusive upper surface" in text
    assert "['learning_rate', 'log-uniform', '0.01 to 0.20']" in text
    assert "['max_depth', 'integer', '2 to 8']" in text
    assert "build_optuna_folds(samples)" in text
    assert "run_optuna_benchmark" not in text
    assert "Low LST (10th percentile)" in text
    assert "Median LST (50th percentile)" in text
    assert "High LST (90th percentile)" in text
    assert "© OpenStreetMap contributors" in text
    assert all(color in text for color in ("#e8292f", "#1f7f00", "#bfff00", "#ffe600", "#4691d0"))
    assert "Distance from the Landsat centre (m)" in text
    assert "Radial-band fraction" in text
    assert "axis.stairs" in text
    assert "ring_midpoints" not in text
    assert "Flanders Land Use 2025" in text
    assert "Urban Atlas-only" in text
    assert "Flanders-only" in text
    assert "nearest-neighbour" in text
    assert "figure.text(.5, .01, 'OSM is visual context only" not in text
    assert "RMSE by Optuna trial" in text
    assert "Spatial RMSE by Optuna trial" not in text
    assert "Feature removal tolerance" in text
    assert "Hexagonal point density" in text
    assert "Observations per hexagon" in text
    assert "Zennevallei held-out error" in text
    assert "maximum visible effect, not a typical sector" in text
    assert "prepare_notebook_diagnostics" in text
    assert "What this model leaves out" not in text
