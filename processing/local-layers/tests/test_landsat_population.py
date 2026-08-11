"""Scientific contracts for the Landsat-population comparison."""

from greenwave_local_layers.landsat_population import MINIMUM_ANALYSED_AREA_HA


def test_population_summary_uses_shared_exact_area_threshold():
    assert MINIMUM_ANALYSED_AREA_HA == 0.1
