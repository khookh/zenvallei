from __future__ import annotations

import json
from pathlib import Path

import nbformat
import numpy as np
import rasterio
from affine import Affine
from nbclient import NotebookClient

from greenwave_ndvi.source import EXPECTED_GRID


def _raw_fixture(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "width": EXPECTED_GRID["width"],
        "height": EXPECTED_GRID["height"],
        "count": 4,
        "dtype": "float32",
        "crs": "EPSG:32631",
        "transform": Affine(10, 0, EXPECTED_GRID["bbox"][0], 0, -10, EXPECTED_GRID["bbox"][3]),
        "compress": "DEFLATE",
        "predictor": 3,
        "tiled": True,
    }
    with rasterio.open(path, "w", **profile) as destination:
        shape = (EXPECTED_GRID["height"], EXPECTED_GRID["width"])
        destination.write(np.full(shape, 0.2, dtype="float32"), 1)
        destination.write(np.full(shape, 0.6, dtype="float32"), 2)
        destination.write(np.full(shape, 4, dtype="float32"), 3)
        destination.write(np.ones(shape, dtype="float32"), 4)


def test_halle_notebook_executes_two_python_ndvi_years_offline(tmp_path, monkeypatch):
    project_root = Path(__file__).resolve().parents[3]
    notebook_path = project_root / "playground" / "ndvi" / "01_halle_ndvi_2020_2021.ipynb"
    raw_cache = tmp_path / "raw"
    export = tmp_path / "web"
    _raw_fixture(raw_cache / "sentinel-2-l2a-raw-2020-06-24-epsg32631-10m.tif")
    _raw_fixture(raw_cache / "sentinel-2-l2a-raw-2021-06-14-epsg32631-10m.tif")
    monkeypatch.setenv("GREENWAVE_NDVI_RAW_CACHE", str(raw_cache))
    monkeypatch.setenv("GREENWAVE_PLAYGROUND_EXPORT", str(export))
    monkeypatch.setenv("GREENWAVE_NDVI_OFFLINE", "1")

    notebook = nbformat.read(notebook_path, as_version=4)
    executed = NotebookClient(
        notebook, timeout=240, kernel_name="python3",
        resources={"metadata": {"path": str(notebook_path.parent)}},
    ).execute()

    map_cell = next(cell for cell in executed.cells if cell.id == "halle-maps")
    assert any("image/png" in output.get("data", {}) for output in map_cell.outputs)
    quality_cell = next(cell for cell in executed.cells if cell.id == "compute-ndvi")
    text = json.dumps(quality_cell.outputs)
    assert "2020-06-24" in text and "2021-06-14" in text
    manifest = json.loads((export / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["kind"] == "continuous"
    assert manifest["source"]["date"] == "2021-06-14"
    assert (export / "test.png").exists()
