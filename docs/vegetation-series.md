# Likely vegetation series

This layer answers one narrow question: where did a Sentinel-2 observation show a vegetation-like NDVI signal? It is an indication, not a land-cover inventory and not a confirmed change map.

## Rebuild the series

Create a Sentinel Hub OAuth client, set `CDSE_SH_CLIENT_ID` and `CDSE_SH_CLIENT_SECRET` only for these commands, then run:

```powershell
pnpm vegetation:discover -- --from-year 2015 --to-year 2026
pnpm vegetation:download -- --all
pnpm vegetation:prepare
pnpm data:validate
pnpm test
```

The raw GeoTIFFs and selection report stay under `.cache/vegetation`. Only browser-ready PNG files and `vegetation.json` are committed.

## 1. Annual observation selection

The target date is 24 June. The catalogue search covers June and July, except for 2015 because the Sentinel-2 L2A archive starts in July. A candidate date must contain products for tiles T31UFS and T31UES.

For each candidate, the Statistical API measures source coverage over the union of the 154 Statbel sectors, cloud-affected pixels, mean cloud probability and distance from 24 June. The cloud mask includes cloud shadow, unclassified cloud, medium and high cloud probability, cirrus and snow.

The selector prefers complete coverage and no more than 2% cloud-affected pixels close to the target date. If no observation meets those conditions, it selects the best available candidate and records a warning. The complete candidate evidence is retained in `selection.json`.

## 2. NDVI and observation mask

The Process API requests Sentinel-2 L2A bottom-of-atmosphere reflectance at 10 m in EPSG:32631. NDVI is calculated as:

```text
(B08 near infrared - B04 red) / (B08 near infrared + B04 red)
```

No-data, saturated, cloud-shadow, unclassified cloud, cloud, cirrus and snow pixels are invalid. Invalid pixels are transparent and their area is reported separately.

## 3. Frozen threshold

The threshold is calibrated once with the 2023 observation. Urban Atlas 2021 supplies the reference polygons.

Positive reference classes are public, private and unknown-access green urban areas, pastures, forests and herbaceous vegetation. Negative reference classes are continuous urban fabric and fast transit roads. A 10 m pixel is accepted as a reference only when at least eight of nine subpixel samples belong to the same reference class.

The threshold maximises Youden's J statistic, which balances sensitivity and specificity. The 2023 threshold is applied unchanged to every year. This avoids artificial changes caused by recalibrating each year. The manifest records the distributions, sensitivity, specificity, balanced accuracy and ROC AUC.

## 4. Exclusions and percentage

A valid pixel is likely vegetated when its NDVI is at or above the frozen threshold. Two categories are excluded from display:

- LCM-10 2020 class 40, Cropland;
- Urban Atlas 2021 class 50000, Water.

Urban Atlas class 21000, Arable land, is deliberately not the crop mask. The crop definition comes from LCM-10 2020.

The headline denominator is the complete valid Sentinel-2 area inside the selected sector or municipality. Cropland and water stay in that denominator even though they are transparent. This prevents an inflated vegetation percentage.

## 5. Browser assets and aggregation

Each year contains a full Zennevallei raster and seven transparent municipality variants. MapLibre swaps the local image when the municipality filter changes, so only the chosen municipality remains visible over OSM.

Sector metrics use the projected 10 m grid. Municipality metrics sum the underlying sector areas and recompute percentages from those totals. Selecting a sector replaces the municipality summary until the sector panel is closed.

## Interpretation limits

- A single date can reflect mowing, drought, crop stage, shadows and atmospheric effects.
- The fixed 2020 and 2021 masks do not follow later land-cover changes.
- Older years can have less complete coverage or more cloud. The UI and manifest retain the quality status.
- The layer does not identify vegetation type, ownership, public access or physical land-cover change.
- A future difference view should compare aligned annual classifications and retain the frozen threshold. It is intentionally not implemented yet.
