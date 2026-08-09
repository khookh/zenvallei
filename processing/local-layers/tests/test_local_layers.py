from pathlib import Path

import numpy as np
import pytest

from greenwave_local_layers.cli import parse_source
from greenwave_local_layers.constants import (
    GROENKAART_CLASSES, GROENKAART_YEARS, JAARBAK_LAYERS, JAARBAK_YEARS,
)
from greenwave_local_layers.sources import extract_tiff_payload
from greenwave_local_layers.constants import (
    AGPA_CROP_GROUP_COLORS, LANDGEBRUIK_CLASSES, LANDGEBRUIK_LAYERS, LANDGEBRUIK_YEARS,
)
from greenwave_local_layers.pipeline import _crs_is_equivalent
from greenwave_local_layers.landgebruik import _parcel_value
from greenwave_local_layers.statistics import categorical_statistics, jaarbak_statistics


def test_wcs_direct_and_multipart_extraction():
    tiff = b"II*\x00" + b"payload"
    assert extract_tiff_payload(tiff) == tiff
    body = b"--abc\r\nContent-Type: image/tiff\r\n\r\n" + tiff + b"\r\n--abc--\r\n"
    assert extract_tiff_payload(body, 'multipart/mixed; boundary="abc"') == tiff
    with pytest.raises(ValueError):
        extract_tiff_payload(b"not a raster")
    with pytest.raises(ValueError, match="InvalidParameterValue"):
        extract_tiff_payload(
            b"<ServiceException>InvalidParameterValue</ServiceException>", "application/xml"
        )


def test_pinned_years_and_groenkaart_wms_colours():
    assert JAARBAK_YEARS == tuple(range(2018, 2025))
    assert GROENKAART_YEARS == (2018, 2021)
    assert [item["color"] for item in GROENKAART_CLASSES] == ["#1f7f00", "#bfff00", "#ffff00", "#adadad"]


def test_jaarbak_wcs_coverage_names_include_namespace():
    assert JAARBAK_LAYERS[2018] == "lc:lc_jaarbak_1m_2018"
    assert JAARBAK_LAYERS[2021] == "lc:lc_jaarbak_1m_2021"


def test_projection_equivalence_helper_rejects_a_different_crs():
    assert _crs_is_equivalent("IGNF:ETRS89LAEA", "EPSG:3035")
    assert not _crs_is_equivalent("EPSG:31370", "EPSG:3035")


def test_jaarbak_truth_table_uses_complete_area():
    values = np.ma.array([[0, 1, 255, 1]], mask=[[False, False, False, True]])
    stats = jaarbak_statistics(values, pixel_area_ha=0.25, complete_area_ha=1.0)
    assert stats["sealedAreaHa"] == 0.25
    assert stats["unsealedAreaHa"] == 0.25
    assert stats["noDataAreaHa"] == 0.5
    assert stats["sealedPercentage"] == 25.0


def test_groenkaart_preserves_exact_four_classes():
    values = np.array([[1, 2, 3, 4, 0]])
    stats = categorical_statistics(values, (1, 2, 3, 4), 0.2, 1.0, 0)
    assert [item["code"] for item in stats["classes"]] == [1, 2, 3, 4]
    assert all(item["percentage"] == 20 for item in stats["classes"])
    assert stats["noDataPercentage"] == pytest.approx(20)


def test_landgebruik_source_contract_preserves_three_editions_and_nineteen_classes():
    assert LANDGEBRUIK_YEARS == (2019, 2022, 2025)
    assert LANDGEBRUIK_LAYERS == {
        2019: "lu:lu_landgebruik_vlaa_2019_v3",
        2022: "lu:lu_landgebruik_vlaa_2022_v3",
        2025: "lu:lu_landgebruik_vlaa_2025_v3",
    }
    assert [item["value"] for item in LANDGEBRUIK_CLASSES] == list(range(1, 20))
    assert LANDGEBRUIK_CLASSES[0]["color"] == "#ff0000"
    assert LANDGEBRUIK_CLASSES[-1]["color"] == "#82ca5b"


def test_agpa_crop_group_palette_is_complete_and_keeps_official_labels():
    assert len(AGPA_CROP_GROUP_COLORS) == 13
    assert AGPA_CROP_GROUP_COLORS["Grasland"] == "#BFFF7F"
    assert AGPA_CROP_GROUP_COLORS["Maïs"] == "#FFFF00"


def test_agpa_non_finite_properties_are_normalised_before_json_serialisation():
    assert _parcel_value({"value": np.nan}, "value") is None
    assert _parcel_value({"value": np.inf}, "value") is None
    assert _parcel_value({"value": 12.5}, "value") == 12.5
    assert _parcel_value({"value": "  "}, "value") is None


def test_manual_source_parser(tmp_path: Path):
    source = tmp_path / "source.tif"
    source.write_bytes(b"fixture")
    assert parse_source([f"2021={source}"]) == {2021: source}
    with pytest.raises(Exception):
        parse_source(["2021=missing.tif"])
