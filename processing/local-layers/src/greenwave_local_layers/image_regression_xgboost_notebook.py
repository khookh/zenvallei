"""Prepare diagnostics and execute the public 2026 XGBoost notebook."""

from pathlib import Path

import nbformat
from nbclient import NotebookClient

from .constants import PROJECT_ROOT
from .image_regression_optuna import prepare_notebook_diagnostics
from .image_regression_xgboost_pipeline import DEFAULT_ARTIFACTS


SOURCE = PROJECT_ROOT / "playground" / "xgboost_2026_heatwave_regression_zennevallei.ipynb"
DESTINATION = DEFAULT_ARTIFACTS.root / "xgboost_2026_heatwave_regression_zennevallei_executed.ipynb"


def main():
    diagnostics = prepare_notebook_diagnostics()
    print(f"Prepared notebook diagnostics: {diagnostics}")
    notebook = nbformat.read(SOURCE, as_version=4)
    executed = NotebookClient(
        notebook,
        timeout=None,
        kernel_name="python3",
        resources={"metadata": {"path": str(PROJECT_ROOT)}},
    ).execute()
    # The tracked copy is the public source linked by the application. Keeping
    # its outputs makes the model evidence readable directly on GitHub.
    nbformat.write(executed, SOURCE)
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(executed, DESTINATION)
    print(DESTINATION)


if __name__ == "__main__":
    main()
