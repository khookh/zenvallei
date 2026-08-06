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

The command verifies source identity and checksum, clips to the sector union and writes `land-cover/land-cover-2020.png` plus `land-cover.json`. Then create the seven municipality-specific raster variants:

```powershell
pnpm landcover:variants
```

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

## Sentinel-2 likely vegetation 2020

Create a non-SPA OAuth client in the Copernicus Sentinel Hub account settings. Supply its values only for the download process:

```powershell
$env:CDSE_SH_CLIENT_ID = Read-Host "Sentinel Hub OAuth client ID"
$secureSecret = Read-Host "Sentinel Hub OAuth client secret" -AsSecureString
$env:CDSE_SH_CLIENT_SECRET = [System.Net.NetworkCredential]::new("", $secureSecret).Password
try {
  pnpm vegetation:discover -- --from-year 2015 --to-year 2026
  pnpm vegetation:download -- --all
} finally {
  Remove-Item Env:CDSE_SH_CLIENT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CDSE_SH_CLIENT_SECRET -ErrorAction SilentlyContinue
  Remove-Variable secureSecret -ErrorAction SilentlyContinue
}
```

The discovery command requires both Sentinel tiles and measures cloud and coverage over the actual Zennevallei sector union. It writes the deterministic choice and alternatives to `.cache/vegetation/selection.json`. Weak observations are recorded as warnings.

The download command requests one stitched Sentinel-2 L2A GeoTIFF per selected year in EPSG:32631. Each file contains NDVI and a validity band at 10 m. The cache is accepted only when its CRS, resolution, dimensions, bands, NDVI range and valid-pixel coverage pass validation. These cached years remain available to the Python playground; the browser layer currently publishes only 2020.

Create the browser asset and sector statistics from the verified cache:

```powershell
pnpm vegetation:prepare
```

The preparation command selects the cached 2020 observation and rasterises Urban Atlas on a 3 x 3 subpixel grid. Calibration pixels require at least eight of nine samples in one reference class. The threshold maximises Youden's J statistic using the Urban Atlas reference classes.

Pixels classified as Cropland, code 40, in LCM-10 2020 are transparent unless Urban Atlas 2021 classifies them as Pastures, code 23000. LCM-10 Grassland, code 30, is transparent where Urban Atlas identifies Arable land, code 21000. Urban Atlas water is also transparent and takes precedence over the agricultural rules. The headline percentage uses the complete Statbel sector or municipality area. Excluded agriculture, water and missing observations are therefore not vegetation, but remain part of that denominator.

Outputs: one full PNG and seven municipality variants for 2020, plus `vegetation.json`. Raw GeoTIFFs for all cached research years and OAuth credentials remain outside the browser assets and repository. See [Likely vegetation 2020](vegetation-series.md) for the complete method.

The browser PNGs colour only pixels classified as likely vegetated. Below-threshold pixels, agricultural exclusions, water, missing observations and areas outside the selected Statbel sectors are transparent. Their areas remain available in `vegetation.json` and the result panel.

To inspect the cached GeoTIFFs directly in Python without changing the website:

```powershell
pnpm playground:ndvi
pnpm playground:test
```

See the [NDVI playground guide](../playground/ndvi/README.md).

## Contracts and provenance

- Every JSON manifest declares `schemaVersion`.
- Every sector statistic is keyed by the Statbel identifier.
- Preparation fails on incompatible source identity, geometry, class or coverage.
- Provenance records source URLs, names, hashes, dates and processing counts, but never credentials or full local paths.
- `pnpm data:validate` checks all committed browser assets without source downloads or tokens.

Run `pnpm test` after modifying functions in `scripts/lib`. Run `pnpm verify` after regenerating committed assets.

Do not commit raw workbooks, archives, COGs, FlatGeobuf files, `.env` files or CDSE tokens.
