# Data pipeline

Preparation is offline. The browser consumes validated public derivatives or ignored local PMTiles, never credentials or signed source URLs.

## Public layers

Prepare heat scores and Statbel geometry from explicit files:

```powershell
pnpm data:prepare -- `
  --scores "C:\data\scores.xlsx" `
  --sectors "C:\data\statbel-sectors.zip"
```

Prepare the public Statbel fiscal-income derivative from the official download:

```powershell
pnpm income:prepare
# or reuse a verified ZIP/TXT download
pnpm income:prepare -- --source "C:\data\TF_PSNL_INC_TAX_SECTOR.zip"
```

The command joins by sector identifier, keeps 2019-2023 source indicators and records unavailable medians as `null`. It never derives municipality medians or a synthetic income distribution.

Prepare the two population-density views:

```powershell
pnpm population:prepare
# or reuse all four verified official downloads
pnpm population:prepare -- --grid "C:\data\population-grid-2025.zip" `
  --sectors-2025 "C:\data\sectors-2025-old.xlsx" `
  --sectors-2019 "C:\data\sectors-2019.xlsx" `
  --flanders-2019 "C:\data\population-density-2019.zip"
```

This keeps the methods separate. The 2025 GeoJSON is a privacy-protected density display; exact selected-area totals come from the compatible Statbel sector table. The 2019 map preserves the official Government of Flanders 100 m model, while its panels use matching Statbel 2019 totals. Source downloads remain in `.cache/population`.

The command requires 154 exact identifier joins and preserves every geometry vertex during EPSG:3812 to WGS84 conversion. Outputs are `sectors.geojson`, `scores.json`, `methodology.json` and `provenance.json`.

Prepare Urban Atlas from a verified official source:

```powershell
pnpm urban-atlas:prepare -- --source "C:\data\CLMS_UA_LCU_S2021_BE001L3"
```

This validates the product, EPSG:3035, FUA, year and class style. Equal-area intersections produce `urban-atlas.geojson` and `urban-atlas.json`.

## Prepared official layers

```powershell
pnpm local-data:setup
pnpm local-data:prepare -- --dataset jaarbak
pnpm local-data:prepare -- --dataset groenkaart
pnpm landgebruik:prepare
pnpm landsat-heat:prepare
pnpm landsat-urban-atlas:prepare
pnpm landsat-soil-sealing:prepare
pnpm sealed-urban:prepare
pnpm green-population:prepare
pnpm landsat-population:prepare
pnpm lst-scenario:prepare
pnpm official-layers:publish
```

JaarBAK, Groenkaart and Landgebruik accept a cached source with `--source YEAR=C:\path\source.tif`. Native grids produce statistics; lossless Web Mercator PMTiles are visual derivatives only. JaarBAK and Groenkaart additionally create 100 m focal-density GeoTIFFs from padded native source windows. Green Map × population and Landsat × population reuse the 2019 100 m Government of Flanders model and generate no new download. Landgebruik downloads bounded AGPA 2025 parcels from the official OGC API. Landsat uses public Planetary Computer STAC discovery and caches aligned source windows. All comparison preparations reuse these validated caches. `official-layers:publish` is the only supported route from the private cache to the static browser assets. See [Official raster layers](local-official-layers.md), [Landgebruik Vlaanderen](landgebruik-vlaanderen.md) and [Landsat surface temperature](landsat-surface-temperature.md).

## Python research playground

`lst-scenario:xgboost-optuna` builds the optional 22 June 2026 all-clear-cell catalogue from one mutually exclusive upper surface. Its analytical water channel is the union of Urban Atlas 2021 water and Flanders Land Use 2025 class 17, with water taking absolute priority over the other channels. It extracts five explicit cover fractions across candidate radial rings and performs five-fold sector-held-out tuning, feature selection and fold-safe Gaussian prediction smoothing with a 200 m embargo. The command caches the contract-5 booster, feature artifact and baseline inference grid. `lst-scenario:xgboost-notebook` executes the public step-by-step report. `lst-scenario:prepare` advertises XGBoost only when the model, feature, catalogue and grid hashes reconcile; otherwise the live tool falls back to Radoux. Session calculations remain under `.cache`, and distribution checks reject the endpoint, model and runtime assets. See [Land-cover change tool](land-cover-lst-scenario.md).

`lst-scenario:xgboost-heatwave-mean` remains an offline research command for a strict six-date complete-case target below `.cache/local-layers/image-regression/xgboost-heatwave-mean-2020-2026/`. It is not registered or calculated in the live land-cover change tool. Its old artifacts are invalid under contract 5 until that separate research model is retrained. `lst-scenario:xgboost-heatwave-mean-notebook` remains its standalone report command.

The VS Code playground downloads Sentinel-2 bands and calculates NDVI independently from the application:

```powershell
py -3.11 -m venv playground/ndvi/.venv
playground/ndvi/.venv/Scripts/python.exe -m pip install -e "playground/ndvi[dev]"
playground/ndvi/.venv/Scripts/python.exe -m pytest playground/ndvi/tests
```

Experimental exports below `.cache/playground/web` are available only through `pnpm dev:playground-map` and are rejected from production builds.

## Contracts and provenance

- Every manifest declares a `schemaVersion`.
- Sector statistics use Statbel identifiers; municipality geometry is dissolved from the same sectors.
- Preparation fails on incompatible identity, CRS, values, geometry or coverage.
- Provenance records stable source identifiers, hashes, dates and processing decisions, never credentials or expiring URLs.
- `pnpm data:validate` validates committed public data without source downloads.

Do not commit workbooks, source archives, analytical rasters, PMTiles, `.env` files or access tokens.
