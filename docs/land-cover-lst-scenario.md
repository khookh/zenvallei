# Land-cover change tool

The tool estimates how a user-drawn land-cover conversion is associated
with daytime land-surface temperature (ΔLST). It is a counterfactual comparison,
not a causal forecast, air-temperature model or heat-exposure model.

## Runtime

The public and local applications use the same module Web Worker. It reads
only the required windows from a tiled, DEFLATE-compressed 1 m state raster.
The XGBoost model and baseline inference grid are loaded lazily on the first
edit. Calculated fields and polygon history remain in memory and are discarded
when the page closes or reloads; no server endpoint, account or browser storage
is used.

## Prepare locally

```powershell
pnpm local-data:setup
pnpm lst-scenario:prepare
pnpm dev:local-data
```

Train or reproduce the optional production model only when its inputs or
contract change:

```powershell
pnpm lst-scenario:xgboost-optuna
pnpm lst-scenario:xgboost-notebook
```

The notebook command executes a cache copy and never modifies
`playground/xgboost_2026_heatwave_regression_zennevallei.ipynb`.

## Shared land-cover state

Green Map 2021, Soil sealing 2024 and water are resolved on the native 1 m
EPSG:31370 grid. Every location has one ground class plus an optional high
canopy; the effective upper surface is mutually exclusive. Water is locked.

The analytical water channel is the union of Urban Atlas 2021 water and
Flanders Land Use 2025 class 17, resampled from 10 m by nearest neighbour.
Flanders water takes priority over sealed, green and agricultural channels. It
is used by modelling and edit locks but is deliberately not added to the visible
map, whose water geometry remains Urban Atlas.

## Estimators

**Radoux** applies the published land-cover coefficients on a 15 m mixture grid
and a normalised Gaussian thermal footprint before sampling the common 30 m
output grid.

**2026 Heatwave XGBoost** predicts Landsat LST from radial fractions of soil
sealing, high green, low green, agriculture and composite water within 100 m.
Training uses the clear 22 June 2026 acquisition, five sector-held-out folds, a
200 m embargo, seeded Optuna selection, a 0.01°C feature-removal tolerance and
fold-safe smoothing. A scenario delta is modified prediction minus that model's
own baseline prediction.

The method is available only when the report, model, retained-feature artifact,
catalogue and baseline inference-grid hashes agree. There is no fallback to an
older model contract; Radoux remains available when XGBoost is absent.

## Results and limitations

The worker returns accepted edit area, before/change/after composition,
method-specific delta rasters, strongest cooling/warming, a complete affected-
centre distribution and outside-training-range diagnostics. The public session
accepts at most 100 polygons, 10,000 vertices and 200 ha of submitted area.

Predictor years differ from the Landsat target year. The model captures spatial
association within its training domain and may omit building form, materials,
moisture, weather and other temperature drivers. Displayed deltas must not be
interpreted as guaranteed intervention effects.

See the [data reference](data-reference.md) and the protected
[training notebook](../playground/xgboost_2026_heatwave_regression_zennevallei.ipynb).
