# NDVI vegetation 2020

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

The raw GeoTIFFs and selection report for 2015 through 2026 stay under `.cache/vegetation` for research in the Python playground. The public map currently publishes only the selected 2020 observation: eight browser-ready PNG files and `vegetation.json`. The PNG files contain green likely-vegetation pixels and transparency only; the full area accounting remains in the JSON statistics.

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

## 3. Threshold calibration

Urban Atlas 2021 supplies the reference polygons for the 2020 observation.

Positive reference classes are public, private and unknown-access green urban areas, pastures, forests and herbaceous vegetation. Negative reference classes are continuous urban fabric and fast transit roads. A 10 m pixel is accepted as a reference only when at least eight of nine subpixel samples belong to the same reference class.

For the selected 2020 Sentinel-2 observation, the threshold that maximises Youden's J statistic is calculated. This balances sensitivity and specificity for the acquisition. The manifest records the threshold, distributions, sensitivity, specificity, balanced accuracy and ROC AUC. If more observations are published later, each will be calibrated independently.

## 4. Exclusions and percentage

A valid pixel is likely vegetated when its NDVI is at or above the 2020 observation threshold. Three categories are excluded from display:

- LCM-10 2020 class 40, Cropland, except where Urban Atlas 2021 identifies class 23000, Pastures;
- LCM-10 2020 class 30, Grassland, where Urban Atlas 2021 identifies class 21000, Arable land;
- Urban Atlas 2021 class 50000, Water.

LCM-10 supplies the broad land-cover classes. Urban Atlas corrects their agricultural interpretation in both directions: pasture overrides LCM cropland, while Urban Atlas arable land overrides LCM grassland. Water takes precedence over both agricultural rules.

The headline denominator is the complete Statbel area of the selected sector or municipality. Excluded agriculture, water and missing Sentinel-2 observations therefore reduce the percentage instead of disappearing from the denominator. This prevents an inflated vegetation percentage and makes the metric directly comparable with the area's physical size.

## 5. Browser assets and aggregation

The published 2020 observation contains a full Zennevallei raster and seven transparent municipality variants. MapLibre swaps the local image when the municipality filter changes, so only the chosen municipality remains visible over OSM.

Sector metrics use the projected 10 m grid. Municipality metrics sum the underlying sector areas and recompute percentages from those totals. Selecting a sector replaces the municipality summary until the sector panel is closed.

## Interpretation limits

- A single date can reflect mowing, drought, crop stage, shadows and atmospheric effects.
- The fixed LCM-10 2020 and Urban Atlas 2021 corrections do not follow later land-cover changes.
- The selected observation can have incomplete coverage or residual cloud. The UI and manifest retain its quality status.
- If additional years are published later, independently calibrated thresholds will require careful disclosure in comparisons.
- The layer does not identify vegetation type, ownership, public access or physical land-cover change.
- A future difference view is intentionally not implemented yet.

## Explore the source observations in Python

Open `playground/ndvi` in VS Code and select its `.venv` interpreter. The Python workspace exposes raw-band loading, NDVI calculation, GeoPandas regions, lazy Xarray/Dask stacks and browser-ready experimental exports. The first notebook compares the cached 2020 and 2021 observations around Halle; the second prepares cached observations for time-series modelling. See the [playground guide](../playground/ndvi/README.md).
