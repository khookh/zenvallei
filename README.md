# Greenwave

Greenwave is a bilingual static map for the 154 Statbel sectors in the Zennevallei Primary Care Zone. The map combines official heat-vulnerability scores, Landsat surface temperature, Copernicus Urban Atlas, Flemish soil and land-cover products, agricultural parcels, Statbel population density and fiscal income over an OpenStreetMap background.

The interface starts in English. `NL` switches the complete interface to Dutch for the current page. The application has no backend, accounts, cookies, browser storage, analytics or live score calculation.

Public POC: <https://khookh.github.io/zenvallei/>

## Start locally

Requirements: Node.js 24 LTS and pnpm 11.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:4173/>. For the local network, run `Setup Greenwave LAN.cmd` once as administrator, then double-click `Start Greenwave.cmd`. The launcher detects prepared local layers automatically and prints the address for other devices.

## Common checks

```powershell
pnpm test                 # unit and data-logic tests
pnpm local-data:test      # Python processing tests
pnpm test:e2e             # desktop and mobile browser regression
pnpm test:local-data      # deterministic local-layer browser test
pnpm verify:quick         # lint, types, data, tests and build
pnpm verify               # complete local release check
pnpm build:pages          # validate the /zenvallei/ Pages build
```

## Prepare data

Heat scores and Urban Atlas are committed as browser-ready derivatives, so a clone can run without source downloads.

```powershell
pnpm data:prepare -- --scores "C:\path\scores.xlsx" --sectors "C:\path\statbel-sectors.zip"
pnpm urban-atlas:prepare -- --source "C:\path\official-urban-atlas-product"
pnpm income:prepare       # download and validate Statbel income 2019-2023
pnpm population:prepare   # prepare the 2025 grid and separate 2019 model
pnpm brand:prepare
```

Prepare or regenerate the large official raster derivatives locally:

```powershell
pnpm local-data:setup
pnpm local-data:prepare -- --dataset jaarbak
pnpm local-data:prepare -- --dataset groenkaart
pnpm landgebruik:prepare
pnpm landsat-heat:prepare
pnpm landsat-urban-atlas:prepare  # Landsat x Urban Atlas comparison
pnpm landsat-soil-sealing:prepare # Landsat x Soil sealing comparison
pnpm sealed-urban:prepare         # Green, temperature and income in sealed urban fabric
pnpm green-population:prepare     # Green Map x uniform 2019 population model
pnpm landsat-population:prepare  # Landsat x uniform 2019 population model
pnpm lst-scenario:xgboost-optuna  # fresh 50-trial 2026 model selection when required
pnpm lst-scenario:xgboost-notebook # executed 2026 Heatwave XGBoost report
pnpm lst-scenario:prepare       # local-only two-method land-cover ΔLST scenario
pnpm dev:local-data
```

Raw downloads and analytical caches stay below `.cache/local-layers`. To refresh the validated browser derivatives, including all prepared comparisons, run `pnpm official-layers:publish` after preparation. Nine published comparisons can be opened from either participating layer. Green Map and population comparisons distinguish exact 1 m sealed display footprints, 10 m surrounding-cover calculations, 30 m Landsat observations and 100 m population-model cells. See [Official raster layers](docs/local-official-layers.md), [Landgebruik Vlaanderen](docs/landgebruik-vlaanderen.md), [Landsat surface temperature](docs/landsat-surface-temperature.md), [Demography data](docs/demography-data.md) and [privacy-conscious visit monitoring](docs/analytics-monitoring.md).

Soil sealing and Flanders Green Map also provide a **Show density** mode. It calculates the source-class share within a fixed 100 m radius; preparation creates the density derivatives alongside their ordinary classifications.

## Python NDVI playground

The standalone research playground is independent from the map layers:

```powershell
py -3.11 -m venv playground/ndvi/.venv
playground/ndvi/.venv/Scripts/python.exe -m pip install -e "playground/ndvi[dev]"
```

Open `playground/ndvi` in VS Code and select that interpreter as the notebook kernel. It downloads raw Sentinel-2 bands, calculates NDVI in Python and can export an ignored local Test layer. See [the playground guide](playground/ndvi/README.md).

## Guides

- [Architecture](docs/architecture.md)
- [Data inventory](docs/data-inventory.md)
- [Data pipeline](docs/data-pipeline.md)
- [Demography data](docs/demography-data.md)
- [Add a layer](docs/add-a-layer.md)
- [Local official layers](docs/local-official-layers.md)
- [Landsat surface temperature](docs/landsat-surface-temperature.md)
- [Landgebruik Vlaanderen](docs/landgebruik-vlaanderen.md)
- [Land-cover change tool](docs/land-cover-lst-scenario.md)
- [Deployment](docs/deployment.md)
- [Third-party data](THIRD_PARTY_DATA.md)

## Deployment and licence

Pushes to `main` run **Verify application**. Publishing is manual through **Deploy GitHub Pages** after verification is green. See [Deployment](docs/deployment.md).

The source code uses the MIT licence. Upstream and derived data retain their own terms and acknowledgements.
