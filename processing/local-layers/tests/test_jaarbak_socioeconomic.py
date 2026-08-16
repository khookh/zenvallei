from greenwave_local_layers.jaarbak_socioeconomic import _selected_sector_stats


def test_selected_sector_statistics_use_exact_area_weights():
    records = {
        "sector": {
            "sectorId": "sector",
            "urbanSurfaceGroups": {
                "residential": {
                    "analysedAreaHa": 0.1,
                    "densityAreaSum": 1_000 * 10,
                    "meanDensity": 10,
                },
                "employmentInstitutional": {
                    "analysedAreaHa": 0.3,
                    "densityAreaSum": 3_000 * 90,
                    "meanDensity": 90,
                },
            },
        },
    }
    selected = _selected_sector_stats(
        records, ("residential", "employmentInstitutional"),
    )["sector"]
    assert selected["analysedAreaHa"] == 0.4
    assert selected["meanDensity"] == 70
    assert selected["meanDensity"] != 50
