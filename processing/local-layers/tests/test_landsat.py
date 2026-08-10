"""Deterministic tests for Landsat discovery, scaling and quality semantics."""

from datetime import datetime, timezone

import numpy as np
from rasterio.transform import from_origin
from shapely.geometry import box

from greenwave_local_layers.landsat import (
    EXCLUDED_OBSERVATION_DATES,
    HEATWAVES,
    _one_area_stats,
    classify_quality,
    group_items_by_date,
    is_observation_excluded,
    select_clearest_candidate,
    scale_surface_temperature,
)


def test_complete_region_statistics_use_the_analytical_raster_directly():
    temperature = np.array([[20.0, 30.0], [np.nan, np.nan]], dtype=np.float32)
    status = np.array([[1, 1], [2, 0]], dtype=np.uint8)
    uncertainty = np.array([[0.5, 0.7], [np.nan, np.nan]], dtype=np.float32)
    grid = {
        "width": 2, "height": 2, "crs": "EPSG:32631",
        "transform": from_origin(0, 60, 30, 30),
    }
    stats = _one_area_stats(temperature, status, uncertainty, grid, box(0, 0, 60, 60), 0.36)
    assert stats["clearAreaHa"] == 0.18
    assert stats["cloudAreaHa"] == 0.09
    assert stats["otherNoDataAreaHa"] == 0.09
    assert stats["meanC"] == 25.0
    assert stats["medianC"] == 20.0


def test_official_kmi_periods_are_pinned():
    assert [(item["start"], item["end"]) for item in HEATWAVES] == [
        ("2020-08-05", "2020-08-16"),
        ("2022-08-09", "2022-08-16"),
        ("2023-06-08", "2023-06-17"),
        ("2023-09-04", "2023-09-11"),
        ("2025-06-28", "2025-07-02"),
        ("2025-08-10", "2025-08-15"),
        ("2026-06-17", "2026-06-28"),
    ]
    assert all(item["sourceUrl"].startswith("https://www.meteo.be/") for item in HEATWAVES)


def test_exact_collection_two_temperature_scaling():
    values = scale_surface_temperature(np.array([0, 40000, 50000], dtype=np.uint16))
    expected = np.array([
        149.0 - 273.15,
        40000 * 0.00341802 + 149.0 - 273.15,
        50000 * 0.00341802 + 149.0 - 273.15,
    ])
    np.testing.assert_allclose(values, expected, atol=1e-5)


def test_quality_truth_table_masks_fill_cloud_and_saturation():
    st = np.full(15, 40000, dtype=np.uint16)
    qa_pixel = np.zeros(15, dtype=np.uint16)
    qa_radsat = np.zeros(15, dtype=np.uint16)
    qa_pixel[1] = 1  # fill
    for index, bit in enumerate((1, 2, 3, 4, 5), start=2):
        qa_pixel[index] = 1 << bit
    for index, bit in enumerate((0, 1, 2, 3, 4, 5, 6, 8), start=7):
        qa_radsat[index] = 1 << bit
    status = classify_quality(st, qa_pixel, qa_radsat)
    assert status[0] == 1
    assert status[1] == 0
    assert status[2:7].tolist() == [2, 2, 2, 2, 2]
    assert status[7:].tolist() == [0] * 8


def test_missing_temperature_remains_transparent_but_cloud_is_grid():
    status = classify_quality(
        np.array([0, 0], dtype=np.uint16),
        np.array([0, 1 << 3], dtype=np.uint16),
        np.zeros(2, dtype=np.uint16),
    )
    assert status.tolist() == [0, 2]


class _Item:
    def __init__(self, value):
        self.datetime = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)


def test_adjacent_rows_group_by_overpass_date():
    items = [_Item("2023-06-13T10:47:00"), _Item("2023-06-13T10:47:30"), _Item("2023-06-14T10:41:00")]
    groups = group_items_by_date(items)
    assert list(groups) == ["2023-06-13", "2023-06-14"]
    assert len(groups["2023-06-13"]) == 2


def test_withdrawn_acquisition_cannot_return_to_the_timeline():
    assert EXCLUDED_OBSERVATION_DATES == {"2020-08-16": "excluded-from-timeline"}
    assert is_observation_excluded("2020-08-16") is True
    assert is_observation_excluded("2020-08-07") is False


def test_clearest_acquisition_is_selected_once_per_heatwave():
    june = next(item for item in HEATWAVES if item["id"] == "2023-06")
    chosen, rejected = select_clearest_candidate(june, [
        {"date": "2023-06-14", "acquiredAt": "2023-06-14T10:41:00Z", "coveragePercentage": 97.50},
        {"date": "2023-06-13", "acquiredAt": "2023-06-13T10:47:00Z", "coveragePercentage": 99.80},
    ])
    assert chosen["date"] == "2023-06-13"
    assert [item["date"] for item in rejected] == ["2023-06-14"]

    september = next(item for item in HEATWAVES if item["id"] == "2023-09")
    chosen, rejected = select_clearest_candidate(september, [
        {"date": "2023-09-10", "acquiredAt": "2023-09-10T10:35:00Z", "coveragePercentage": 91.33},
        {"date": "2023-09-09", "acquiredAt": "2023-09-09T10:41:00Z", "coveragePercentage": 99.87},
    ])
    assert chosen["date"] == "2023-09-09"
    assert [item["date"] for item in rejected] == ["2023-09-10"]
