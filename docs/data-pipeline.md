# Data pipeline

Preparation is an offline build step. The browser consumes only validated files under `public/data`.

## Heat vulnerability and Statbel sectors

Use explicit local sources:

```powershell
pnpm data:prepare -- `
  --scores "C:\data\Cijfers_hittekwetsbaarheid_2026.xlsx" `
  --sectors "C:\data\sh_statbel_statistical_sectors_3812_20240101.geojson.zip"
```

Without arguments, the command downloads its pinned official sources. It requires 154 exact identifier joins and preserves every geometry vertex during EPSG:3812 to WGS84 conversion.

Outputs: `sectors.geojson`, `scores.json`, `methodology.json` and `provenance.json`.

## LCM-10 2020

For a new official download:

```powershell
$env:CDSE_ACCESS_TOKEN = $tokenResult.access_token
try {
  pnpm landcover:prepare
} finally {
  Remove-Item Env:CDSE_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
```

Reuse a verified cached source:

```powershell
pnpm landcover:prepare -- --cog "C:\data\official-lcm-product.zip"
```

The command verifies source identity and checksum, clips to the sector union and writes `land-cover/land-cover-2020.png` plus `land-cover.json`.

## Urban Atlas 2021

```powershell
$env:CDSE_ACCESS_TOKEN = $tokenResult.access_token
try {
  pnpm urban-atlas:prepare
} finally {
  Remove-Item Env:CDSE_ACCESS_TOKEN -ErrorAction SilentlyContinue
}
```

Reuse a verified source after the short-lived token expires:

```powershell
pnpm urban-atlas:prepare -- --source "C:\data\CLMS_UA_LCU_S2021_BE001L3"
```

The command verifies the official product variant, EPSG:3035, FUA, reference year and official WMS class style. Area calculations remain in the equal-area CRS; only browser fragments are reprojected to WGS84.

Outputs: `urban-atlas.geojson` and `urban-atlas.json`.

## Contracts and provenance

- Every JSON manifest declares `schemaVersion`.
- Every sector statistic is keyed by the Statbel identifier.
- Preparation fails on incompatible source identity, geometry, class or coverage.
- Provenance records source URLs, names, hashes, dates and processing counts, but never credentials or full local paths.
- `pnpm data:validate` checks all committed browser assets without source downloads or tokens.

Run `pnpm test` after modifying functions in `scripts/lib`. Run `pnpm verify` after regenerating committed assets.

Do not commit raw workbooks, archives, COGs, FlatGeobuf files, `.env` files or CDSE tokens.
