from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pytest
import rasterio
import xarray as xr
from affine import Affine
from shapely.geometry import box

from greenwave_ndvi import (
    CdseCredentials,
    MASKED_SCL_CLASSES,
    compute_ndvi,
    export_categorical_layer,
    export_continuous_layer,
    load_sectors,
    municipality_bounds,
    open_ndvi_stack,
    open_raw_observation,
)


def dataset(b04, b08, scl, data_mask) -> xr.Dataset:
    shape = np.asarray(b04).shape
    return xr.Dataset(
        {
            "b04": (("y", "x"), np.asarray(b04, dtype="float32")),
            "b08": (("y", "x"), np.asarray(b08, dtype="float32")),
            "scl": (("y", "x"), np.asarray(scl, dtype="uint8")),
            "data_mask": (("y", "x"), np.asarray(data_mask, dtype=bool)),
        },
        coords={"x": np.arange(shape[1]) * 10 + 5, "y": np.arange(shape[0])[::-1] * 10 + 5},
        attrs={"crs": "EPSG:32631", "transform": (10, 0, 0, 0, -10, shape[0] * 10)},
    )


def test_credentials_do_not_reveal_the_secret(monkeypatch):
    monkeypatch.setenv("CDSE_SH_CLIENT_ID", "client")
    monkeypatch.setenv("CDSE_SH_CLIENT_SECRET", "very-secret")
    credentials = CdseCredentials("client", "very-secret")
    assert credentials.client_secret == "very-secret"
    assert "very-secret" not in repr(credentials)


def test_process_request_fetches_raw_bands_without_computing_ndvi():
    import greenwave_ndvi.source as source_module

    payload = source_module._request_payload("2021-06-14")
    request = payload["input"]["data"][0]
    assert request["type"] == "sentinel-2-l2a"
    assert request["processing"] == {
        "harmonizeValues": True,
        "upsampling": "NEAREST",
        "downsampling": "NEAREST",
    }
    assert payload["output"]["width"] == 2474
    assert payload["output"]["height"] == 1532
    assert '["B04", "B08", "SCL", "dataMask"]' in payload["evalscript"]
    assert "NDVI" not in payload["evalscript"]


def test_compute_ndvi_uses_the_exact_formula_and_masks_every_invalid_scl_class():
    classes = np.asarray([2, 4, 5, 6, *MASKED_SCL_CLASSES], dtype="uint8")[None, :]
    red = np.full(classes.shape, 0.2, dtype="float32")
    nir = np.full(classes.shape, 0.6, dtype="float32")
    result = compute_ndvi(dataset(red, nir, classes, np.ones_like(classes)), mask_to_zennevallei=False)
    np.testing.assert_allclose(result.values[0, :4], 0.5, atol=1e-6)
    assert np.isnan(result.values[0, 4:]).all()
    assert result.attrs["formula"] == "(B08 - B04) / (B08 + B04)"


def test_compute_ndvi_rejects_missing_observations_zero_denominators_and_out_of_range_values():
    raw = dataset(
        [[0.2, 0.0, -2.0, 0.2]],
        [[0.6, 0.0, 1.0, 0.6]],
        [[4, 4, 4, 4]],
        [[1, 1, 1, 0]],
    )
    result = compute_ndvi(raw, mask_to_zennevallei=False)
    assert result.values[0, 0] == pytest.approx(0.5)
    assert np.isnan(result.values[0, 1:]).all()


def test_real_sector_table_and_halle_rectangle():
    sectors = load_sectors()
    bounds = municipality_bounds("Halle", padding_m=1000)
    halle = sectors[sectors.municipality == "Halle"].to_crs("EPSG:32631")
    left, bottom, right, top = halle.total_bounds
    assert len(sectors) == 154
    assert bounds == pytest.approx((left - 1000, bottom - 1000, right + 1000, top + 1000))


def test_open_raw_observation_exposes_labelled_bands(tmp_path, monkeypatch):
    import greenwave_ndvi.source as source_module

    monkeypatch.setattr(source_module, "EXPECTED_GRID", {"bbox": [0, 0, 30, 20], "width": 3, "height": 2})
    path = tmp_path / "sentinel-2-l2a-raw-2021-06-14-epsg32631-10m.tif"
    profile = {
        "driver": "GTiff", "width": 3, "height": 2, "count": 4, "dtype": "float32",
        "crs": "EPSG:32631", "transform": Affine(10, 0, 0, 0, -10, 20),
    }
    with rasterio.open(path, "w", **profile) as destination:
        destination.write(np.stack([
            np.full((2, 3), 0.2), np.full((2, 3), 0.6),
            np.full((2, 3), 4), np.ones((2, 3)),
        ]).astype("float32"))
    opened = open_raw_observation(path)
    assert set(opened.data_vars) == {"b04", "b08", "scl", "data_mask"}
    assert opened.attrs["date"] == "2021-06-14"
    assert opened.sizes == {"y": 2, "x": 3}


def test_stack_discovers_only_raw_observations_that_are_present(tmp_path, monkeypatch):
    import greenwave_ndvi.source as source_module

    monkeypatch.setattr(source_module, "EXPECTED_GRID", {"bbox": [0, 0, 30, 20], "width": 3, "height": 2})
    profile = {
        "driver": "GTiff", "width": 3, "height": 2, "count": 4, "dtype": "float32",
        "crs": "EPSG:32631", "transform": Affine(10, 0, 0, 0, -10, 20),
    }
    for date in ("2020-06-24", "2021-06-14"):
        path = tmp_path / f"sentinel-2-l2a-raw-{date}-epsg32631-10m.tif"
        with rasterio.open(path, "w", **profile) as destination:
            destination.write(np.stack([
                np.full((2, 3), 0.2), np.full((2, 3), 0.6),
                np.full((2, 3), 4), np.ones((2, 3)),
            ]).astype("float32"))
    sectors = gpd.GeoDataFrame(
        {"sectorId": ["TEST"], "municipality": ["Halle"]},
        geometry=[box(0, 0, 30, 20)], crs="EPSG:32631",
    ).to_crs("EPSG:4326")
    sectors_path = tmp_path / "sectors.geojson"
    sectors.to_file(sectors_path, driver="GeoJSON")

    stack = open_ndvi_stack(cache_dir=tmp_path, sectors_path=sectors_path, chunks=(1, 2, 3))

    assert stack.sizes == {"time": 2, "y": 2, "x": 3}
    assert [str(value)[:10] for value in stack.time.values] == ["2020-06-24", "2021-06-14"]


def test_exporters_create_browser_ready_continuous_and_categorical_contracts(tmp_path):
    transform = Affine(10, 0, 580000, 0, -10, 5620000)
    x = transform.c + (np.arange(4) + 0.5) * transform.a
    y = transform.f + (np.arange(3) + 0.5) * transform.e
    data = xr.DataArray(
        np.asarray([[0.1, 0.3, 0.6, np.nan], [0.2, 0.4, 0.8, 0.7], [0.0, 0.5, 0.9, 1.0]], dtype="float32"),
        dims=("y", "x"), coords={"x": x, "y": y}, attrs={"crs": "EPSG:32631", "date": "2021-06-14"},
    )
    polygon = gpd.GeoDataFrame(
        {"sectorId": ["TEST"], "municipality": ["Halle"]},
        geometry=[box(580000, 5619970, 580040, 5620000)], crs="EPSG:32631",
    ).to_crs("EPSG:4326")
    sectors_path = tmp_path / "sectors.geojson"
    polygon.to_file(sectors_path, driver="GeoJSON")

    continuous = tmp_path / "continuous"
    manifest_path = export_continuous_layer(
        data, title={"en": "NDVI test", "nl": "NDVI-test"}, output_dir=continuous, sectors_path=sectors_path,
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["kind"] == "continuous"
    assert manifest["title"]["en"] == "NDVI test"
    assert set(manifest["rasterVariants"]) == {"all", "Halle"}
    assert len(manifest["coordinates"]) == 4
    assert (continuous / "test.png").exists()
    assert manifest["sectorStats"]["TEST"]["median"] == pytest.approx(0.5)
    assert manifest["municipalityStats"]["Halle"]["median"] == pytest.approx(0.5)

    categorical = tmp_path / "categorical"
    classes = [
        {"value": 0, "label": "Low", "color": "#d9deda"},
        {"value": 1, "label": "High", "color": "#238b45"},
    ]
    result = xr.where(data >= 0.5, 1, 0).where(np.isfinite(data)).assign_attrs(data.attrs)
    categorical_path = export_categorical_layer(result, classes, output_dir=categorical, sectors_path=sectors_path)
    categorical_manifest = json.loads(categorical_path.read_text(encoding="utf-8"))
    assert categorical_manifest["kind"] == "categorical"
    assert categorical_manifest["legend"]["items"] == [
        {"value": 0, "label": "Low", "color": "#d9deda"},
        {"value": 1, "label": "High", "color": "#238b45"},
    ]
    assert sum(item["areaHa"] for item in categorical_manifest["sectorStats"]["TEST"]["classes"]) == pytest.approx(0.11)
