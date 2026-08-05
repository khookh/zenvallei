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

## Sentinel-2 likely vegetation 2023

Create a non-SPA OAuth client in the Copernicus Sentinel Hub account settings. Supply its values only for the download process:

```powershell
$env:CDSE_SH_CLIENT_ID = Read-Host "Sentinel Hub OAuth client ID"
$secureSecret = Read-Host "Sentinel Hub OAuth client secret" -AsSecureString
$env:CDSE_SH_CLIENT_SECRET = [System.Net.NetworkCredential]::new("", $secureSecret).Password
try {
  pnpm vegetation:download -- --date 2023-06-24
} finally {
  Remove-Item Env:CDSE_SH_CLIENT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CDSE_SH_CLIENT_SECRET -ErrorAction SilentlyContinue
  Remove-Variable secureSecret -ErrorAction SilentlyContinue
}
```

The download command requests one stitched Sentinel-2 L2A GeoTIFF in EPSG:32631. It contains NDVI and a validity band at 10 m. The cache is accepted only when its CRS, resolution, dimensions, bands, NDVI range and valid-pixel coverage pass validation.

Create the browser asset and sector statistics from the verified cache:

```powershell
pnpm vegetation:prepare -- --date 2023-06-24
```

The preparation command rasterises Urban Atlas on a 3 × 3 subpixel grid. Calibration pixels require at least eight of nine samples in one reference class. The threshold maximises Youden's J statistic. Urban Atlas arable land and water remain in the sector denominator but are transparent in the output image.

Outputs: `vegetation/likely-vegetation-2023.png` and `vegetation.json`. Raw GeoTIFFs and OAuth credentials remain outside the browser assets and repository.

## Contracts and provenance

- Every JSON manifest declares `schemaVersion`.
- Every sector statistic is keyed by the Statbel identifier.
- Preparation fails on incompatible source identity, geometry, class or coverage.
- Provenance records source URLs, names, hashes, dates and processing counts, but never credentials or full local paths.
- `pnpm data:validate` checks all committed browser assets without source downloads or tokens.

Run `pnpm test` after modifying functions in `scripts/lib`. Run `pnpm verify` after regenerating committed assets.

Do not commit raw workbooks, archives, COGs, FlatGeobuf files, `.env` files or CDSE tokens.
