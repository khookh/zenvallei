# Official raster layers

The application includes Landsat surface temperature, JaarBAK, Groenkaart Vlaanderen and Landgebruik Vlaanderen in both local and GitHub Pages builds. Scientific preparation remains local; the static site receives only validated manifests, clipped PMTiles, the agricultural parcel GeoJSON and compact Landsat query rasters.

## Setup and preparation

```powershell
pnpm local-data:setup
pnpm local-data:test
pnpm local-data:prepare -- --dataset jaarbak
pnpm local-data:prepare -- --dataset groenkaart
pnpm landgebruik:prepare
pnpm landsat-heat:prepare
```

`--dataset all` prepares all four. JaarBAK, Groenkaart and Landgebruik also accept `--source YEAR=C:\data\source.tif`. Landsat discovery reads public STAC metadata and signed source windows, without storing signed URLs.

After validation, publish the browser derivatives:

```powershell
pnpm official-layers:publish
pnpm build:pages
pnpm test:pages
```

Statistics are calculated on each source's native analytical grid. Separate lossless PNG PMTiles are generated for the complete region and seven municipalities. The small `.cache/local-layers/index.json` catalogue loads at startup; manifests and PMTiles load only after selecting their layer.

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

See [Landsat surface temperature](landsat-surface-temperature.md) and [Landgebruik Vlaanderen](landgebruik-vlaanderen.md). Never copy raw downloads or the full cache into `public`; use the publishing command so only allow-listed browser derivatives are distributed.
