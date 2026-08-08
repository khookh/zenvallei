"""Deterministic unit tests for the comparison assignment and histograms."""

import numpy as np

from greenwave_local_layers.landsat_urban_atlas import (
    BIN_EDGES, FAMILIES, _distribution, majority_from_subpixels,
)


def test_majority_requires_eighteen_subpixels_and_rejects_ties():
    samples = np.array([
        [10] * 18 + [20] * 17 + [0],
        [10] * 18 + [20] * 18,
        [10] * 17 + [20] * 10 + [0] * 9,
        [10] * 19 + [20] * 17,
    ], dtype=np.uint16)
    assert majority_from_subpixels(samples).tolist() == [10, 0, 0, 10]


def test_histogram_keeps_underflow_overflow_cloud_and_missing_separate():
    temperatures = np.array([14.9, 15.0, 15.49, 49.9, 50.0, 50.1, np.nan, np.nan])
    status = np.array([1, 1, 1, 1, 1, 1, 2, 0], dtype=np.uint8)
    result = _distribution(temperatures, status, np.ones(8, dtype=bool))
    assert len(result["binCounts"]) == len(BIN_EDGES) - 1
    assert result["clearPixelCount"] == 6
    assert sum(result["binCounts"]) == 4
    assert result["underflowCount"] == 1
    assert result["overflowCount"] == 1
    assert result["cloudPixelCount"] == 1
    assert result["otherMissingPixelCount"] == 1


def test_analysis_families_are_disjoint_and_include_expected_memberships():
    memberships = [code for family in FAMILIES for code in family["codes"]]
    assert len(memberships) == len(set(memberships))
    by_id = {family["id"]: set(family["codes"]) for family in FAMILIES}
    assert {"11100", "12100", "12210", "13400"}.issubset(by_id["artificialSurfaces"])
    assert by_id["greenUrbanAreas"] == {"14110", "14120", "14130"}
    assert by_id["agriculture"] == {"21000", "22000", "23000", "24000"}
    assert by_id["forestSemiNatural"] == {"31000", "32000", "33000"}
