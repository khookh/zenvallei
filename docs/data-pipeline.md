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
pnpm landsat-urban-atlas:prepare
pnpm landsat-soil-sealing:prepare
pnpm official-layers:publish
pnpm landgebruik:prepare
pnpm landsat-heat:prepare
```

JaarBAK, Groenkaart and Landgebruik accept a cached source with `--source YEAR=C:\path\source.tif`. Native grids produce statistics; lossless Web Mercator PMTiles are visual derivatives only. JaarBAK and Groenkaart additionally create 100 m focal-density GeoTIFFs from padded native source windows. Landgebruik downloads bounded AGPA 2025 parcels from the official OGC API. Landsat uses public Planetary Computer STAC discovery and caches aligned source windows. The two comparison preparations reuse these validated caches and do not download data. `official-layers:publish` is the only supported route from the private cache to the static browser assets. See [Official raster layers](local-official-layers.md), [Landgebruik Vlaanderen](landgebruik-vlaanderen.md) and [Landsat surface temperature](landsat-surface-temperature.md).

## Python research playground

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
