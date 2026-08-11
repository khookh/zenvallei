import math

from greenwave_local_layers.groenkaart_population import compact_cell_record


def test_population_cell_requires_point_one_hectare_and_finite_population():
    metadata = {"sectorId": "sector"}
    assert compact_cell_record(metadata, 2, 3, 10, 999, [999, 0, 0, 0]) is None
    assert compact_cell_record(metadata, 2, 3, math.nan, 1000, [1000, 0, 0, 0]) is None
    assert compact_cell_record(metadata, 2, 3, 10, 1000, [1000, 0, 0, 0])["a"] == .1


def test_population_cell_preserves_exact_area_weighted_class_means():
    record = compact_cell_record(
        {"sectorId": "23027A001"}, 12, 34, 27.5, 2500,
        [62_500, 25_000, 125_000, 37_500],
    )
    assert record == {
        "s": "23027A001", "r": 12, "c": 34, "p": 27.5, "a": .25,
        "g": [25.0, 10.0, 50.0, 15.0],
        "u": [[2500, 62500.0, 25000.0, 125000.0, 37500.0]],
    }
