# Python data preparation

This package turns official geospatial sources into validated analytical
products. It is the main entry point for data-science contributions.

## Data lifecycle

```text
official source
  -> validate year, CRS, grid, classes and nodata
  -> align or clip on the documented analysis grid
  -> calculate masks, exact areas, densities or statistics
  -> write private analytical files below .cache/local-layers
  -> publish only allow-listed browser derivatives
  -> load manifests in the browser and display prepared values
```

The browser filters prepared records by region, municipality or sector. It
does not recompute official heat scores or rebuild geospatial analyses.

## Setup and discovery

```powershell
pnpm local-data:setup
processing\local-layers\.venv\Scripts\greenwave-local-layers.exe --list
processing\local-layers\.venv\Scripts\greenwave-local-layers.exe --describe landsat-temperature
```

`--list` is the authoritative command inventory. `--describe` reports a
product's upstream dependencies, source-override policy, cache root and whether
it can be published.

Prepare one product with `--dataset ID`, or use the named `pnpm` shortcuts in
`package.json`. Typical sequences are:

```powershell
pnpm landsat-heat:prepare
pnpm sealed-urban:prepare
pnpm official-layers:publish
pnpm dev:local-data
```

The 2026 scenario model has two deliberate commands:

```powershell
pnpm lst-scenario:xgboost-optuna   # train/select the active model
pnpm lst-scenario:xgboost-notebook # execute a cache copy of the public report
```

The notebook command never modifies the reviewed source notebook.

## Package map

| Area | Responsibility |
| --- | --- |
| `dataset_registry.py`, `cli.py` | Discover and dispatch preparation products |
| `pipeline.py`, `landgebruik.py`, `landsat.py` | Base raster/vector products |
| `*_population.py`, `landsat_*.py`, `sealed_urban_comparisons.py` | Prepared comparisons |
| `spatial_inference.py`, `regression_metrics.py` | Statistical contracts |
| `image_regression.py`, `image_regression_optuna.py` | XGBoost catalogue, features, folds and selection |
| `prediction_smoothing.py`, `image_regression_xgboost_pipeline.py` | Production smoothing and verified artifacts |
| `scenario_land_cover.py`, `lst_scenario.py` | Shared cover state and local scenario service |

## Scientific rules

- EPSG:31370 retains the native 1 m Flemish land-cover grid.
- EPSG:32631 is the common aligned 30 m Landsat analysis grid.
- EPSG:3035 is used for equal-area Urban Atlas and population calculations.
- EPSG:3857 derivatives are display products, not analysis inputs.
- Area-weighted comparisons retain the exact contributing surface; a 30 m
  Landsat value may therefore contribute proportionally to several classes.
- Spatial validation groups sectors and applies the documented 200 m embargo.
- Presentation opacity/point size never acts as a statistical weight.

See [the data reference](../../docs/data-reference.md) for product-specific
years, masks, aggregation and display behavior.

## Testing

```powershell
pnpm local-data:test
pnpm data:validate
pnpm test:local-data
```

Tests should exercise a small array or fixture and the failure case: grid
mismatch, nodata, missing support, hash mismatch or an unavailable optional
model. Never add raw official archives or credentials to a fixture.
