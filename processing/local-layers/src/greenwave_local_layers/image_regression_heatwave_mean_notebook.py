"""Execute the tracked heatwave-mean report notebook into its model cache."""

import nbformat
from nbclient import NotebookClient

from .constants import PROJECT_ROOT
from .image_regression_heatwave_mean_xgboost import ARTIFACTS


SOURCE = PROJECT_ROOT / "playground" / "landsat_image_regression_xgboost_heatwave_mean.ipynb"
DESTINATION = ARTIFACTS.root / "landsat_image_regression_xgboost_heatwave_mean_executed.ipynb"


def main():
    notebook = nbformat.read(SOURCE, as_version=4)
    executed = NotebookClient(
        notebook,
        timeout=None,
        kernel_name="python3",
        resources={"metadata": {"path": str(PROJECT_ROOT)}},
    ).execute()
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(executed, DESTINATION)
    print(DESTINATION)


if __name__ == "__main__":
    main()

