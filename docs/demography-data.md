# Demography data

The Demography category contains two different official measures. Population density describes where residents are concentrated. Median taxable income describes fiscal income per tax declaration, not salary, household disposable income or wealth.

Median taxable income for 2023 can be compared descriptively with the three published 2026 heat metrics. The scatter plot keeps exact income values. It includes the 140 comparable sectors for Entire Zennevallei or the comparable sectors in the selected municipality. A horizontal Tukey box plot on each score row summarises its income distribution: the box spans Q1 to Q3, the line marks the median and each whisker reaches the most extreme observation within 1.5 times the interquartile range. Exact sector points remain visible, including outliers. The year mismatch, ordinal relative score scale, spatial dependence and area-level nature of both measures mean that the graph cannot establish causation or describe individual residents. No regression or correlation coefficient is calculated.

Heat vulnerability can also be compared with population. It uses Statbel's authoritative 2025 sector totals, not the displaced population grid or the 2019 model. One to five map symbols represent fixed population bands. Vertical box plots compare the selected heat score across those bands with one equal-weight observation per comparable sector. A second chart sums residents by the selected score, so its weighting is explicitly different. Both charts use the same Zennevallei or selected-municipality scope. They are descriptive area-level summaries and do not measure individual heat exposure.

Both comparisons keep the selected heat metric on the map. Income or population symbols form a separate legend section and sector selection highlights the matching graph observation without replacing the area-scoped analysis.

## Green Map and the uniform population model

The Green Map × population-density comparison deliberately uses the Government of Flanders **100 m model · 2019**, not Statbel's privacy-adjusted variable 2025 grid. One observation is one eligible 100 m population cell. Its X value is modelled inhabitants per hectare; its vegetation value is the exact-sealed-area-weighted mean of selected 100 m surrounding Green Map cover at positions within the selected Urban Atlas groups. A cell needs at least 0.10 ha of exact 2021 sealed surface and valid Green Map density.

Eligible cells are sorted by modelled inhabitants per hectare and grouped into successive shares of the selected scope's residents. Identical density values remain together and adjacent groups merge until at least five cells remain. Bar heights are resident-weighted mean vegetation cover. Zero-population cells are excluded from the cumulative denominator; fewer than ten positive-population cells produce only the exact resident-weighted mean. Because the population model is from 2019 and Green Map is from 2021, the chart is descriptive and cannot establish individual exposure or causation.

## Landsat and the uniform population model

Landsat × population density uses the same Government of Flanders **100 m model · 2019**. Exact Urban Atlas polygons and native 1 m Soil sealing cells are intersected with clear native 30 m Landsat observations. Every retained square metre inherits its parent temperature, so partial Landsat observations contribute in proportion to their exact retained surface. A population-cell mean requires at least 0.10 ha of clear eligible surface.

Two charts retain the cell's complete modelled resident count. The first sorts cells from hottest to coolest and traces cumulative residents; the second sums represented residents into fixed 0.5°C intervals. Hover values distinguish residents and shares at or above the selected temperature, residents and shares in cooler cells, and residents in the corresponding interval. The represented population differs from the standalone registered 2025 total because this comparison uses a modelled 2019 raster and includes only cells with at least 0.10 ha of clear eligible surface. Neither difference estimates population change, and this area-level daytime surface-temperature profile is not an individual exposure measurement.

All five sealed-surface comparisons offer two Urban Atlas groups: residential urban fabric (`11100`, `11210`, `11220`, `11230`, `11240`) and industrial, commercial, public, military and private units (`12100`). Both are selected initially; at least one remains active. Isolated structures (`11300`) are excluded.

## Population density

The default **Current grid · 2025** view uses [Statbel's variable population grid](https://statbel.fgov.be/en/themes/datalab/variable-cell-grid). Cells are 125, 250, 500 or 1,000 m wide. Their size and the geographical displacement of some residents protect confidentiality. The map calculates inhabitants per hectare from each cell's published population and area. Exact sector, municipality and Zennevallei totals come from [Statbel's compatible 2025 sector table](https://statbel.fgov.be/sites/default/files/files/opendata/bevolking/sectoren/OPENDATA_SECTOREN_2025_OLD.xlsx), not from summing displaced cells.

The alternate **100 m model · 2019** view uses the [Government of Flanders population-density model](https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019). It estimates residents in 1 ha cells from geocoded residential addresses and was corrected to Statbel sector totals. It is finer but older and modelled. The two views must not be subtracted to estimate population change.

Prepare both views with `pnpm population:prepare`; add explicit `--grid`, `--sectors-2025`, `--sectors-2019` and `--flanders-2019` paths to reuse verified downloads. Raw national files remain below `.cache/population`. Browser assets are documented in [the data inventory](data-inventory.md).

## Why there is no resident-language layer

Belgium's last language census was in 1947. Language questions were removed by law in 1961 and were absent from the 1961 and later censuses. The historical [1947 Statbel volume](https://data.gov.be/en/datasets/q12573id) cannot describe current residents.

Current official indicators cover restricted populations. For example, the [Flanders pupil indicator](https://gemeente-stadsmonitor.vlaanderen.be/over-de-monitor/overzicht-indicatoren/leerlingen-lager-onderwijs-naar-woonplaats-naar-thuistaal) concerns children in Dutch-language mainstream primary education and is generally published by municipality. It cannot represent the Dutch, French or other-language distribution of all residents. The application therefore does not infer language from nationality, origin, school attendance or the administrative language area.
