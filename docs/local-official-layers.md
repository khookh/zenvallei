# Local official layers

Local mode adds Landsat surface temperature, JaarBAK, Groenkaart Vlaanderen and Landgebruik Vlaanderen. Their analytical files remain below `.cache/local-layers`. Normal development and GitHub Pages expose heat vulnerability, Urban Atlas and Statbel income.

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

See [Landsat surface temperature](landsat-surface-temperature.md) and [Landgebruik Vlaanderen](landgebruik-vlaanderen.md). Never move local manifests, PMTiles, parcel exports or analytical rasters into `public`.
