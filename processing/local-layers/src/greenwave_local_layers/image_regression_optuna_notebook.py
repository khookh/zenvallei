"""Execute the tracked Optuna report notebook into the untracked cache."""

from pathlib import Path

import nbformat
from nbclient import NotebookClient

from .constants import PROJECT_ROOT
from .image_regression_optuna import OPTUNA_ROOT


SOURCE = PROJECT_ROOT / "playground" / "landsat_image_regression_xgboost_optuna.ipynb"
DESTINATION = OPTUNA_ROOT / "xgboost-optuna-2026-executed.ipynb"


def main():
    notebook = nbformat.read(SOURCE, as_version=4)
    executed = NotebookClient(
        notebook, timeout=None, kernel_name="python3", resources={"metadata": {"path": str(PROJECT_ROOT)}},
    ).execute()
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(executed, DESTINATION)
    print(DESTINATION)


if __name__ == "__main__":
    main()
