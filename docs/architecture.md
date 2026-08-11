# Architecture

Greenwave is a static application. Data preparation runs before deployment and the browser never receives source credentials.

```text
Official workbook / geometry / raster / polygons / satellite observation
                  |
                  v
        scripts/prepare-*.mjs
                  |
                  v
      validated public/data assets
                  |
                  v
       src/data.js + schema checks
                  |
                  v
          layer registry modules
           /               \
   MapLibre controller     panel/legend UI
```

## Runtime responsibilities

- `main.js` owns session-only state and coordinates controls.
- `map-controller.js` owns the basemap, viewport, Statbel selection geometry and generic layer lifecycle.
- `src/layers` owns dataset meaning, palette, lazy loading, popup content and sector-panel models.
- `aggregate-statistics.js` derives area-weighted municipality summaries from the prepared sector records.
- `panel.js`, `panel-shell.js` and `legend.js` turn plain presentation models into accessible UI. The shell owns focus and responsive disclosure state; content modules own safe rendering.
- `i18n.js` is the stable translation API; the Dutch and English catalogues are separate files with identical keys.

The map controller deliberately does not decide what an Urban Atlas, Landsat or heat value means. It asks the active layer module to load, display, filter and describe itself.

## Preparation boundary

- Commands in `scripts/prepare-*.mjs` are CLI entry points.
- Reusable geospatial and statistical functions live in `scripts/lib`.
- Preparation writes only browser-ready assets and provenance to `public/data`.
- Public vector layers use a municipality filter directly. Local raster layers provide complete-region and municipality-specific PMTiles variants.
- Runtime code never imports preparation modules.
- Preparation modules never import UI code.
- The standalone Python playground is a separate research boundary. It may read official sources and Statbel geometry, but its raw caches and experimental Test exports remain outside `public` and `dist`.
- `processing/local-layers` is an isolated Python boundary for Landsat temperature, Soil sealing (official product: JaarBAK), Groenkaart and Landgebruik. Runtime startup reads only a lightweight catalogue; each full manifest and PMTiles archive is loaded on first activation and cached in memory. Local-data mode serves the preparation cache through allow-listed endpoints. Static builds use the validated derivatives under `public/data/official-layers`. Landsat pixel inspection reads a small clipped query raster in the browser; raw source windows remain private.
- Comparison modules are separate from the top-level layer registry. One explicit nine-pair table supports Heat with income or population; Landsat with Urban Atlas, Soil sealing, Green Map, income or population; and Green Map with income or population. Either participant discovers the same canonical comparison; the coordinator switches to that presentation and restores the initiating layer when it is removed. Prepared comparison assets are lazy and use catalogue schema 3 in local and static builds.
- Comparisons that need an exact footprint share one focused raster-composition module. It reads the same Soil sealing PMTiles as the standalone layer and an indexed PMTiles mask rasterised from the original Urban Atlas polygons. This is display composition only: Green Map focal cover remains a 10 m calculation, Landsat charts remain 30 m observations and the population comparison remains 100 m model cells.

Every JSON manifest has a `schemaVersion`. Missing versions are temporarily interpreted as version 1 for older generated files. Unsupported versions fail during data loading with a readable error.

## Layer contract

Each module registered in `src/layers/registry.js` provides:

- identity, translated label and first-glance context;
- availability and optional secondary controls;
- an optional temporal control for discrete years or semantic observation timelines;

The normal registry contains heat vulnerability, Landsat temperature, Urban Atlas, Soil sealing, Flanders Green Map, Flanders land use, population density and Statbel income. Local-data mode resolves the same prepared raster modules from the ignored working catalogue. Retired experiments remain outside the registry and are not shipped.
- lazy `mount`, visibility and municipality-filter functions;
- plain legend, popup and panel models;
- attribution entries.

`defineLayer` validates the contract and the registry rejects duplicate IDs. Existing MapLibre IDs used by browser diagnostics remain stable.

## When to revisit this architecture

Keep the current static GeoJSON approach while the application covers Zennevallei. Evaluate PMTiles or vector tiles when expanding geographically, when a single browser GeoJSON exceeds 25 MB, or when measured first activation cannot meet the 1.5-second target.

A component framework is not needed for the current UI. Reconsider one only if many unrelated interactive views require their own complex lifecycle. The plain state and presentation models keep that later migration possible.
