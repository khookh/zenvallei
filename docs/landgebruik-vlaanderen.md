# Landgebruik Vlaanderen

This layer uses the official 10 m Landgebruik Vlaanderen raster for 2019, 2022 and 2025. The source is three-yearly, not annual. It also offers an optional 2025 agricultural parcel view from the official Landbouwgebruikspercelen dataset.

## Prepare and run

```powershell
pnpm local-data:setup
pnpm landgebruik:prepare
pnpm dev:local-data
```

Use `--source YEAR=C:\data\landgebruik.tif` to reuse a manually cached official raster. The parcel complement is downloaded from collection `AGPA_2025` of the Agriculture and Fisheries OGC API.

## Processing

- Landgebruik values 1 to 19 and the official WMS colours are preserved.
- Statistics are calculated on the native EPSG:31370 grid with the complete Statbel area as denominator.
- Categorical PMTiles use nearest-neighbour resampling and are visual derivatives only.
- Agricultural parcels are clipped to the 154 sectors. The headline parcel share uses complete Statbel area; crop-group percentages use only mapped parcel area. Areas are calculated in EPSG:3035.
- Non-finite source properties become JSON `null`, and strict serialization rejects invalid `NaN` or infinity values before the browser asset is written.
- Exact crop titles and production attributes remain unmodified source values. The UI translates only broad crop-group labels.

The year control contains only 2019, 2022 and 2025. Agricultural use is disabled outside 2025 and never changes the selected year automatically. Its parcel GeoJSON is loaded only when that view is activated. Differences between editions can reflect improved source data or methods as well as physical land-use change.

Sources: [Landgebruik Vlaanderen 2025](https://www.vlaanderen.be/datavindplaats/catalogus/landgebruik-vlaanderen-toestand-2025), [Landbouwgebruikspercelen 2025](https://www.vlaanderen.be/datavindplaats/catalogus/landbouwgebruikspercelen-2025), [AGPA OGC API](https://geoservices.landbouwvlaanderen.be/AGPA/ogc/features/v1).
