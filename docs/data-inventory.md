# Data inventory

Greenwave separates official source preparation from the static browser application. Raw downloads and credentials stay outside `public`; only validated browser-ready derivatives are committed.

| Runtime layer or asset | Official input | Preparation path | Local cache or source | Browser output | Calculated by Greenwave |
| --- | --- | --- | --- | --- | --- |
| Heat vulnerability | Government of Flanders, Department of Care, 2026 workbook | `scripts/prepare-data.mjs` | supplied workbook or pinned download | `scores.json`, `methodology.json`, `provenance.json` | no score recalculation; source rows are joined to Statbel IDs |
| Statbel sectors | Statistical sectors dated 1 January 2024, EPSG:3812 | `scripts/prepare-data.mjs` | supplied archive or pinned download | `sectors.geojson` | reprojection to WGS84 and Zennevallei filtering |
| Land cover 2020 | Copernicus LCM-10 COG, EPSG:4326 | `scripts/prepare-landcover.mjs`, `scripts/prepare-landcover-variants.mjs` | `.cache/land-cover` | `land-cover.json`, full and municipality PNG files | clipping and class area summaries by Statbel sector and municipality |
| Urban Atlas 2021 | Copernicus FUA BE001L3, EPSG:3035 | `scripts/prepare-urban-atlas.mjs` | `.cache/urban-atlas` | `urban-atlas.json`, `urban-atlas.geojson` | equal-area intersections, green coverage, artificialisation and class summaries |
| Likely vegetation 2020 | selected Sentinel-2 L2A observation, Urban Atlas 2021 and LCM-10 2020 | `scripts/discover-vegetation.mjs`, `scripts/download-vegetation.mjs`, `scripts/prepare-vegetation-years.mjs` | `.cache/vegetation` retains 2015-2026 for the playground | `vegetation.json`, one full and seven municipality PNG files for 2020 | NDVI, observation mask, threshold calibration, agricultural and water masks, area summaries using complete Statbel area |
| Notebook Test layer | raw Sentinel-2 B04, B08, SCL and dataMask selected by the Python playground | `greenwave_ndvi.download_raw_observation` and notebook export helpers | `.cache/vegetation/raw` and `.cache/playground/web` | local-only `test.png`, municipality variants and `manifest.json` | Python NDVI, experimental continuous or categorical raster and optional area summaries; never included in `dist` |
| Header mark | dissolved Statbel sector geometry | `scripts/generate-brand-mark.mjs` | committed sector geometry | `assets/zennevallei-river-mark.png` | deterministic white silhouette and a stylised blue river curve |
| OSM background | configured OSM-derived tile provider | no preparation | none | runtime tile requests only | no derived metric |

## Coordinate systems

- EPSG:3812 preserves the published Statbel source coordinates before conversion to WGS84 for MapLibre.
- EPSG:3035 is equal-area and is used for Urban Atlas intersections and hectare calculations.
- EPSG:32631 is the 10 m Sentinel-2 processing grid used for NDVI and raster masks.
- Web-facing vector geometry uses EPSG:4326; prepared browser rasters include their WGS84 corner coordinates in their manifests.

## Security boundary

`CDSE_ACCESS_TOKEN`, `CDSE_SH_CLIENT_ID` and `CDSE_SH_CLIENT_SECRET` are preparation-only environment variables. Raw workbooks, source archives, COGs, FlatGeobuf files, Sentinel-2 GeoTIFFs, provenance sidecars and playground exports are ignored. Distribution checks reject credentials and local absolute source paths in `dist`.

For exact commands and source validation, see [Data pipeline](data-pipeline.md). For licensing and attribution, see [Third-party data](../THIRD_PARTY_DATA.md).
