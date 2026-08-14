from pathlib import Path

import nbformat

import greenwave_local_layers.image_regression_xgboost_notebook as runner


def test_runner_writes_only_the_cached_execution(monkeypatch, tmp_path):
    source = tmp_path / "source.ipynb"
    destination = tmp_path / "executed.ipynb"
    notebook = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell("value = 1")])
    nbformat.write(notebook, source)
    original = source.read_bytes()

    class FakeClient:
        def __init__(self, loaded, **_options):
            self.loaded = loaded

        def execute(self):
            self.loaded.cells[0]["outputs"] = [nbformat.v4.new_output("stream", text="ok\n")]
            return self.loaded

    monkeypatch.setattr(runner, "SOURCE", source)
    monkeypatch.setattr(runner, "DESTINATION", destination)
    monkeypatch.setattr(runner, "NotebookClient", FakeClient)
    monkeypatch.setattr(runner, "prepare_notebook_diagnostics", lambda: Path("diagnostics.npz"))
    runner.main()

    assert source.read_bytes() == original
    assert destination.exists()
    assert nbformat.read(destination, as_version=4).cells[0].outputs[0].text == "ok\n"
