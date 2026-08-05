# Greenwave

Greenwave is a bilingual static map for the 154 Statbel sectors in the Zennevallei Primary Care Zone. It combines official heat-vulnerability scores from the Government of Flanders with Statbel boundaries, Copernicus LCM-10, Copernicus Urban Atlas, a Sentinel-2 vegetation indication and an OpenStreetMap background.

The application uses vanilla JavaScript, Vite and MapLibre GL JS. It has no backend, accounts, cookies, browser storage, analytics or live score calculation.

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
```

Prepared assets are committed under `public/data`, so a clone can build and run without the source workbooks or CDSE credentials. Internet access is needed only for the configured basemap tiles.

## Data preparation

```powershell
pnpm data:prepare -- --scores "C:\path\Cijfers_hittekwetsbaarheid_2026.xlsx" --sectors "C:\path\statbel-sectors.zip"
pnpm landcover:prepare
pnpm urban-atlas:prepare -- --source "C:\path\official-urban-atlas-product"
pnpm vegetation:download -- --date 2023-06-24
pnpm vegetation:prepare -- --date 2023-06-24
```

LCM-10 and Urban Atlas downloads read `CDSE_ACCESS_TOKEN` only during preparation. Sentinel Hub uses temporary `CDSE_SH_CLIENT_ID` and `CDSE_SH_CLIENT_SECRET` environment variables. Never place credentials in `.env`, source code, generated manifests or documentation.

See [Data pipeline](docs/data-pipeline.md) for complete examples and validation rules.

## Project guides

- [Architecture](docs/architecture.md): responsibilities and data flow.
- [Add a layer](docs/add-a-layer.md): a complete layer-module example.
- [Data pipeline](docs/data-pipeline.md): inputs, commands, caching and outputs.
- [Deployment](docs/deployment.md): LAN operation and public-host checklist.
- [Contributing](CONTRIBUTING.md): conventions and required checks.
- [Third-party data](THIRD_PARTY_DATA.md): source terms and attribution.

## Public deployment status

The `dist` output is suitable for a static host, including deployment below a URL subpath. The repository deliberately contains no host-specific workflow yet. Before public launch:

- select a managed or self-hosted OSM-derived tile provider;
- configure the documented security headers and compression;
- confirm that the host or CDN does not add tracking or cookies;
- complete the third-party-data publication gate in `THIRD_PARTY_DATA.md`.

Vite preview is used only for development and trusted local-network access. It is not the public production server.

## Licence

Greenwave source code is licensed under Apache 2.0. This licence does not apply to upstream or derived data assets. Their separate terms and required acknowledgements are documented in [THIRD_PARTY_DATA.md](THIRD_PARTY_DATA.md).
