# Third-party data and services

The MIT licence applies to the source code. It does not relicense upstream data, derived assets, map tiles, names or logos.

## Department of Care, Government of Flanders

The 2026 heat, vulnerability, final and indicator scores come from the [Heat vulnerability map](https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen). `scores.json`, `methodology.json` and `provenance.json` retain that authority and attribution. No official score is recalculated.

## Statbel

[Statistical sectors 2024](https://statbel.fgov.be/en/open-data/statistical-sectors-2024) supply compatible sector identifiers, Dutch names and boundaries. Derived files are `sectors.geojson`, geometry provenance and the white header silhouette. The blue river is a stylised brand element, not hydrographic data.

[Fiscal statistics by statistical sector](https://statbel.fgov.be/en/open-data/fiscal-statistics-income-statistical-sector) supply median and average net taxable income per declaration and published interquartile indicators for 2019-2023. `income.json` preserves the source values and missing states under Statbel's CC BY 4.0 terms. The application does not reconstruct an income distribution or calculate municipality medians from sector medians.

## Copernicus Urban Atlas

Urban Atlas 2021 FUA BE001L3 supplies the public land-cover and land-use polygons. DOI: <https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a>. Derived assets identify modifications and display the required European Union Copernicus acknowledgement. See the [CLMS data policy](https://land.copernicus.eu/en/data-policy).

## Local official sources

- [JaarBAK](https://www.vlaanderen.be/datavindplaats/catalogus/jaarlijkse-bodemafdekkingskaart-jaarbak-1-m-resolutie-2023), Department of Environment & Spatial Development, Government of Flanders / MercatorNet.
- [Groenkaart Vlaanderen](https://www.vlaanderen.be/datavindplaats/catalogus/groenkaart-vlaanderen-2021), Agentschap voor Natuur en Bos / Digitaal Vlaanderen. The local attribution uses `Bron: ANB`.
- [Landsat Collection 2 surface temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature), NASA/USGS. [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/) provides COG access only.
- [Landgebruik Vlaanderen](https://www.vlaanderen.be/datavindplaats/catalogus/landgebruik-vlaanderen-toestand-2025), Department of Environment & Spatial Development, Government of Flanders.
- [Landbouwgebruikspercelen 2025](https://www.vlaanderen.be/datavindplaats/catalogus/landbouwgebruikspercelen-2025), Agency for Agriculture and Fisheries, Government of Flanders.
- [Royal Meteorological Institute of Belgium (RMI/KMI) heatwave periods and definition](https://www.meteo.be/nl/klimaat/klimaatverandering-in-belgie/klimaattrends-in-ukkel/luchttemperatuur/zomer-indices/hittegolven/hittegolven-in-ukkel).

Their rasters, analytical derivatives and PMTiles are ignored local research inputs and are not distributed by GitHub Pages.

## Sentinel-2 research playground

The standalone Python playground can request Sentinel-2 L2A bands through Copernicus Data Space. Its raw files and experimental outputs stay in ignored caches and are not active public datasets.

## OpenStreetMap

The configured basemap uses standard OpenStreetMap tiles for this modest POC and displays `© OpenStreetMap contributors`. Tiles are neither packaged nor prefetched. See [copyright and ODbL](https://www.openstreetmap.org/copyright) and the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Software

Dependencies retain their own licences. `pnpm-lock.yaml` and the Python lock constraints record the exact dependency graph.
