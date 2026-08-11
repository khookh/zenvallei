# Data inventory

Official downloads and credentials stay outside `public`. Only validated public derivatives are committed. Local analytical rasters and PMTiles remain ignored below `.cache/local-layers`.

| Active layer or asset | Official input | Preparation | Runtime output | Calculated here |
| --- | --- | --- | --- | --- |
| Heat vulnerability | Department of Care, Government of Flanders, 2026 workbook | `scripts/prepare-data.mjs` | `scores.json`, `methodology.json`, `provenance.json` | no score recalculation; rows are joined to Statbel IDs |
| Statbel sectors | Statistical sectors, 1 January 2024, EPSG:3812 | `scripts/prepare-data.mjs` | `sectors.geojson` | Zennevallei filter and WGS84 reprojection |
| Urban Atlas 2021 | Copernicus FUA BE001L3, EPSG:3035 | `scripts/prepare-urban-atlas.mjs` | `urban-atlas.json`, `urban-atlas.geojson` | equal-area class intersections and sector summaries |
| Median taxable income | Statbel fiscal income by statistical sector, 2019-2023 | `scripts/prepare-income.mjs` | `income.json` | exact sector-ID join and fixed display bands; income values are not recalculated |
| Population density | Statbel variable population grid and compatible sector population, 2025; Government of Flanders 100 m model and Statbel sector population, 2019 | `scripts/prepare-population.mjs` | `population.json`, 2025 cell GeoJSON and 2019 raster variants | inhabitants per hectare; exact selected-area totals from the matching Statbel sector table |
| Landsat temperature | NASA/USGS Landsat 8/9 Level-2 via Planetary Computer | `processing/local-layers/.../landsat.py` | validated manifest, PMTiles and query rasters | discovery, QA masks, clipping and clear-sky temperature summaries |
| Landsat x Urban Atlas comparison | prepared Landsat analytical rasters and Copernicus Urban Atlas 2021 polygons | `processing/local-layers/.../landsat_urban_atlas.py` | validated manifest, exact-area distributions, status PNGs and indexed polygon PMTiles | exact polygon area inherits its parent 30 m Landsat temperature and contributes proportionally to each selected class |
| Landsat x Soil sealing comparison | prepared Landsat analytical rasters, native 1 m Soil sealing rasters and official PMTiles | `processing/local-layers/.../landsat_jaarbak.py` | manifest, exact-area distributions, lossless density indexes and exact PMTiles composition | sealed/unsealed exact-surface temperature distributions; every eligible native Landsat observation against 100 m density; exact 1 m sealed display |
| Green Map x Landsat comparison | prepared Green Map 2021 focal-density bands, Landsat rasters, Urban Atlas 2021 and matched JaarBAK rasters | `processing/local-layers/.../sealed_urban_comparisons.py` | manifest, aligned analytical pixel rasters and exact JaarBAK/Urban Atlas display composition | selected-class density against clear-sky temperature for analytically eligible 30 m pixels; exact sealed subpixel display |
| Green Map x income comparison | prepared Green Map 2021 focal-density bands, Urban Atlas 2021, JaarBAK 2021 and Statbel income 2023 | `processing/local-layers/.../sealed_urban_comparisons.py` | manifest, density rasters, exact shared mask and sector statistics | exact 1 m sealed-urban area weighting of selected density against exact sector income |
| Green Map x population comparison | prepared Green Map 2021 focal-density bands, Urban Atlas 2021, Soil sealing 2021 and the Government of Flanders 2019 population model | `processing/local-layers/.../groenkaart_population.py` | manifest, compact group-aware 100 m observations and indexed exact display mask | resident-weighted cumulative-population bars from exact-sealed-area-weighted vegetation cover per eligible 100 m cell |
| Landsat x population comparison | prepared Landsat observations, Urban Atlas 2021, matched Soil sealing and the Government of Flanders 2019 population model | `processing/local-layers/.../landsat_population.py` | manifest and compact group-aware exact-area 100 m cell means, reusing the indexed exact display mask | hottest-first cumulative-resident temperature curve and fixed 0.5°C resident distribution from cells with at least 0.10 ha of clear eligible surface |
| Landsat x income comparison | prepared Landsat rasters, Urban Atlas 2021, matched Soil sealing and Statbel income 2023 | `processing/local-layers/.../sealed_urban_comparisons.py` | manifest, aligned temperature rasters and exact-area sector statistics | temperature-area sums over exact sealed Urban Atlas surfaces divided by analysed area, compared with exact sector income |
| Heat x income comparison | published 2026 heat scores and Statbel 2023 fiscal income | browser comparison module; no new source download | map glyphs and scope-filtered chart models | exact sector join, income bands, scatter points and Tukey summaries |
| Heat x population comparison | published 2026 heat scores and Statbel 2025 sector population | browser comparison module; no new source download | map person symbols and scope-filtered chart models | fixed population bands, Tukey summaries and residents by score |
| Soil sealing | JaarBAK 2018-2024, EPSG:31370 | `processing/local-layers` | validated manifest, clipped PMTiles and density GeoTIFFs | sealed and unsealed shares of complete Statbel area; sealed share within a 100 m circle |
| Flanders Green Map | Groenkaart Vlaanderen 2018 and 2021 from the Agency for Nature and Forests, Government of Flanders, and Digital Flanders Agency | `processing/local-layers` | validated manifest, clipped PMTiles and density GeoTIFFs | four official class shares of complete Statbel area; selected-class share within a 100 m circle |
| Flanders land use | Landgebruik Vlaanderen 2019, 2022 and 2025 from the Department of Environment & Spatial Development, Government of Flanders, plus 2025 parcels from the Agency for Agriculture and Fisheries, Government of Flanders | `processing/local-layers/.../landgebruik.py` | validated manifest, PMTiles and clipped parcel GeoJSON | all 19 class shares; parcel share of complete Statbel area and crop-group composition |
| Notebook Test layer | Sentinel-2 bands loaded by the Python playground | `greenwave_ndvi` export helpers | ignored local PNG and manifest | user-defined Python experiment; never distributed |
| Header mark | dissolved Statbel geometry | `scripts/generate-brand-mark.mjs` | `assets/zennevallei-river-mark.png` | deterministic silhouette and stylised river |
| OSM background | configured tile provider | none | runtime tile requests | no derived metric |

## Coordinate systems

- EPSG:3812 preserves Statbel source geometry before browser reprojection.
- EPSG:3035 is equal-area for Urban Atlas hectare calculations.
- EPSG:3035 is also the native equal-area CRS of the 2025 Statbel population grid.
- EPSG:31370 retains the native JaarBAK, Groenkaart and Landgebruik grids.
- EPSG:32631 is the aligned 30 m Landsat analytical grid.
- EPSG:3857 is used only for visual PMTiles and density browser derivatives.

## Security boundary

Source archives, raw rasters, signed URLs, tokens, notebooks outputs and provenance sidecars are ignored. Distribution checks reject credentials, local paths, PMTiles and local endpoints in `dist`.
