"""Scientific-grid contract tests for Green Map x Urban Atlas."""

import numpy as np

from greenwave_local_layers.groenkaart_urban_atlas import (
    FABRIC_CODES, GREEN_CODES, _density_distribution, _scope_statistics,
)


def test_fabric_contract_has_five_classes_and_excludes_isolated_structures():
    assert FABRIC_CODES == ("11100", "11210", "11220", "11230", "11240")
    assert "11300" not in FABRIC_CODES
    assert GREEN_CODES == (1, 2, 3, 4)


def test_statistics_use_cell_centres_and_sum_selected_green_bands():
    densities = np.array([
        [[10.0, 20.0], [30.0, 40.0]],
        [[5.0, 10.0], [15.0, 20.0]],
        [[70.0, 60.0], [50.0, 40.0]],
        [[15.0, 10.0], [5.0, 0.0]],
    ])
    fabric = np.array([[1, 1], [2, 0]], dtype=np.uint8)
    sector = np.ones((2, 2), dtype=np.uint16)
    stats = _scope_statistics(
        densities, fabric, sector,
        {1: {"sectorId": "sector-a", "municipality": "Halle"}},
    )["region:zennevallei"]["classes"]

    assert stats["11100"]["validCellCount"] == 2
    assert stats["11100"]["validAreaHa"] == 0.02
    assert stats["11100"]["meanDensityByGreenClass"] == {
        "1": 15.0, "2": 7.5, "3": 65.0, "4": 12.5,
    }
    assert stats["11100"]["densityDistributions"]["1+2"] == {
        "count": 2, "q1": 18.75, "median": 22.5, "q3": 26.25,
        "whiskerLow": 15.0, "whiskerHigh": 30.0,
    }
    assert stats["11210"]["validCellCount"] == 1
    assert stats["11210"]["meanDensityByGreenClass"]["1"] == 30.0
    assert stats["11220"]["validCellCount"] == 0
    assert stats["11220"]["meanDensityByGreenClass"]["1"] is None


def test_tukey_distribution_keeps_whiskers_inside_the_fences():
    result = _density_distribution([10, 11, 12, 13, 14, 90])
    assert result["count"] == 6
    assert result["whiskerLow"] == 10
    assert result["whiskerHigh"] == 14
