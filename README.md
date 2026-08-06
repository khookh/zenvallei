# Greenwave

Greenwave is a bilingual static map for the 154 Statbel sectors in the Zennevallei Primary Care Zone. It combines official heat-vulnerability scores from the Government of Flanders with Statbel boundaries, Copernicus LCM-10, Copernicus Urban Atlas, Sentinel-2 NDVI vegetation and an OpenStreetMap background.

The interface starts in English. The `NL` button switches the complete interface to Dutch for the current page only.

The application uses vanilla JavaScript, Vite and MapLibre GL JS. It has no backend, accounts, cookies, browser storage, analytics or live score calculation.

Public POC: <https://khookh.github.io/zenvallei/>

## Start on this computer

Requirements: Node.js 24 LTS and pnpm 11.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:4173/>.

## Start for the local network

1. Double-click `Setup Greenwave LAN.cmd` once and approve the Windows prompt.
2. Double-click `Start Greenwave.cmd` whenever Greenwave is needed.
3. Open the printed `http://<current-ip>:4173/` address on another device.
4. Close the launcher window or press Ctrl+C to stop the server.

The same workflow is available as `pnpm lan`. The launcher builds the production bundle, binds only while its window is open and prints the current IP on every start.

## Common commands

```powershell
pnpm test                 # unit and data-logic tests
pnpm test:e2e             # desktop and mobile browser regression
pnpm test:lan             # Windows LAN listener and HTTP integration
pnpm verify:quick         # lint, types, data, tests, build and bundle checks
pnpm verify               # complete local release check
pnpm security:check       # dependency, secret and local-path scan
pnpm data:validate        # validate all committed browser-ready data
pnpm build                # write the static website to dist/
pnpm build:pages          # build and validate the /zenvallei/ Pages site
pnpm test:pages           # browser smoke test at the real Pages path
```

Prepared assets are committed under `public/data`, so a clone can build and run without the source workbooks or CDSE credentials. Internet access is needed only for the configured basemap tiles.

## Data preparation

```powershell
pnpm data:prepare -- --scores "C:\path\Cijfers_hittekwetsbaarheid_2026.xlsx" --sectors "C:\path\statbel-sectors.zip"
pnpm landcover:prepare
pnpm landcover:variants
pnpm urban-atlas:prepare -- --source "C:\path\official-urban-atlas-product"
pnpm vegetation:discover -- --from-year 2015 --to-year 2026
pnpm vegetation:download -- --all
pnpm vegetation:prepare
pnpm brand:prepare
```

LCM-10 and Urban Atlas downloads read `CDSE_ACCESS_TOKEN` only during preparation. Sentinel Hub uses temporary `CDSE_SH_CLIENT_ID` and `CDSE_SH_CLIENT_SECRET` environment variables. Never place credentials in `.env`, source code, generated manifests or documentation.

See [Data pipeline](docs/data-pipeline.md) for complete examples and validation rules.

## NDVI playground

Open `playground/ndvi` in VS Code and create its standard Python environment once:

```powershell
py -3.11 -m venv playground/ndvi/.venv
playground/ndvi/.venv/Scripts/python.exe -m pip install -e "playground/ndvi[dev]"
```

Select that interpreter as the notebook kernel. The playground downloads raw B04, B08, SCL and data-mask bands, calculates NDVI in Python and can export an ignored local Test layer. `pnpm dev:playground-map` displays the latest export as Test. Raw files and experiments are never published; the public application still contains only NDVI vegetation for 2020. See [NDVI playground](playground/ndvi/README.md) for the VS Code workflow and copyable examples.

## Project guides

- [Architecture](docs/architecture.md): responsibilities and data flow.
- [Add a layer](docs/add-a-layer.md): a complete layer-module example.
- [Data pipeline](docs/data-pipeline.md): inputs, commands, caching and outputs.
- [Data inventory](docs/data-inventory.md): sources, scripts, generated assets and Greenwave metrics.
- [NDVI vegetation 2020](docs/vegetation-series.md): observation selection, NDVI calibration, masks and limitations.
- [NDVI playground](playground/ndvi/README.md): lazy annual stacks and model-ready exports.
- [Deployment](docs/deployment.md): LAN operation and public-host checklist.
- [Contributing](CONTRIBUTING.md): conventions and required checks.
- [Third-party data](THIRD_PARTY_DATA.md): source terms and attribution.

## Public deployment

Changes on `main` are checked automatically by **Verify application**. Publishing to <https://khookh.github.io/zenvallei/> is deliberately manual: run **Deploy GitHub Pages** once after verification is green. The deployment repeats all checks and confirms the exact live commit through `release.json`. See the [deployment guide](docs/deployment.md) for the short procedure and failure meanings.

The standard OpenStreetMap tile service is retained for this modest non-commercial POC. It must be replaced through the existing environment configuration before meaningful public traffic.

GitHub Pages cannot apply the complete response-header policy used by local preview. A build-time CSP and referrer policy protect the Pages POC; the remaining headers are documented for the next hosting provider. Vite preview remains limited to development and trusted local-network access.

## Licence

Greenwave source code is licensed under the MIT licence. This licence does not apply to upstream or derived data assets. Their separate terms and required acknowledgements are documented in [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md).
