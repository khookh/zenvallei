"""Unit contracts for native-1 m masking of 30 m Landsat temperatures."""

import numpy as np

from greenwave_local_layers.exact_landsat_mask import (
    ExactMaskTable,
    SOIL_SEALED,
    SOIL_UNSEALED,
    exact_area_mean,
    exact_area_summary,
    meets_minimum_analysed_area,
    selected_records,
)


def test_partial_landsat_intersections_equal_direct_retained_cell_mean():
    # Five native Landsat observations retain different exact areas. Expanding
    # each temperature over its retained 1 m cells gives the same result as the
    # stored temperature-area sum, without creating five sets of 1 m readings.
    temperatures = np.array([20.0, 25.0, 30.0, 35.0, 40.0])
    areas_m2 = np.array([37, 121, 359, 11, 472])
    direct = np.repeat(temperatures, areas_m2).mean()
    summary = exact_area_summary(temperatures, areas_m2)
    assert summary["analysedAreaHa"] == 0.1
    assert summary["contributingLandsatCount"] == 5
    assert summary["meanTemperatureC"] == round(float(direct), 5)
    assert exact_area_mean(summary["temperatureAreaSum"], areas_m2.sum()) == direct


def test_exact_summary_threshold_excludes_999_and_includes_1000_square_metres():
    assert meets_minimum_analysed_area(999) is False
    assert meets_minimum_analysed_area(1_000) is True


def test_mixed_surface_parts_keep_one_parent_temperature_and_separate_areas():
    temperature = 32.5
    sealed_area, unsealed_area = 263, 637
    assert exact_area_mean(temperature * sealed_area, sealed_area) == temperature
    assert exact_area_mean(temperature * unsealed_area, unsealed_area) == temperature
    combined = exact_area_mean(
        temperature * sealed_area + temperature * unsealed_area,
        sealed_area + unsealed_area,
    )
    assert combined == temperature


def test_cross_sector_population_and_urban_boundaries_preserve_exact_parts():
    table = ExactMaskTable(
        landsat=np.array([1, 1, 1, 2, 2], dtype=np.uint32),
        sector=np.array([1, 2, 2, 1, 1], dtype=np.uint16),
        urban_class=np.array([1, 1, 2, 1, 2], dtype=np.uint8),
        soil=np.array([SOIL_SEALED, SOIL_SEALED, SOIL_UNSEALED, SOIL_SEALED, SOIL_SEALED]),
        status=np.ones(5, dtype=np.uint8),
        population=np.array([5, 5, 6, 5, 6], dtype=np.uint32),
        area_m2=np.array([300, 200, 400, 100, 50], dtype=np.uint32),
        green_area_m2=np.zeros(5, dtype=np.uint32), green_sums=np.zeros((5, 4)),
        temperature=np.array([30.0, 35.0]), sector_ids=("A", "B"),
        urban_codes=("11100", "12100"), population_width=10,
    )
    residential_sealed = selected_records(
        table, urban_codes=("11100",), soil=SOIL_SEALED, status=1,
    )
    assert table.area_m2[residential_sealed].sum() == 600
    assert np.unique(table.landsat[residential_sealed]).size == 2
    assert table.area_m2[residential_sealed & (table.sector == 1)].sum() == 400
    assert table.area_m2[residential_sealed & (table.sector == 2)].sum() == 200
    assert table.area_m2[residential_sealed & (table.population == 5)].sum() == 600
    assert table.area_m2[selected_records(table, urban_codes=("12100",), soil=SOIL_UNSEALED)].sum() == 400
    assert table.area_m2[selected_records(table, urban_codes=("12100",), soil=SOIL_SEALED)].sum() == 50
