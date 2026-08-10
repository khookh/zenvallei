# Official raster layers

The application includes Landsat surface temperature, JaarBAK, Groenkaart Vlaanderen and Landgebruik Vlaanderen in both local and GitHub Pages builds. Scientific preparation remains local; the static site receives only validated manifests, clipped PMTiles, compact density GeoTIFFs, the agricultural parcel GeoJSON and compact Landsat query rasters.

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
pnpm groenkaart-urban-atlas:prepare
```

`--dataset all` prepares the source layers and all three raster comparisons. JaarBAK, Groenkaart and Landgebruik also accept `--source YEAR=C:\data\source.tif`. Landsat discovery reads public STAC metadata and signed source windows, without storing signed URLs. The comparison commands reuse prepared files and make no network request.

After validation, publish the browser derivatives:

```powershell
pnpm official-layers:publish
pnpm build:pages
pnpm test:pages
```

Statistics are calculated on each source's native analytical grid. Separate lossless PNG PMTiles are generated for the complete region and seven municipalities. The small `.cache/local-layers/index.json` catalogue loads at startup; manifests and PMTiles load only after selecting their layer.

JaarBAK and Groenkaart preparation also creates a 100 m focal-density product. Native 1 m classes are aggregated to exact fractional 10 m cells, then evaluated with an area-weighted circular kernel. The denominator is the complete 3.14 ha circle, and a 100 m source halo includes surroundings outside Zennevallei. Values below 95% valid source coverage are unavailable. The browser receives 20 m display derivatives encoded as hundredths of a percentage; this display resolution stays well below the neighbourhood radius and keeps the complete density bundle under 80 MiB.

JaarBAK density always represents sealed surface. Groenkaart density can combine any of its four non-overlapping official classes and starts with high green plus low green. The density mode replaces the classification display but does not change the existing area summaries in the result panel.

The `landsat-urban-atlas`, `landsat-jaarbak` and `groenkaart-urban-atlas` comparisons are prepared below `.cache/local-layers`. `official-layers:publish` copies only their validated browser assets into the static bundle. They remain lazy-loaded and are not requested before a visitor chooses a comparison.

## Open and test

Double-click `Start Greenwave.cmd`, or use this while editing:

```powershell
pnpm dev:local-data
pnpm test:local-data
```

The local endpoint serves only allowed cache files and supports PMTiles byte ranges. Missing local data omits only that optional layer.

## Interpretation

- Landsat shows clear-sky land-surface temperature around one satellite overpass. It is not air temperature or a complete heatwave average.
- JaarBAK is a binary 1 m sealed or unsealed classification. Its production method changed in 2023; 2024 is provisional.
- Groenkaart preserves high green, low green, agriculture and non-green as separate 1 m classes.
- Landgebruik preserves all 19 official classes for the three-yearly 2019, 2022 and 2025 editions. Its optional 2025 parcel view shows the agricultural share of the complete Statbel area, crop-group composition and exact source crop attributes.

In Landsat comparison mode, Urban Atlas is reduced to the selected analysis families or classes beneath a stronger thermal raster. JaarBAK uses its sealed classification as the faint map base while the analysis compares sealed and unsealed 30 m majority assignments. Histograms use fixed 0.5 degree Celsius bins; each curve is normalised independently and is descriptive rather than causal. See [Landsat surface temperature](landsat-surface-temperature.md) for exact family membership, year pairing and limitations.

The published demographic comparisons join the 2026 heat scores to Statbel income for 2023 or population for 2025 by statistical-sector code. They retain the selected heat metric on the map and update their charts to Entire Zennevallei or the selected municipality. They do not calculate a correlation, regression or causal effect. See [Demography data](demography-data.md).

The Green Map comparison combines the selected 2021 Green Map class densities inside five Urban Atlas urban-fabric classes. The map masks out unselected fabrics. The result panel reports means and Tukey box plots from the scientific 10 m grid for sectors, municipalities and Entire Zennevallei. Isolated structures (11300) are excluded deliberately.

See [Landsat surface temperature](landsat-surface-temperature.md) and [Landgebruik Vlaanderen](landgebruik-vlaanderen.md). Never copy raw downloads or the full cache into `public`; use the publishing command so only allow-listed browser derivatives are distributed.

The 100 m radius is a pragmatic local heat-context scale, not a universal causal distance. Relevant scale evidence includes a [PNAS urban tree-cover study](https://pmc.ncbi.nlm.nih.gov/articles/PMC6462107/), a [Building and Environment spatial-scale study](https://doi.org/10.1016/j.buildenv.2023.111029) and a [Belgian Leuven heat-period study](https://www.sciensano.be/sites/default/files/beele_et_al_2024_lurp_spatial_config_green_space_1.pdf).
