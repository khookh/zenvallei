"""Deterministic unit tests for the comparison assignment and histograms."""

import numpy as np

from greenwave_local_layers.landsat_urban_atlas import (
    BIN_EDGES, FAMILIES, _exact_distribution, majority_from_subpixels,
)
from greenwave_local_layers.exact_landsat_mask import ExactMaskTable


def test_majority_requires_eighteen_subpixels_and_rejects_ties():
    samples = np.array([
        [10] * 18 + [20] * 17 + [0],
        [10] * 18 + [20] * 18,
        [10] * 17 + [20] * 10 + [0] * 9,
        [10] * 19 + [20] * 17,
    ], dtype=np.uint16)
    assert majority_from_subpixels(samples).tolist() == [10, 0, 0, 10]


def test_exact_histogram_weights_partial_surface_and_keeps_statuses_separate():
    temperature = np.array([14.9, 15.0, 15.49, 49.9, 50.0, 50.1, 35.0, 35.0])
    table = ExactMaskTable(
        landsat=np.arange(1, 9, dtype=np.uint32), sector=np.ones(8, dtype=np.uint16),
        urban_class=np.ones(8, dtype=np.uint8), soil=np.ones(8, dtype=np.uint8),
        status=np.array([1, 1, 1, 1, 1, 1, 2, 0], dtype=np.uint8),
        population=np.zeros(8, dtype=np.uint32), area_m2=np.array([10, 20, 30, 40, 50, 60, 70, 80]),
        green_area_m2=np.zeros(8, dtype=np.uint32), green_sums=np.zeros((8, 4)),
        temperature=temperature, sector_ids=("sector",), urban_codes=("11100",), population_width=1,
    )
    result = _exact_distribution(table, np.ones(8, dtype=bool))
    assert len(result["binAreaM2"]) == len(BIN_EDGES) - 1
    assert sum(result["binAreaM2"]) == 140
    assert result["underflowAreaM2"] == 10
    assert result["overflowAreaM2"] == 60
    assert result["cloudObservedAreaHa"] == 0.007
    assert result["otherMissingAreaHa"] == 0.008
    assert result["contributingLandsatCount"] == 6


def test_analysis_families_are_disjoint_and_include_expected_memberships():
    memberships = [code for family in FAMILIES for code in family["codes"]]
    assert len(memberships) == len(set(memberships))
    by_id = {family["id"]: set(family["codes"]) for family in FAMILIES}
    assert {"11100", "12100", "12210", "13400"}.issubset(by_id["artificialSurfaces"])
    assert by_id["greenUrbanAreas"] == {"14110", "14120", "14130"}
    assert by_id["agriculture"] == {"21000", "22000", "23000", "24000"}
    assert by_id["forestSemiNatural"] == {"31000", "32000", "33000"}
