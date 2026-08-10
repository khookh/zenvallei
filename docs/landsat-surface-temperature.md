# Landsat surface-temperature timeline

This layer shows NASA/USGS Landsat 8 and 9 Collection 2 Level-2 land-surface temperature during heatwaves defined by the Royal Meteorological Institute of Belgium (RMI, KMI in Dutch). Microsoft Planetary Computer supplies signed COG access only; it is not the scientific producer.

## Prepare

```powershell
pnpm local-data:setup
pnpm landsat-heat:prepare
pnpm landsat-urban-atlas:prepare
pnpm landsat-soil-sealing:prepare
pnpm official-layers:publish
pnpm dev:local-data
```

The command queries `landsat-c2-l2`, requires Tier 1 `L2SP` products, mosaics adjacent WRS rows from the same overpass, and caches only the Zennevallei windows. Repeated runs reuse valid cached files.

## RMI heatwave periods (KMI in Dutch)

- 5-16 August 2020
- 9-16 August 2022
- 8-17 June 2023
- 4-11 September 2023
- 28 June-2 July 2025
- 10-15 August 2025
- 17-28 June 2026

The Royal Meteorological Institute of Belgium (RMI, KMI in Dutch) defines a heatwave at Uccle as at least five consecutive days reaching 25 degrees Celsius, including at least three reaching 30 degrees Celsius. The June 2025 period has no Landsat 8/9 acquisition and remains a documented, non-selectable timeline event.

## Selection and calculation

Heatwave acquisitions require at least 10% clear Zennevallei coverage. The pipeline retains one acquisition per heatwave: the date with the greatest clear coverage, followed by proximity to the heatwave midpoint and timestamp as deterministic tie-breakers. The six selectable observations are 7 August 2020, 14 August 2022, 13 June 2023, 9 September 2023, 13 August 2025 and 22 June 2026. The 13 June and 9 September observations respectively replace the cloudier 14 June and 10 September acquisitions. Rejected acquisitions remain in the analytical cache and provenance but have no browser derivative.

The 16 August 2020 acquisition is intentionally excluded from selection, while the official 5-16 August heatwave period remains recorded in provenance.

Temperature is calculated from `lwir11` with:

```text
degrees Celsius = DN * 0.00341802 + 149.0 - 273.15
```

`qa_pixel` removes fill, dilated cloud, cirrus, cloud, cloud shadow and snow. `qa_radsat` removes radiometrically saturated pixels. Cloud pixels use a grey grid on the map; other missing values remain transparent. No gap filling or interpolation is performed.

## Outputs and metrics

Files are stored in `.cache/local-layers/landsat-temperature`:

- raw aligned source windows and hashes;
- 30 m EPSG:32631 analytical rasters;
- one full-region and seven municipality PMTiles per usable observation;
- `manifest.json` with discovery decisions, sources and 154 sector plus seven municipality summaries.

`pnpm official-layers:publish` copies only the clipped PMTiles, validated manifest and compact query rasters needed by the static website. Raw source windows and signed source URLs are never published.

The UI uses one fixed 15-50 degrees Celsius inferno scale for comparability. The date and acquisition time are displayed in `Europe/Brussels` local time with CET or CEST. Desktop hover and touch inspection query the exact active 30 m analytical pixel and show one decimal place. Sector and municipality summaries remain supporting context and report clear-sky median, mean, P10 and P90, clear/cloud/missing area, pixel count and product uncertainty.

Surface temperature is not air temperature or perceived temperature. It shows how warm roofs, roads, vegetation and other surfaces were around the overpass. These spatial differences are highly relevant for understanding urban heat islands and radiant heat at street level, but one image does not represent an entire heatwave or prove a cause.

## Surface comparisons

Both comparisons reuse the prepared Landsat analytical rasters and download no satellite or reference data. Preparation stays below `.cache/local-layers`; `pnpm official-layers:publish` copies only the validated browser derivatives used by local and GitHub Pages builds.

### Urban Atlas 2021

Run `pnpm landsat-urban-atlas:prepare` after preparing Landsat. It reuses the cached analytical rasters and `public/data/urban-atlas.geojson`; it downloads nothing. For every 30 m Landsat pixel, a 6 by 6 grid of 5 m sample points is evaluated. A pixel receives one Urban Atlas class only when a unique class covers at least 18 of the 36 points. Ties and mixed pixels without a majority are excluded.

The preparation files stay below `.cache/local-layers/landsat-urban-atlas`. The comparison manifest defines fixed 0.5 degree Celsius bins from 15 to 50 degrees Celsius. Per-observation files contain distributions for 154 sectors, seven municipalities and the complete Zennevallei, plus lossless browser-selection PNGs. The browser uses these PNGs only for display; all metrics come from the aligned EPSG:32631 analytical grid.

Choose Landsat surface temperature, select **Compare**, then **Urban Atlas 2021**. The default curves compare pooled green urban areas with continuous urban fabric. Up to four analysis families or individual classes can be shown. The families are artificial surfaces; green urban areas; agriculture; forest and semi-natural vegetation; sports and leisure; wetlands; and water. Family and child selections are mutually exclusive.

Only selected Urban Atlas surfaces are drawn. Their fill uses 18% opacity and their outline 62%; the thermal raster is drawn above them at 96%. Curves show the percentage of each surface's clear pixels per temperature bin and are normalised independently. One clear Landsat pixel is one recording, and 100% means all clear pixels assigned to that curve's surface. The comparison is descriptive, uses the fixed 2021 Urban Atlas classification for every Landsat year and does not treat spatially neighbouring pixels as independent observations.

The expanded chart identifies the KMI heatwave, Brussels-local acquisition time, selected geography and matched surface source. It reports both clear-pixel counts and nominal represented area, using 0.09 ha per 30 m pixel. Values outside the fixed 15-50 degree Celsius display range are reported separately rather than silently discarded.

### JaarBAK soil sealing

Run `pnpm landsat-soil-sealing:prepare` after JaarBAK and Landsat are prepared. The output is stored under `.cache/local-layers/landsat-jaarbak`. Each Landsat observation is paired with the closest available JaarBAK edition:

| Landsat observation | JaarBAK edition |
| --- | --- |
| 7 August 2020 | 2020 |
| 14 August 2022 | 2022 |
| 13 June and 9 September 2023 | 2023 |
| 13 August 2025 and 22 June 2026 | 2024 |

Native binary 1 m JaarBAK values are area-averaged into each 30 m Landsat pixel. At least 50% valid JaarBAK coverage is required. More than 50% sealed becomes **Sealed**, less than 50% becomes **Unsealed**, and exact ties are excluded from the two distributions. The comparison always shows those two independently normalised curves. A dedicated aligned mask draws only majority-sealed Landsat cells in deep red; unsealed cells remain transparent. The thermal raster is drawn above that mask with enough transparency to retain the sealing context. Both canvases mount atomically and do not depend on the asynchronous JaarBAK PMTiles source.

The UI discloses that the JaarBAK method changed in 2023 and that the 2024 edition is provisional. The 2024 mask is the closest available reference for the 2025 and 2026 Landsat observations.

### Sealed urban-fabric scatter comparisons

Run `pnpm sealed-urban:prepare` after Landsat, Green Map, JaarBAK and Urban Atlas are available. It creates three cached-only comparisons without downloading sources:

- Green Map × Landsat: one point per eligible clear 30 m pixel, with selected Green Map density on X and temperature on Y.
- Green Map × income: one point per eligible sector, with Statbel 2023 median taxable income on X and mean Green Map density on Y.
- Landsat × income: one point per sector with at least ten eligible clear pixels, with income on X and mean temperature on Y.

Eligibility is intentionally narrow. Urban Atlas must uniquely identify `11100`, `11210`, `11220`, `11230` or `11240`; isolated structures `11300` are excluded. JaarBAK must have enough valid source coverage and a sealed majority. Landsat points must also be clear and finite, and Green Map points require sufficient valid 2021 density coverage. The displayed lines are ordinary unweighted OLS summaries with R². They describe association within the selected scope and do not establish causation; no p-values are reported because pixels are spatially correlated and sector summaries are ecological observations.

### Comparison palette and interpretation

Comparison rasters use a fixed, vendored thermal colour table derived from the MIT-licensed [cmocean 4.0.3 thermal palette](https://matplotlib.org/cmocean/). The dark-blue-to-pale-yellow scale remains fixed at 15-50 degrees Celsius across all observations. Ordinary Landsat mode keeps its existing palette.

The curves compare distribution shapes, not causal effects. Pixels are spatially correlated, mixed pixels can be excluded, and the reference classifications do not always match the Landsat acquisition year.

Sources: [RMI/KMI heatwaves](https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel), [USGS temperature product](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature), [Planetary Computer STAC](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/).
