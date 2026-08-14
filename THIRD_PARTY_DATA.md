# Third-party data and services

The MIT licence applies to the source code. It does not relicense upstream data, derived assets, map tiles, names or logos.

## Department of Care, Government of Flanders

The 2026 heat, vulnerability, final and indicator scores come from the [Heat vulnerability map](https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen). `scores.json`, `methodology.json` and `provenance.json` retain that authority and attribution. No official score is recalculated.

## Statbel

[Statistical sectors 2024](https://statbel.fgov.be/en/open-data/statistical-sectors-2024) supply compatible sector identifiers, Dutch names and boundaries. Derived files are `sectors.geojson`, geometry provenance and the white header silhouette. The blue river is a stylised brand element, not hydrographic data.

[Fiscal statistics by statistical sector](https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector) supply median and average net taxable income per declaration and published interquartile indicators for 2019-2023. `income.json` preserves the source values and missing states under Statbel's CC BY 4.0 terms. The application does not reconstruct an income distribution or calculate municipality medians from sector medians.

[The variable population grid 2025](https://statbel.fgov.be/en/themes/datalab/variable-cell-grid) supplies privacy-protected cells from 125 m to 1 km. The compatible 2025 statistical-sector table supplies exact selected-area totals. `population.json` keeps both roles separate and records Statbel's confidentiality-related displacement rules.

## Department of Environment & Spatial Development, Government of Flanders

[Population density per hectare, 2019](https://www.vlaanderen.be/datavindplaats/catalogus/inwonersdichtheid-per-ha-vlaanderen-toestand-2019) supplies the historical 100 m model. The displayed raster preserves its values; result panels use the matching Statbel 2019 sector population rather than reconstructing totals from model cells.

## Copernicus Urban Atlas

Urban Atlas 2021 FUA BE001L3 supplies the public land-cover and land-use polygons. DOI: <https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a>. Derived assets identify modifications and display the required European Union Copernicus acknowledgement. See the [CLMS data policy](https://land.copernicus.eu/en/data-policy).

## Official raster sources

- [JaarBAK](https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023), Department of Environment & Spatial Development, Government of Flanders, via MercatorNet.
- [Groenkaart Vlaanderen](https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021), Agentschap voor Natuur en Bos / Digitaal Vlaanderen. The local attribution uses `Bron: ANB`.
- [Landsat Collection 2 surface temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature), NASA/USGS. [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/) provides COG access only.
- [Landgebruik Vlaanderen](https://www.vlaanderen.be/datavindplaats/catalogus/landgebruik-vlaanderen-toestand-2025), Department of Environment & Spatial Development, Government of Flanders.
- [Landbouwgebruikspercelen 2025](https://www.vlaanderen.be/datavindplaats/catalogus/landbouwgebruikspercelen-2025), Agency for Agriculture and Fisheries, Government of Flanders.
- [Royal Meteorological Institute of Belgium heatwave periods and definition](https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel) (RMI; KMI in Dutch).

Raw source rasters and analytical caches remain ignored. The validated clipped browser derivatives required by the active layers are distributed through GitHub Pages with their source attribution.

## Sentinel-2 research playground

The standalone Python playground can request Sentinel-2 L2A bands through Copernicus Data Space. Its raw files and experimental outputs stay in ignored caches and are not active public datasets.

## Radoux land-cover temperature model

The local-only scenario uses the land-cover linear mixture coefficients and thermal point-spread method documented by Radoux et al. (2025), [*Land Cover Types Drive the Surface Temperature for Upscaling Surface Urban Heat Islands with Daylight Images*](https://doi.org/10.3390/rs17162815). The implementation identifies high and low Green Map classes as documented proxies for the paper's broadleaf-tree and permanent-herbaceous classes. It estimates a change in daytime land-surface temperature, not air temperature, and does not relicense the paper or its underlying Walloon data.

An optional local XGBoost model is trained only from the already documented NASA/USGS Landsat 22 June 2026 observation, Green Map 2021, Urban Atlas 2021 and Soil sealing 2024 sources. Its cached model is not public data and is excluded from normal and GitHub Pages distributions.

A second optional local XGBoost model uses the same documented land-cover sources and the strict arithmetic mean of the six documented clear Landsat heatwave acquisitions from 2020–2026. Every retained location requires all six values. Its target catalog, model, held-out predictions and baseline inference cache are local derived artifacts and are likewise excluded from distributions.

## OpenStreetMap

The configured basemap uses standard OpenStreetMap tiles for this modest POC and displays `© OpenStreetMap contributors`. Tiles are neither packaged nor prefetched. See [copyright and ODbL](https://www.openstreetmap.org/copyright) and the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Software

The local comparison view vendors fixed colour samples derived from the MIT-licensed [cmocean 4.0.3 thermal palette](https://matplotlib.org/cmocean/). Dependencies retain their own licences. `pnpm-lock.yaml` and the Python lock constraints record the exact dependency graph.
