# Data reference

This is the authoritative inventory of data used by Greenwave. Official
downloads and credentials remain private. Only validated, attributed browser
derivatives are published.

## Displayed layers

| Product ID | Source and reference time | Preparation and aggregation | Browser display |
| --- | --- | --- | --- |
| `heat` | Department of Care, Government of Flanders heat-vulnerability workbook, 2026 | Official sector scores are joined to Statbel 2024 sector IDs; Greenwave does not recalculate them | Sector colours and result indicators; percent/score units from the official methodology |
| `urban-atlas` | Copernicus Urban Atlas BE001L3, 2021, EPSG:3035 polygons | Intersections are calculated in the native equal-area CRS and summarised as hectares and shares | Land-use polygons and selected-sector composition |
| `income` | Statbel fiscal statistics by statistical sector, 2019-2023; current display 2023 | Exact sector-ID join. Published medians and quartiles are retained; sector medians are not combined into a municipality median | Median net taxable income per declaration and fixed display bands |
| `population` | Statbel variable population grid and sector population, 2025; Flanders 100 m density model and matching Statbel population, 2019 | The 2025 grid supplies current variable cells and exact scope totals. The 2019 100 m model is used only where comparisons need a uniform grid | Current density layer; comparison panels state when the 2019 model is used |
| `jaarbak` | Soil sealing (official product: JaarBAK), 2018-2024, native 1 m EPSG:31370 | Official classes are validated and clipped. Sector shares use complete source area; density is sealed share inside a 100 m circle | Categorical PMTiles or optional 100 m density surface |
| `groenkaart` | Flanders Green Map, 2018 and 2021, native 1 m EPSG:31370 | Four official classes remain categorical. Sector shares use complete area; selected high/low-green density is calculated inside 100 m | Categorical PMTiles or optional selected-class density |
| `landgebruik` | Flanders Land Use, 2019/2022/2025, 10 m EPSG:31370; 2025 agricultural parcels | Nineteen classes use nearest-neighbour categorical alignment. Parcel intersections and crop groups are calculated separately | Temporal land-use raster plus detailed 2025 parcel geometry |
| `landsat-temperature` | NASA/USGS Landsat 8/9 Collection 2 Level-2 via Planetary Computer; six heatwave acquisitions from 2020-2026 | Scale/offset convert ST_B10 to °C. QA_PIXEL, ST_QA, saturation, nodata and scene support determine clear versus obscured cells on an aligned 30 m EPSG:32631 grid | Daytime land-surface temperature, never air temperature; clear and cloud-obscured coverage are distinguished |
| `land-cover-scenario` | Green Map 2021, Soil sealing 2024, Urban Atlas 2021, Flanders Land Use 2025 water and Landsat 22 June 2026 | Exact 1 m upper-surface edits feed Radoux or the verified 2026 XGBoost model; outputs are method-specific ΔLST on 30 m centres | Public browser worker; edits and calculated fields remain session-only |

## Comparisons

| Comparison ID | Unit of observation and processing | Result display |
| --- | --- | --- |
| `heat-income` | Exact sector join of official 2026 heat scores and Statbel 2023 income | Sector scatter and income-band summaries; descriptive, not causal |
| `heat-population` | Exact sector join with Statbel 2025 population | Population bands, Tukey summaries and residents by heat score |
| `landsat-urban-atlas` | Exact Urban Atlas polygon area under each retained clear 30 m Landsat cell; one temperature may contribute proportionally to multiple classes | Temperature distributions by selected land-use class |
| `landsat-jaarbak` | Exact sealed/unsealed 1 m surface for distributions; surrounding sealed fraction within 100 m for regression points | Surface distributions and temperature-versus-sealing scatter |
| `landsat-groenkaart` | High/low Green Map selection within 100 m for eligible clear 30 m thermal centres, restricted by the documented shared urban mask | Temperature-versus-green-cover scatter and OLS line |
| `groenkaart-income` | Exact sealed urban area weights the selected 100 m green-density surface within each sector before comparison with Statbel income | Sector scatter and OLS line |
| `landsat-income` | Clear Landsat temperature-area sums over exact sealed Urban Atlas surface, divided by analysed area per sector | Sector temperature-versus-income scatter and OLS line |
| `groenkaart-population` | Exact-sealed-area-weighted vegetation cover per eligible 100 m population-model cell | Resident-weighted cumulative population profile |
| `landsat-population` | Clear exact-area mean temperature per eligible 100 m population-model cell; at least 0.10 ha support | Hottest-first cumulative residents and fixed 0.5°C distribution |

The four one-predictor regression comparisons show a descriptive unweighted
OLS line. Their two-sided test estimates spatial autocorrelation in both
variables over 13 distance classes, reduces the effective sample size, and
then tests `Pearson r = 0`. P-values are exploratory and unadjusted for the
many selectable configurations.

## Grids, masks and aggregation

- EPSG:3812 preserves source Statbel geometry before browser reprojection.
- EPSG:3035 is used for equal-area Urban Atlas and population calculations.
- EPSG:31370 retains the native Flemish land-cover grids.
- EPSG:32631 is the aligned 30 m Landsat analytical grid.
- EPSG:3857 is used only for browser display derivatives.
- Categorical products use nearest-neighbour resampling. Continuous products
  use the method recorded by their manifest or preparation module.
- Missing, cloud-obscured, saturated and nodata cells are excluded, not
  converted to zero.
- Exact-area analyses preserve partial source-cell contributions; observation
  counts and hectares are therefore different concepts.

## From source to screen

Small tabular/vector products are prepared by `scripts/prepare-*.mjs`. Large
geospatial products use `processing/local-layers`. Private analytical results
are written below `.cache/local-layers`; `pnpm official-layers:publish` copies
only an explicit allow-list into `public/data/official-layers`. `src/data.js`
loads those manifests, layer modules render the map, and comparison modules
build scope-filtered result models.

Source links, ownership and reuse conditions are listed in
[Third-party data](../THIRD_PARTY_DATA.md).
