# Landsat surface-temperature timeline

This layer shows NASA/USGS Landsat 8 and 9 Collection 2 Level-2 land-surface temperature during heatwaves defined by the Royal Meteorological Institute of Belgium (RMI, KMI in Dutch). Microsoft Planetary Computer supplies signed COG access only; it is not the scientific producer.

## Prepare

```powershell
pnpm local-data:setup
pnpm landsat-heat:prepare
pnpm official-layers:publish
pnpm dev:local-data
```

The command queries `landsat-c2-l2`, requires Tier 1 `L2SP` products, mosaics adjacent WRS rows from the same overpass, and caches only the Zennevallei windows. Repeated runs reuse valid cached files.

## RMI/KMI periods

- 5-16 August 2020
- 9-16 August 2022
- 8-17 June 2023
- 4-11 September 2023
- 28 June-2 July 2025
- 10-15 August 2025
- 17-28 June 2026

The Royal Meteorological Institute of Belgium (RMI, KMI in Dutch) defines a heatwave at Uccle as at least five consecutive days reaching 25 degrees Celsius, including at least three reaching 30 degrees Celsius. The June 2025 period has no Landsat 8/9 acquisition and remains a documented, non-selectable timeline event.

## Selection and calculation

Heatwave acquisitions require at least 10% clear Zennevallei coverage. Usable acquisitions within a listed period are shown unless they are explicitly withdrawn; observations outside those periods are not included. The 16 August 2020 acquisition is intentionally excluded from the timeline, while the official 5-16 August heatwave period remains recorded in provenance.

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

Sources: [RMI/KMI heatwaves](https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel), [USGS temperature product](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature), [Planetary Computer STAC](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/).
