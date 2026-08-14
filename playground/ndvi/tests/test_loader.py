import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_geom

from greenwave_ndvi import (
    build_zennevallei_mask,
    discover_observations,
    open_observation,
    open_stack,
)


def write_observation(cache: Path, date: str, *, selected: bool, invalid_band_count: bool = False):
    path = cache / f"sentinel-2-l2a-ndvi-validity-{date}-epsg32631-10m.tif"
    ndvi = np.array([[0.7, 0.2], [0.8, -0.1]], dtype="float32")
    validity = np.array([[1, 1], [1, 0]], dtype="float32")
    count = 1 if invalid_band_count else 2
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=count,
        dtype="float32",
        crs="EPSG:32631",
        transform=from_origin(500000, 5600000, 10, 10),
    ) as destination:
        destination.write(ndvi, 1)
        if count == 2:
            destination.write(validity, 2)
    sidecar = {
        "year": int(date[:4]),
        "date": date,
        "cloudQuality": {"cloudAffectedPercentage": 0.2, "coveragePercentage": 100},
        "products": [{"id": f"fixture-{date}"}],
    }
    Path(f"{path}.json").write_text(json.dumps(sidecar), encoding="utf-8")
    return path


def write_fixture(tmp_path: Path):
    cache = tmp_path / "vegetation"
    cache.mkdir()
    selected_path = write_observation(cache, "2023-06-24", selected=True)
    write_observation(cache, "2023-07-04", selected=False)
    selection = {"years": {"2023": {"selectedDate": "2023-06-24"}}}
    selection_path = cache / "selection.json"
    selection_path.write_text(json.dumps(selection), encoding="utf-8")

    polygon_utm = {
        "type": "Polygon",
        "coordinates": [[[500000, 5600000], [500010, 5600000], [500010, 5599980], [500000, 5599980], [500000, 5600000]]],
    }
    polygon_wgs84 = transform_geom("EPSG:32631", "EPSG:4326", polygon_utm)
    sectors_path = tmp_path / "sectors.geojson"
    sectors_path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": polygon_wgs84}],
    }), encoding="utf-8")
    return cache, selection_path, sectors_path, selected_path


def test_discovers_selected_and_alternative_observations(tmp_path):
    cache, selection, _, _ = write_fixture(tmp_path)
    selected = discover_observations(cache_dir=cache, selection_path=selection)
    all_cached = discover_observations(False, cache_dir=cache, selection_path=selection)
    assert selected["date"].dt.strftime("%Y-%m-%d").tolist() == ["2023-06-24"]
    assert len(all_cached) == 2
    assert all_cached["selected"].tolist() == [True, False]


def test_opens_and_masks_one_observation(tmp_path):
    cache, selection, sectors, _ = write_fixture(tmp_path)
    dataset = open_observation(2023, cache_dir=cache, selection_path=selection, sectors_path=sectors)
    assert dataset.ndvi.shape == (2, 2)
    assert dataset.attrs["crs"] == "EPSG:32631"
    assert dataset.valid.values.tolist() == [[True, False], [True, False]]
    assert np.isnan(dataset.ndvi.values[0, 1])
    assert build_zennevallei_mask(dataset, sectors_path=sectors).sum().item() == 2


def test_builds_a_lazy_aligned_stack(tmp_path):
    cache, selection, sectors, _ = write_fixture(tmp_path)
    stack = open_stack(cache_dir=cache, selection_path=selection, sectors_path=sectors, chunks=(1, 1, 1))
    assert stack.ndvi.dims == ("time", "y", "x")
    assert stack.ndvi.chunks[0] == (1,)
    assert stack.sizes == {"time": 1, "y": 2, "x": 2}
    assert np.isclose(stack.ndvi.mean(skipna=True).compute().item(), 0.75)


def test_rejects_an_incompatible_raster(tmp_path):
    cache, selection, sectors, _ = write_fixture(tmp_path)
    broken = write_observation(cache, "2024-06-24", selected=False, invalid_band_count=True)
    try:
        open_observation(broken, cache_dir=cache, selection_path=selection, sectors_path=sectors)
    except ValueError as error:
        assert "NDVI and validity bands" in str(error)
    else:
        raise AssertionError("Expected the one-band fixture to be rejected")


def test_real_cache_exposes_the_twelve_selected_common_grid():
    project_root = Path(__file__).resolve().parents[3]
    cache = project_root / ".cache" / "vegetation"
    if not cache.exists():
        return
    inventory = discover_observations()
    assert inventory["year"].tolist() == list(range(2015, 2027))
    stack = open_stack(chunks=(1, 512, 512))
    assert stack.sizes == {"time": 12, "y": 1532, "x": 2474}
    assert stack.attrs["crs"] == "EPSG:32631"
    assert stack.attrs["resolution_meters"] == 10


def test_example_notebooks_are_clean_json_without_saved_outputs():
    notebook_root = Path(__file__).resolve().parents[1]
    notebooks = sorted(notebook_root.glob("*.ipynb"))
    assert [path.name for path in notebooks] == ["01_halle_ndvi_2020_2021.ipynb"]
    for notebook_path in notebooks:
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        assert notebook["nbformat"] == 4
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                assert cell.get("outputs", []) == []
                assert cell.get("execution_count") is None
