import numpy as np
import pytest

from greenwave_local_layers.lst_scenario import (
    CLASS_BARE,
    CLASS_HIGH,
    CLASS_LOCKED,
    CLASS_LOW,
    CLASS_SEALED,
    CLASS_WATER,
    ScenarioEngine,
    _quantiles,
    apply_operations,
    apply_surface_operations,
    baseline_surface_states,
    conversion_delta,
    radoux_kernel,
    radoux_effective_proportions,
    reproject_delta_for_display,
    stale_revision,
    supported_baseline,
    web_display_grid,
)
from greenwave_local_layers.scenario_land_cover import (
    GROUND_AGRICULTURE,
    GROUND_BARE,
    GROUND_LOCKED,
    GROUND_LOW,
    GROUND_SEALED,
    GROUND_WATER,
    upper_surface_masks,
    validate_ground_state,
    xgboost_channels_from_state,
)


def test_radoux_kernel_contract():
    kernel = radoux_kernel()
    assert kernel.shape == (41, 41)
    assert float(kernel.sum()) == pytest.approx(1.0)
    assert kernel[20, 20] == pytest.approx(kernel.max())
    assert kernel[20, 19] == pytest.approx(kernel[20, 21])


def test_delta_distribution_is_symmetric_complete_and_sign_aware():
    values = np.array([-2.3, -.8, -.4, -.1, .2, .7, 1.1], dtype=np.float64)
    result = _quantiles(values)
    distribution = result["deltaDistribution"]
    assert result["strongestCoolingC"] == -2.3
    assert result["strongestWarmingC"] == 1.1
    assert distribution["affectedThresholdC"] == .01
    assert distribution["domainC"][0] == -distribution["domainC"][1]
    assert len(distribution["bins"]) <= 32
    assert sum(item["count"] for item in distribution["bins"]) == len(values)
    assert sum(item["sharePct"] for item in distribution["bins"]) == pytest.approx(100, abs=1e-3)


def test_empty_delta_distribution_is_explicit():
    result = _quantiles(np.array([], dtype=np.float64))
    assert result["strongestCoolingC"] is None
    assert result["strongestWarmingC"] is None
    assert result["deltaDistribution"] == {
        "affectedThresholdC": .01, "affectedCellCount": 0,
        "domainC": [0.0, 0.0], "binWidthC": None, "bins": [],
    }


@pytest.mark.parametrize(
    ("values", "cooling", "warming"),
    [([-1.2, -.4, -.1], -1.2, None), ([.1, .4, 1.2], None, 1.2)],
)
def test_delta_distribution_reports_one_sided_extrema(values, cooling, warming):
    result = _quantiles(np.asarray(values, dtype=np.float64))
    assert result["strongestCoolingC"] == cooling
    assert result["strongestWarmingC"] == warming
    assert sum(item["count"] for item in result["deltaDistribution"]["bins"]) == len(values)


def test_revision_staleness_is_scoped_to_one_browser_session():
    assert stale_revision("session-old", 4, "session-old", 3)
    assert not stale_revision("session-old", 4, "session-new", 1)
    assert not stale_revision("session-old", 4, "session-old", 4)


def test_reference_conversions():
    assert conversion_delta(CLASS_SEALED, CLASS_HIGH) * 0.10 == pytest.approx(-1.062)
    assert conversion_delta(CLASS_SEALED, CLASS_LOW) * 0.10 == pytest.approx(-0.527)
    assert conversion_delta(CLASS_HIGH, CLASS_SEALED) == pytest.approx(10.62)


def test_baseline_priority_and_locking():
    green = np.array([[1, 2, 3, 4, 1]], dtype=np.uint8)
    sealing = np.array([[1, 1, 1, 0, 1]], dtype=np.uint8)
    water = np.array([[0, 0, 0, 0, 1]], dtype=bool)
    inside = np.array([[1, 1, 1, 1, 1]], dtype=bool)
    result = supported_baseline(green, sealing, water, inside)
    # High canopy wins the Radoux upper surface. Low vegetation never overlaps
    # sealed ground, agriculture is locked and water remains water.
    assert result.tolist() == [[CLASS_HIGH, CLASS_SEALED, CLASS_LOCKED, CLASS_BARE, CLASS_WATER]]


def test_radoux_effective_fractions_use_canopy_instead_of_underlying_ground():
    canopy = np.array([[1, 0, 1, 0]], dtype=bool)
    ground = np.array([[GROUND_SEALED, GROUND_SEALED, GROUND_LOW, GROUND_BARE]], dtype=np.uint8)
    proportions = radoux_effective_proportions(canopy, ground)
    assert sum(proportions.values()) == pytest.approx(1.0)
    assert proportions[CLASS_HIGH] == pytest.approx(.5)
    assert proportions[CLASS_SEALED] == pytest.approx(.25)
    assert proportions[CLASS_BARE] == pytest.approx(.25)
    assert proportions[CLASS_LOW] == 0


def test_radoux_and_xgboost_share_one_exclusive_upper_surface():
    ground = np.array([[
        GROUND_LOW, GROUND_SEALED, GROUND_AGRICULTURE,
        GROUND_WATER, GROUND_BARE, GROUND_LOCKED,
    ]], dtype=np.uint8)
    canopy = np.array([[1, 1, 1, 1, 0, 1]], dtype=bool)
    surface = upper_surface_masks(ground, canopy)
    assert surface["high"].tolist() == [[True, True, False, False, False, False]]
    channels = xgboost_channels_from_state(ground, canopy)
    assert channels.shape == (5, 1, 6)
    assert np.all(channels.sum(axis=0) <= 1)
    # Low and sealed latent ground disappear below High vegetation. Agriculture
    # and water keep their higher priority, while bare/locked are the remainder.
    assert channels[:, 0, :].T.tolist() == [
        [0, 1, 0, 0, 0], [0, 1, 0, 0, 0],
        [0, 0, 0, 1, 0], [0, 0, 0, 0, 1],
        [0, 0, 0, 0, 0], [0, 0, 0, 0, 0],
    ]


def test_unsealed_non_green_is_an_explicit_editable_bare_soil_proxy():
    green = np.array([[4, 4, 3]], dtype=np.uint8)
    sealing = np.array([[0, 1, 0]], dtype=np.uint8)
    canopy, ground, editable = baseline_surface_states(green, sealing)
    baseline = supported_baseline(green, sealing)
    assert canopy.tolist() == [[False, False, False]]
    assert ground.tolist() == [[GROUND_BARE, GROUND_SEALED, GROUND_AGRICULTURE]]
    assert editable.tolist() == [[True, True, False]]
    assert baseline.tolist() == [[CLASS_BARE, CLASS_SEALED, CLASS_LOCKED]]
    assert conversion_delta(CLASS_BARE, CLASS_HIGH) == pytest.approx(-14.12)


def test_unknown_source_codes_are_locked():
    green = np.array([[1, 9, 2]], dtype=np.uint8)
    sealing = np.array([[255, 1, 0]], dtype=np.uint8)
    canopy, ground, editable = baseline_surface_states(green, sealing)
    assert canopy.tolist() == [[False, False, False]]
    assert ground.tolist() == [[GROUND_LOCKED, GROUND_LOCKED, GROUND_LOW]]
    assert editable.tolist() == [[False, False, True]]


def test_ordered_conversion_and_restore_leave_locked_cells_unchanged():
    baseline = np.array([[CLASS_SEALED, CLASS_HIGH, CLASS_LOCKED]], dtype=np.uint8)
    all_cells = np.ones_like(baseline, dtype=bool)
    first_two = np.array([[1, 1, 0]], dtype=bool)
    first_only = np.array([[1, 0, 0]], dtype=bool)
    simulated, touched = apply_operations(baseline, [
        (all_cells, {"action": "convert-to-low", "target": "low"}),
        (first_two, {"action": "convert", "target": "high"}),
        (first_only, {"action": "restore", "target": None}),
    ])
    assert touched.all()
    assert simulated.tolist() == [[CLASS_SEALED, CLASS_HIGH, CLASS_LOCKED]]


def test_convert_to_low_changes_sealed_and_bare_ground():
    baseline = np.array([[CLASS_SEALED, CLASS_BARE, CLASS_HIGH, CLASS_LOW, CLASS_LOCKED]], dtype=np.uint8)
    all_cells = np.ones_like(baseline, dtype=bool)
    simulated, touched = apply_operations(baseline, [
        (all_cells, {"action": "convert-to-low", "target": "low"}),
    ])
    assert touched.all()
    assert simulated.tolist() == [[CLASS_LOW, CLASS_LOW, CLASS_HIGH, CLASS_LOW, CLASS_LOCKED]]


def test_convert_to_low_also_changes_sealing_added_earlier_in_the_session():
    baseline = np.array([[CLASS_HIGH, CLASS_LOW]], dtype=np.uint8)
    all_cells = np.ones_like(baseline, dtype=bool)
    simulated, _ = apply_operations(baseline, [
        (all_cells, {"action": "convert", "target": "sealed"}),
        (all_cells, {"action": "convert-to-low", "target": "low"}),
    ])
    # The existing high canopy remains above the newly unsealed low ground.
    assert simulated.tolist() == [[CLASS_HIGH, CLASS_LOW]]


def test_ground_is_exclusive_and_high_canopy_is_the_only_overlap():
    green = np.array([[4, 1, 2, 3]], dtype=np.uint8)
    soil = np.array([[1, 0, 1, 1]], dtype=np.uint8)
    baseline_canopy, baseline_ground, editable = baseline_surface_states(green, soil)
    assert editable.tolist() == [[True, True, True, False]]
    first = np.array([[1, 1, 0, 0]], dtype=bool)
    canopy, ground, _ = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(first, {"action": "convert", "target": "high"})],
    )
    assert canopy.tolist() == [[True, True, False, False]]
    assert np.array_equal(ground, baseline_ground)
    assert validate_ground_state(ground, canopy)
    second = np.array([[0, 1, 1, 0]], dtype=bool)
    canopy, ground, _ = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(second, {"action": "convert", "target": "sealed"})],
    )
    assert np.array_equal(canopy, baseline_canopy)
    assert ground.tolist() == [[GROUND_SEALED, GROUND_SEALED, GROUND_SEALED, GROUND_AGRICULTURE]]


def test_context_outside_the_editable_scope_keeps_its_physical_baseline():
    green = np.array([[2, 2]], dtype=np.uint8)
    soil = np.array([[0, 0]], dtype=np.uint8)
    canopy, ground, source_editable = baseline_surface_states(green, soil)
    editable = source_editable & np.array([[True, False]])
    changed_canopy, changed_ground, touched = apply_surface_operations(
        canopy, ground, editable,
        [(np.ones_like(editable), {"action": "convert", "target": "sealed"})],
    )
    assert touched.all()
    assert changed_ground.tolist() == [[GROUND_SEALED, GROUND_LOW]]
    assert np.array_equal(changed_canopy, canopy)


def test_already_targeted_cells_remain_touched_but_unchanged_for_accounting():
    green = np.array([[1, 2]], dtype=np.uint8)
    soil = np.array([[0, 1]], dtype=np.uint8)
    baseline_canopy, baseline_ground, editable = baseline_surface_states(green, soil)
    mask = np.ones_like(editable)
    canopy, ground, touched = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(mask, {"action": "convert", "target": "high"})],
    )
    assert touched.all()
    assert canopy.tolist() == [[True, True]]
    assert np.array_equal(ground, baseline_ground)
    assert canopy[0, 0] == baseline_canopy[0, 0]


def test_add_high_covers_supported_cells_and_keeps_the_ground_plane():
    green = np.array([[1, 2, 4]], dtype=np.uint8)
    soil = np.array([[0, 0, 0]], dtype=np.uint8)
    baseline_canopy, baseline_ground, editable = baseline_surface_states(green, soil)
    mask = np.ones_like(editable)
    canopy, ground, touched = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(mask, {"action": "convert", "target": "high"})],
    )
    assert touched.all()
    assert canopy.all()
    assert np.array_equal(ground, baseline_ground)


def test_remove_high_preserves_supported_ground_and_ignores_locked_cells():
    green = np.array([[1, 1, 2, 3]], dtype=np.uint8)
    soil = np.array([[1, 0, 0, 0]], dtype=np.uint8)
    baseline_canopy, baseline_ground, editable = baseline_surface_states(green, soil)
    mask = np.ones_like(editable)
    canopy, ground, touched = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(mask, {"action": "remove-high", "target": None})],
    )
    assert touched.all()
    assert canopy.tolist() == [[False, False, False, False]]
    assert np.array_equal(ground, baseline_ground)
    assert ground.tolist() == [[GROUND_SEALED, GROUND_LOW, GROUND_LOW, GROUND_AGRICULTURE]]


def test_convert_to_low_changes_sealed_and_other_unsealed_ground():
    green = np.array([[4, 4, 2]], dtype=np.uint8)
    soil = np.array([[1, 0, 0]], dtype=np.uint8)
    baseline_canopy, baseline_ground, editable = baseline_surface_states(green, soil)
    mask = np.ones_like(editable)
    canopy, ground, touched = apply_surface_operations(
        baseline_canopy, baseline_ground, editable,
        [(mask, {"action": "convert-to-low", "target": "low"})],
    )
    assert touched.all()
    assert ground.tolist() == [[GROUND_LOW, GROUND_LOW, GROUND_LOW]]


def test_fractional_area_is_conserved_before_convolution():
    values = np.zeros((30, 30), dtype=np.float32)
    values[:15, :] = conversion_delta(CLASS_SEALED, CLASS_HIGH)
    fractions = values.reshape(2, 15, 2, 15).mean(axis=(1, 3))
    np.testing.assert_allclose(fractions, [[-10.62, -10.62], [0.0, 0.0]], atol=1e-5)


def test_large_uniform_conversion_reaches_expected_interior_delta():
    from scipy.signal import fftconvolve

    field = np.full((101, 101), conversion_delta(CLASS_SEALED, CLASS_HIGH), dtype=np.float32)
    result = fftconvolve(field, radoux_kernel(), mode="same")
    assert result[50, 50] == pytest.approx(-10.62, abs=1e-4)


def test_delta_display_reprojection_keeps_peaks_at_three_map_locations():
    from pyproj import Transformer
    from rasterio.transform import from_origin

    source_transform = from_origin(580_000, 5_640_000, 30, 30)
    shape = (300, 300)
    display = web_display_grid(shape[1], shape[0], source_transform, "EPSG:32631")
    to_web = Transformer.from_crs("EPSG:32631", "EPSG:3857", always_xy=True)
    for row, column in ((45, 60), (150, 145), (250, 230)):
        analytical = np.zeros(shape, dtype=np.float32)
        analytical[row, column] = 4.0
        browser = reproject_delta_for_display(
            analytical, source_transform, "EPSG:32631", display,
        )
        display_row, display_column = np.unravel_index(np.argmax(browser), browser.shape)
        actual_x, actual_y = display["transform"] * (display_column + .5, display_row + .5)
        source_x, source_y = source_transform * (column + .5, row + .5)
        expected_x, expected_y = to_web.transform(source_x, source_y)
        assert np.hypot(actual_x - expected_x, actual_y - expected_y) <= 45


def test_add_remove_operations_keep_delta_sign_and_location_coherent():
    from scipy.signal import fftconvolve

    ground = np.full((90, 90), GROUND_LOW, dtype=np.uint8)
    canopy = np.zeros_like(ground, dtype=bool)
    canopy[30:45, 30:45] = True
    editable = np.ones_like(canopy)
    add_high = np.zeros_like(canopy); add_high[15:30, 15:30] = True
    remove_high = np.zeros_like(canopy); remove_high[30:45, 30:45] = True
    add_sealed = np.zeros_like(canopy); add_sealed[60:75, 60:75] = True
    changed_canopy, changed_ground, _ = apply_surface_operations(
        canopy, ground, editable, [
            (add_high, {"action": "convert", "target": "high"}),
            (remove_high, {"action": "remove-high", "target": None}),
            (add_sealed, {"action": "convert", "target": "sealed"}),
        ],
    )
    baseline = np.where(canopy, CLASS_HIGH, CLASS_LOW)
    simulated = np.where(
        changed_canopy, CLASS_HIGH,
        np.where(changed_ground == GROUND_SEALED, CLASS_SEALED, CLASS_LOW),
    )
    coefficient = np.vectorize({CLASS_HIGH: -7.42, CLASS_LOW: -2.07, CLASS_SEALED: 3.20}.get)
    delta = coefficient(simulated) - coefficient(baseline)
    assert np.all(delta[15:30, 15:30] < 0)
    assert np.all(delta[30:45, 30:45] > 0)
    assert np.all(delta[60:75, 60:75] > 0)
    mixture = delta.reshape(6, 15, 6, 15).mean(axis=(1, 3))
    assert mixture[1, 1] < 0
    assert mixture[2, 2] > 0
    assert mixture[4, 4] > 0
    # The symmetric PSF keeps an isolated response centred at several grid
    # positions instead of imposing a consistent lower-right displacement.
    for centre, sign in (((3, 3), -1), ((5, 5), 1), ((7, 7), 1)):
        impulse = np.zeros((11, 11), dtype=np.float32)
        impulse[centre] = sign
        smoothed = fftconvolve(impulse, radoux_kernel(size=5), mode="same")
        extreme = np.argmin(smoothed) if sign < 0 else np.argmax(smoothed)
        assert np.unravel_index(extreme, smoothed.shape) == centre


def test_output_scope_index_is_projected_to_the_landsat_grid():
    import geopandas as gpd
    from rasterio.transform import from_bounds
    from shapely.geometry import box
    from greenwave_local_layers.lst_scenario import rasterize_scope_index

    sectors = gpd.GeoDataFrame({"sectorId": ["test"]}, geometry=[box(140_000, 160_000, 141_000, 161_000)], crs=31370)
    projected = sectors.to_crs(32631)
    transform = from_bounds(*projected.total_bounds, 20, 20)
    result = rasterize_scope_index(sectors, "EPSG:32631", (20, 20), transform)
    assert np.count_nonzero(result) == 400


def test_both_methods_share_the_exact_edit_area_ledger():
    source = {
        "region": {"acceptedAreaHa": 1.2, "ignoredAreaHa": .3, "noChangeAreaHa": .4,
                   "outsideScopeAreaHa": .1, "submittedAreaHa": 2, "transitions": {"sealed-to-low": 1.2}},
        "municipalities": {"Halle": {"acceptedAreaHa": 1.2, "transitions": {}}},
        "sectors": {"A": {"acceptedAreaHa": .6, "transitions": {}}},
    }
    target = {
        "region": {"medianDeltaC": -.2},
        "municipalities": {"Halle": {"medianDeltaC": -.1}},
        "sectors": {"A": {"medianDeltaC": -.3}},
    }
    copied = ScenarioEngine._copy_area_accounting(target, source)
    assert copied["region"]["acceptedAreaHa"] == 1.2
    assert copied["region"]["transitions"] == {"sealed-to-low": 1.2}
    assert copied["municipalities"]["Halle"]["acceptedAreaHa"] == 1.2
    assert copied["sectors"]["A"]["acceptedAreaHa"] == .6


def test_land_cover_balance_reconciles_ground_and_separate_canopy():
    stats = {
        "groundDeltaHa": {
            "low": 1.25, "sealed": -1.25, "agriculture": 0,
            "water": 0, "bare": 0,
        },
        "highCanopyDeltaHa": .4,
    }
    baseline = {
        "groundBeforeHa": {
            "low": 10, "sealed": 5, "agriculture": 4, "water": 1, "bare": 2,
        },
        "highCanopyBeforeHa": 7,
        "validAnalysedAreaHa": 22,
        "lockedUnavailableAreaHa": .3,
    }
    result = ScenarioEngine._attach_land_cover_balance(stats, baseline)["landCoverBalance"]
    assert result["ground"]["low"] == {
        "beforeHa": 10, "changeHa": 1.25, "afterHa": 11.25,
    }
    assert result["ground"]["sealed"]["afterHa"] == 3.75
    assert sum(item["beforeHa"] for item in result["ground"].values()) == 22
    assert sum(item["afterHa"] for item in result["ground"].values()) == 22
    assert result["highCanopy"] == {
        "beforeHa": 7, "changeHa": .4, "afterHa": 7.4,
    }
    assert result["lockedUnavailableAreaHa"] == .3
