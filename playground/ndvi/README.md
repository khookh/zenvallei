# Standalone Sentinel-2 NDVI playground

This is a Python-only research workspace for VS Code. It downloads raw Copernicus Sentinel-2 L2A bands, calculates NDVI locally, uses GeoPandas for spatial work and can export an experimental raster to the local map. Notebook users do not need to understand the web application or its JSON files.

## Prepare VS Code

Run these standard Python commands once from the repository root:

```powershell
py -3.11 -m venv playground/ndvi/.venv
playground/ndvi/.venv/Scripts/python.exe -m pip install -e "playground/ndvi[dev]"
```

Dependencies and their exact versions are declared in `pyproject.toml`; no project launcher is required.

Then open this repository in VS Code, open `playground/ndvi/01_halle_ndvi_2020_2021.ipynb`, select `playground/ndvi/.venv/Scripts/python.exe` as the notebook kernel and run the cells. The notebook downloads or reuses 2020 and 2021 data, calculates NDVI and displays both Halle rasters with the same scale.

## Copernicus credentials

The first raw download needs a Sentinel Hub OAuth client. Either set temporary environment variables before opening VS Code:

```powershell
$env:CDSE_SH_CLIENT_ID = "your-client-id"
$secureSecret = Read-Host "Sentinel Hub OAuth client secret" -AsSecureString
$env:CDSE_SH_CLIENT_SECRET = [System.Net.NetworkCredential]::new("", $secureSecret).Password
```

Raw GeoTIFFs are cached under `.cache/vegetation/raw`, so later runs do not need credentials.

Remove the temporary credentials after downloading:

```powershell
Remove-Item Env:CDSE_SH_CLIENT_ID, Env:CDSE_SH_CLIENT_SECRET -ErrorAction SilentlyContinue
```

## Python API

```python
from greenwave_ndvi import (
    download_raw_observation, open_raw_observation, compute_ndvi,
    municipality_bounds, crop_to_bounds, export_continuous_layer,
)

path = download_raw_observation(2021)
raw = open_raw_observation(path)
ndvi = compute_ndvi(raw)
halle = crop_to_bounds(ndvi, municipality_bounds("Halle", padding_m=1000))
export_continuous_layer(halle, title="My NDVI test", units="NDVI")
```

The public helpers return ordinary `Path`, GeoPandas, Xarray and Matplotlib-compatible objects. Internal source-selection and export manifests are handled by the package.

## Show an export on the local map

After running an export cell in the notebook:

```powershell
pnpm dev:playground-map
```

Open `http://127.0.0.1:4173/` and choose **Test** under **Land use and green cover**. This mode serves only the generated manifest and PNG files. Raw Sentinel bands and notebook outputs are ignored and never enter the GitHub Pages build.

Use ordinary `pnpm dev` when you want the same four layers as the public site. The Test layer appears only with `pnpm dev:playground-map` and only after a valid notebook export exists.

## Verify

```powershell
playground/ndvi/.venv/Scripts/python.exe -m pytest playground/ndvi/tests
```

Notebook 01 performs the complete 2020/2021 Halle comparison. Notebook 02 prepares annual time-series arrays for future one-class classification experiments without selecting a model.
