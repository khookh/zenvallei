# Greenwave

Greenwave is a bilingual map of heat, land cover and social conditions in the
154 Statbel sectors of the Zennevallei Primary Care Zone. It combines official
Belgian and Flemish products with six clear-sky Landsat surface-temperature
observations. The public application is static; the land-cover change tool runs
only in local-data mode.

Public site: <https://khookh.github.io/zenvallei/>

## Run the map

Requirements: Node.js 24 and pnpm 11.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:4173/>. Use `pnpm dev:local-data` after preparing the
Python layers when testing the local scenario tool.

## Verify a change

```powershell
pnpm verify:quick       # lint, types, unit tests, data validation and build
pnpm local-data:test    # Python processing and scientific-contract tests
pnpm test:local-data    # browser tests with prepared local products
pnpm verify             # complete release check
```

## Where to start

- Data scientists: [Python preparation guide](processing/local-layers/README.md)
- Data provenance and transformations: [Data reference](docs/data-reference.md)
- Frontend integration: [Browser application structure](src/README.md)
- Contribution rules: [Contributing](CONTRIBUTING.md)
- Local scenario: [Land-cover change tool](docs/land-cover-lst-scenario.md)
- Publishing: [Deployment](docs/deployment.md)
- Upstream terms: [Third-party data](THIRD_PARTY_DATA.md)

The three retained notebooks and their status are listed in the
[playground guide](playground/README.md). Raw downloads, credentials and
analytical caches are never published.

## Licence

The source code uses the MIT licence. Upstream data and derived assets retain
their own terms and acknowledgements.
