# Research notebooks

Only notebooks with a distinct, current purpose are retained.

| Notebook | Status |
| --- | --- |
| `xgboost_2026_heatwave_regression_zennevallei.ipynb` | Reviewed production evidence for the local 2026 Heatwave XGBoost method. Do not rewrite or execute in place. |
| `ndvi/01_halle_ndvi_2020_2021.ipynb` | Supported Python-only Sentinel-2/NDVI contribution tutorial. |
| `ecostress_zennevallei_2026.ipynb` | Dated, network-dependent research experiment; not used by the live application. |

The XGBoost runner writes an executed copy below the ignored model cache. The
NDVI setup is documented in [its local guide](ndvi/README.md).

For ECOSTRESS, install the pinned optional dependency and authenticate with the
standard NASA Earthdata mechanism (`.netrc`, environment or interactive login):

```powershell
processing\local-layers\.venv\Scripts\python.exe -m pip install -e "processing/local-layers[ecostress]"
```

Notebook outputs are explanatory evidence. Reusable processing and validation
must live in tested Python modules.
