# Third-party data and services

The MIT licence applies to Greenwave source code. It does not relicense upstream data, derived browser assets, map tiles, names or logos.

## Government of Flanders, Department of Care

Used for the 2026 heat, vulnerability, final and indicator scores.

- Source: [Heat vulnerability map and downloads](https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen)
- Generated assets: `scores.json` and parts of `methodology.json` and `provenance.json`.
- Application attribution: Government of Flanders, Department of Care.

Publication gate: the download page makes the workbook publicly available but did not state a dataset-specific open-data licence when checked on 5 August 2026. General Flemish rules allow reuse subject to the conditions selected by the publishing authority. Confirm the applicable licence or obtain written reuse confirmation before pushing the derived score asset to a public repository. Until then, public-repository readiness does not itself authorise publication.

Useful official context: [reuse of government information](https://www.vlaanderen.be/digitaal-vlaanderen/recht-op-hergebruik-van-overheidsinformatie) and [Flemish model licences](https://www.vlaanderen.be/digitaal-vlaanderen/onze-diensten-en-platformen/open-data/voorwaarden-voor-het-hergebruik-van-overheidsinformatie).

## Statbel

Used for the compatible 2024 statistical-sector codes, Dutch names and boundaries.

- Source: [Statistical sectors 2024](https://statbel.fgov.be/en/open-data/statistical-sectors-2024)
- Generated assets: `sectors.geojson`, geometry provenance and the dissolved white silhouette in `public/assets/zennevallei-river-mark.png`. The blue river curve is a stylised Greenwave brand element, not hydrographic data.
- Application attribution: Statbel, statistical sectors dated 1 January 2024.

Statbel states that its open data can be used freely, without charge or restriction, for commercial and non-commercial purposes. See [Statbel Open Data](https://statbel.fgov.be/en/open-data).

## Copernicus Land Monitoring Service

Used for LCM-10 2020 and Urban Atlas 2021.

- LCM-10 DOI: <https://doi.org/10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9>
- Urban Atlas DOI: <https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a>
- Generated assets: the land-cover PNG and manifest, and the clipped Urban Atlas GeoJSON and manifest.

CLMS provides full, open and free access, requires source attribution, requires modifications to be identified and prohibits implying EU endorsement. Greenwave displays the required derivative acknowledgement:

> Generated using European Union's Copernicus Land Monitoring Service information.

See the [CLMS data policy](https://land.copernicus.eu/en/data-policy). The provenance manifests record DOIs, product identifiers, access dates and processing details.

## Copernicus Sentinel-2

Used for the selected 2020 L2A NDVI observation in the public likely-vegetation indication. Selected observations from 2015 through 2026 may remain in the ignored local research cache.

- Source collection: Sentinel-2 L2A through the Copernicus Data Space Sentinel Hub Process API.
- Input products: the paired T31UFS and T31UES products recorded for every selected observation in `.cache/vegetation/selection.json` and `vegetation.json`.
- Generated assets: one full-region and seven municipality-specific PNG files for 2020, plus `vegetation.json`.
- Application attribution: Derived using European Union Copernicus Sentinel-2 information.

Greenwave calculates NDVI, applies the Sentinel scene-classification mask, calibrates a threshold against Urban Atlas reference classes and aggregates areas by Statbel sector. The result is identified as a derived, single-date vegetation indication and not as an official Copernicus land-cover product.

## OpenStreetMap

Used only as the configurable runtime basemap. Greenwave does not package OSM tiles.

- Attribution: © OpenStreetMap contributors.
- Licence information: [OpenStreetMap copyright and ODbL](https://www.openstreetmap.org/copyright).
- Tile-service conditions: [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

The standard community tile service is intended only for modest local use. Configure an appropriate managed or self-hosted OSM-derived service before public traffic.

## Software dependencies

Third-party JavaScript packages retain their own licences. `pnpm-lock.yaml` records the resolved dependency graph. SheetJS is installed from its official 0.20.3 distribution because the public npm registry copy is stale; its URL and integrity are pinned by the lockfile.
