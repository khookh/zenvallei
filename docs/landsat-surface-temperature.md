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

Run `pnpm landsat-urban-atlas:prepare` after preparing Landsat. It reuses the cached analytical rasters and `public/data/urban-atlas.geojson`; it downloads nothing. Urban Atlas polygons are rasterised on an aligned 1 m accounting grid in EPSG:31370. Every intersecting square metre inherits the unchanged temperature of its parent 30 m Landsat observation. A parent observation crossing several classes therefore contributes its exact intersecting area to each class rather than being assigned wholly to one class.

The preparation files stay below `.cache/local-layers/landsat-urban-atlas`. The comparison manifest defines fixed 0.5 degree Celsius bins from 15 to 50 degrees Celsius. Per-observation files contain exact-area-weighted distributions for 154 sectors, seven municipalities and the complete Zennevallei, plus lossless temperature/status PNGs. An indexed PMTiles mask retains the original polygon geometry for display.

Choose Landsat surface temperature, select **Compare**, then **Urban Atlas 2021**. The default curves compare pooled green urban areas with continuous urban fabric. Up to four analysis families or individual classes can be shown. The families are artificial surfaces; green urban areas; agriculture; forest and semi-natural vegetation; sports and leisure; wetlands; and water. Family and child selections are mutually exclusive.

Only selected Urban Atlas surfaces are drawn. Thermal colours and cloud hatching are clipped to the exact selected polygons, with restrained outlines. Curves show the percentage of each surface's clear observed area per temperature bin and are normalised independently. A partial parent Landsat observation contributes only its intersecting area while keeping its native temperature. The comparison is descriptive, uses the fixed 2021 Urban Atlas classification for every Landsat year and does not treat spatially neighbouring observations as independent.

The expanded chart identifies the KMI heatwave, Brussels-local acquisition time, selected geography and matched surface source. It reports exact clear observed hectares and the number of contributing native Landsat observations. Exact areas outside the fixed 15-50 degree Celsius display range are reported separately rather than silently discarded.

### Soil sealing (official product: JaarBAK)

Run `pnpm landsat-soil-sealing:prepare` after Soil sealing and Landsat are prepared. The output is stored under `.cache/local-layers/landsat-jaarbak`. Each Landsat observation is paired with the closest available soil-sealing edition:

| Landsat observation | Soil-sealing edition |
| --- | --- |
| 7 August 2020 | 2020 |
| 14 August 2022 | 2022 |
| 13 June and 9 September 2023 | 2023 |
| 13 August 2025 and 22 June 2026 | 2024 |

The map reuses the matched official Soil sealing PMTiles directly. It decodes the original bright-red `#e8292f` sealed class, makes unsealed pixels transparent and draws that exact 1 m footprint below the complete Landsat observation. The Landsat raster remains visible at 72% opacity, including temperature pixels whose 30 m analytical class is unsealed. This makes the comparison footprint identical to the standalone Soil sealing layer for the same year and municipality.

The histogram intersects the native binary 1 m Soil sealing surface with clear 30 m Landsat observations. Every retained square metre keeps its sealed or unsealed class and inherits its parent Landsat temperature. A mixed parent observation may therefore contribute proportionally to both independently normalised distributions. The chart reports exact clear observed hectares and contributing native Landsat observations rather than nominal full-pixel area.

A second scatter plot relates every clear, finite Landsat record with valid soil-sealing density to the sealed share within 100 m of its pixel centre. It includes the complete 0-100% range, including 0% sealed surface, and uses the existing circular focal density derived from native 1 m values. At least 95% of the 100 m circle must have valid source coverage. Every eligible pixel is plotted without sampling. Inline presentation keeps only the observation count and slope; expanded Details add the intercept, Pearson r, tie-aware Spearman rho, R², a spatially adjusted two-sided p-value and the effective spatial sample. Point opacity and size increase for sparse area selections only as a visibility aid; they are not statistical weights.

The UI discloses that the official product's method changed in 2023 and that the 2024 edition is provisional. The 2024 mask is the closest available reference for the 2025 and 2026 Landsat observations.

### Sealed urban-fabric scatter comparisons

Run `pnpm sealed-urban:prepare` after Landsat, Green Map, JaarBAK and Urban Atlas are available. It creates three cached-only comparisons without downloading sources:

- Green Map × Landsat: one point per eligible clear 30 m pixel, with selected Green Map density on X and temperature on Y.
- Green Map × income: one point per eligible sector, with Statbel 2023 median taxable income on X and mean Green Map density on Y.
- Landsat × income: one point per sector with at least 0.10 ha of clear eligible surface, with income on X and exact-area mean temperature on Y.

All five sealed-surface comparisons let users combine the residential group (`11100`, `11210`, `11220`, `11230`, `11240`) and official class `12100`, which cannot be separated into its industrial, commercial, public, military and private components. Both groups are selected initially; isolated structures `11300` are excluded. Urban Atlas polygons, native 1 m Soil sealing and clear native 30 m Landsat observations are intersected in EPSG:31370. Each retained square metre inherits its parent Landsat temperature; this is exact area accounting, not a synthetic 1 m temperature measurement. Green Map × Landsat keeps one unweighted regression point per contributing native 30 m observation. Sector and population-cell means instead divide temperature-area sums by exact retained area and require at least 0.10 ha.

The displayed lines remain ordinary unweighted OLS summaries. Expanded Details report Pearson r for linear association, tie-aware Spearman rho for monotonic rank association and R² as the share of observed Y variation described by the fitted line in the current sample. A separate two-sided Clifford-Richardson-Hémon/Dutilleul modified test evaluates Pearson r = 0 using 13 spatial-distance classes and reports its effective sample size. Raster tests use exact EPSG:31370 pixel centres with mask-normalised FFT convolution; sector tests use projected centroids and direct distance classes. A numerical p-value requires at least 10 observations and an effective spatial sample of at least 10. These exploratory values are not adjusted across selectable dates and configurations, and neither the line nor the test establishes causation.

Landsat × income also groups sector-average temperatures into the three income-symbol categories used on the map. The Tukey boxes give every comparable sector equal weight and retain sector dots plus an arithmetic-mean marker. Categories with fewer than five comparable sectors are suppressed. The expanded dialog keeps this same sector-level analytical unit and adds the detailed regression statistics.

Landsat × population density uses the Government of Flanders uniform 100 m model from 2019. Within each 1 ha population cell, temperature-area sums over the exact eligible surface are divided by that surface; at least 0.10 ha is required. One chart orders cells from hottest to coolest and traces cumulative modelled residents; a second sums represented residents into fixed 0.5°C intervals. The cell's population describes its complete modelled hectare, while its temperature describes only the eligible masked portion. The comparison differs from the registered 2025 population total because it uses an older model and excludes cells without sufficient clear eligible surface. It is an area-level descriptive comparison, not an individual exposure estimate or a population-change estimate.

### Comparison palette and interpretation

Comparison rasters use a fixed, vendored thermal colour table derived from the MIT-licensed [cmocean 4.0.3 thermal palette](https://matplotlib.org/cmocean/). The dark-blue-to-pale-yellow scale remains fixed at 15-50 degrees Celsius across all observations. Ordinary Landsat mode keeps its existing palette.

The curves compare distribution shapes, not causal effects. Pixels are spatially correlated, mixed pixels can be excluded, and the reference classifications do not always match the Landsat acquisition year.

Sources: [RMI/KMI heatwaves](https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel), [USGS temperature product](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature), [Planetary Computer STAC](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/).
