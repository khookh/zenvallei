# Official raster layers

The application includes Landsat surface temperature, Soil sealing (official product: JaarBAK), Groenkaart Vlaanderen and Landgebruik Vlaanderen in both local and GitHub Pages builds. Scientific preparation remains local; the static site receives only validated manifests, clipped PMTiles, compact density GeoTIFFs, the agricultural parcel GeoJSON and compact Landsat query rasters.

## Setup and preparation

```powershell
pnpm local-data:setup
pnpm local-data:test
pnpm local-data:prepare -- --dataset jaarbak
pnpm local-data:prepare -- --dataset groenkaart
pnpm landgebruik:prepare
pnpm landsat-heat:prepare
pnpm landsat-urban-atlas:prepare
pnpm landsat-soil-sealing:prepare
pnpm sealed-urban:prepare
pnpm green-population:prepare
pnpm landsat-population:prepare
```

`--dataset all` prepares the source layers and every raster comparison. Soil sealing, Groenkaart and Landgebruik also accept `--source YEAR=C:\data\source.tif`. Landsat discovery reads public STAC metadata and signed source windows, without storing signed URLs. The comparison commands reuse prepared files and make no network request.

After validation, publish the browser derivatives:

```powershell
pnpm official-layers:publish
pnpm build:pages
pnpm test:pages
```

Statistics are calculated on each source's native analytical grid. Separate lossless PNG PMTiles are generated for the complete region and seven municipalities. The small `.cache/local-layers/index.json` catalogue loads at startup; manifests and PMTiles load only after selecting their layer.

Soil sealing and Groenkaart preparation also creates a 100 m focal-density product. Native 1 m classes are aggregated to exact fractional 10 m cells, then evaluated with an area-weighted circular kernel. The denominator is the complete 3.14 ha circle, and a 100 m source halo includes surroundings outside Zennevallei. Values below 95% valid source coverage are unavailable. The browser receives 20 m display derivatives encoded as hundredths of a percentage; this display resolution stays well below the neighbourhood radius and keeps the complete density bundle under 80 MiB.

Soil-sealing density always represents sealed surface. Groenkaart density can combine any of its four non-overlapping official classes and starts with high green plus low green. The density mode replaces the classification display but does not change the existing area summaries in the result panel.

The raster comparisons are prepared below `.cache/local-layers`. `official-layers:publish` copies only their validated browser assets into the static bundle. They remain lazy-loaded and are not requested before a visitor chooses a comparison.

## Open and test

Double-click `Start Greenwave.cmd`, or use this while editing:

```powershell
pnpm dev:local-data
pnpm test:local-data
```

The local endpoint serves only allowed cache files and supports PMTiles byte ranges. Missing local data omits only that optional layer.

## Interpretation

- Landsat shows clear-sky land-surface temperature around one satellite overpass. It is not air temperature or a complete heatwave average.
- Soil sealing is a binary 1 m sealed or unsealed classification. The official JaarBAK production method changed in 2023; 2024 is provisional.
- Groenkaart preserves high green, low green, agriculture and non-green as separate 1 m classes.
- Landgebruik preserves all 19 official classes for the three-yearly 2019, 2022 and 2025 editions. Its optional 2025 parcel view shows the agricultural share of the complete Statbel area, crop-group composition and exact source crop attributes.

In Landsat comparison mode, the indexed Urban Atlas PMTiles mask clips temperature and cloud status to the exact selected polygons. Its histogram weights the parent 30 m temperature by every class's exact intersecting surface. The Soil sealing comparison reuses the official matched PMTiles: only the exact bright-red 1 m sealed pixels are drawn below the complete Landsat observation. Its histogram weights sealed and unsealed curves by exact native surface, while a second chart plots every eligible clear native Landsat observation against surrounding 100 m soil-sealing density without sampling. Histograms use fixed 0.5 degree Celsius bins; all relationships are descriptive rather than causal. See [Landsat surface temperature](landsat-surface-temperature.md) for exact family membership, year pairing and limitations.

The published demographic comparisons join the 2026 heat scores to Statbel income for 2023 or population for 2025 by statistical-sector code. They retain the selected heat metric on the map and update their charts to Entire Zennevallei or the selected municipality. They do not calculate a correlation, regression or causal effect. See [Demography data](demography-data.md).

Five comparisons share the same two-option Urban Atlas selector. Residential urban fabric contains `11100`, `11210`, `11220`, `11230` and `11240`; industrial, commercial, public, military and private units use official class `12100`. Both groups are selected initially and isolated structures `11300` remain excluded. The affected comparisons are Green Map × Landsat, Green Map × income, Landsat × income, Green Map × population and Landsat × population. Their maps use the exact 1 m sealed footprint intersected with the selected Urban Atlas mask. Green Map × income weights every 10 m density value by its exact eligible sealed area; both population comparisons summarise eligible values within uniform 100 m population-model cells; Green Map × Landsat keeps its one-record-per-eligible-30 m-observation graph contract. Spatial dependence, aggregation and mismatched source years prevent causal interpretation.

See [Landsat surface temperature](landsat-surface-temperature.md) and [Landgebruik Vlaanderen](landgebruik-vlaanderen.md). Never copy raw downloads or the full cache into `public`; use the publishing command so only allow-listed browser derivatives are distributed.

The 100 m radius is a pragmatic local heat-context scale, not a universal causal distance. Relevant scale evidence includes a [PNAS urban tree-cover study](https://pmc.ncbi.nlm.nih.gov/articles/PMC6462107/), a [Building and Environment spatial-scale study](https://doi.org/10.1016/j.buildenv.2023.111029) and a [Belgian Leuven heat-period study](https://www.sciensano.be/sites/default/files/beele_et_al_2024_lurp_spatial_config_green_space_1.pdf).
