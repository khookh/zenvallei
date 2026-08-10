# Demography data

The Demography category contains two different official measures. Population density describes where residents are concentrated. Median taxable income describes fiscal income per tax declaration, not salary, household disposable income or wealth.

In local-data mode, median taxable income for 2023 can be compared descriptively with the three published 2026 heat metrics. The scatter plot keeps exact income values, includes the 140 statistical sectors with both measures and always covers the complete Zennevallei. A horizontal Tukey box plot on each score row summarises its income distribution: the box spans Q1 to Q3, the line marks the median and each whisker reaches the most extreme observation within 1.5 times the interquartile range. The exact sector points remain visible, including outliers. The year mismatch, ordinal relative score scale, spatial dependence and area-level nature of both measures mean that the graph cannot establish causation or describe individual residents. No regression or correlation coefficient is calculated.

## Population density

The default **Current grid · 2025** view uses [Statbel's variable population grid](https://statbel.fgov.be/en/themes/datalab/variable-cell-grid). Cells are 125, 250, 500 or 1,000 m wide. Their size and the geographical displacement of some residents protect confidentiality. The map calculates inhabitants per hectare from each cell's published population and area. Exact sector, municipality and Zennevallei totals come from Statbel's compatible 2025 sector table, not from summing displaced cells.

The alternate **100 m model · 2019** view uses the [Government of Flanders population-density model](https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019). It estimates residents in 1 ha cells from geocoded residential addresses and was corrected to Statbel sector totals. It is finer but older and modelled. The two views must not be subtracted to estimate population change.

Prepare both views with `pnpm population:prepare`; add explicit `--grid`, `--sectors-2025`, `--sectors-2019` and `--flanders-2019` paths to reuse verified downloads. Raw national files remain below `.cache/population`. Browser assets are documented in [the data inventory](data-inventory.md).

## Why there is no resident-language layer

Belgium's last language census was in 1947. Language questions were removed by law in 1961 and were absent from the 1961 and later censuses. The historical [1947 Statbel volume](https://data.gov.be/en/datasets/q12573id) cannot describe current residents.

Current official indicators cover restricted populations. For example, the [Flanders pupil indicator](https://gemeente-stadsmonitor.vlaanderen.be/over-de-monitor/overzicht-indicatoren/leerlingen-lager-onderwijs-naar-woonplaats-naar-thuistaal) concerns children in Dutch-language mainstream primary education and is generally published by municipality. It cannot represent the Dutch, French or other-language distribution of all residents. The application therefore does not infer language from nationality, origin, school attendance or the administrative language area.
