# Greenwave NDVI playground

This isolated JupyterLab workspace reads the preparation-only Sentinel-2 NDVI GeoTIFFs in `.cache/vegetation`. It does not call Copernicus APIs and never exposes source rasters or credentials to the web application.

## Start

Double-click `Start NDVI Playground.cmd` in the repository root, or run:

```powershell
pnpm playground:ndvi
```

The first launch creates `.cache/ndvi-playground-venv`, installs pinned Python dependencies and opens JupyterLab on `127.0.0.1`. If the raw cache is missing, run the documented `vegetation:discover` and `vegetation:download` commands first.

## Loader examples

```python
from greenwave_ndvi import discover_observations, open_observation, open_stack

inventory = discover_observations()             # 12 selected annual dates
all_cached = discover_observations(False)       # also downloaded alternatives
scene = open_observation(2023)                  # eager y, x dataset
annual = open_stack(chunks=(1, 512, 512))       # lazy time, y, x dataset
```

Values outside the 154-sector union and invalid Sentinel-2 observations are masked. The stack retains acquisition dates, the 10 m EPSG:32631 grid and a validity layer.

Notebook 01 explores observations and time series. Notebook 02 prepares spatially separated arrays for future one-class classification experiments. It deliberately does not choose or train an autoencoder.

## Verify

```powershell
pnpm playground:test
```

Notebook exports belong under `.cache/playground` and must not be committed.
