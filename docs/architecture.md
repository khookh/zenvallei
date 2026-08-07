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
- `panel.js` and the legend renderer turn plain presentation models into accessible UI.
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
- `processing/local-layers` is an isolated Python boundary for Landsat temperature, JaarBAK, Groenkaart and Landgebruik. Local startup reads only a lightweight catalogue; each full manifest and PMTiles archive is loaded on first activation and cached in memory. Only Vite dev or preview in `local-data` mode can serve allow-listed ignored files through same-origin endpoints. Landsat pixel inspection reads analytical rasters server-side; TIFF files are never served directly. Ordinary and Pages builds cannot reference these endpoints.

Every JSON manifest has a `schemaVersion`. Missing versions are temporarily interpreted as version 1 for older generated files. Unsupported versions fail during data loading with a readable error.

## Layer contract

Each module registered in `src/layers/registry.js` provides:

- identity, translated label, status and first-glance context;
- availability and optional secondary controls;
- an optional temporal control for discrete years or semantic observation timelines;

The normal registry contains heat vulnerability, Urban Atlas and Statbel income. Local-data mode can add Landsat temperature, JaarBAK, Groenkaart and Landgebruik from the ignored catalogue. Retired experiments remain outside the registry and are not shipped.
- lazy `mount`, visibility and municipality-filter functions;
- plain legend, popup and panel models;
- attribution entries.

`defineLayer` validates the contract and the registry rejects duplicate IDs. Existing MapLibre IDs used by browser diagnostics remain stable.

## When to revisit this architecture

Keep the current static GeoJSON approach while the application covers Zennevallei. Evaluate PMTiles or vector tiles when expanding geographically, when a single browser GeoJSON exceeds 25 MB, or when measured first activation cannot meet the 1.5-second target.

A component framework is not needed for the current UI. Reconsider one only if many unrelated interactive views require their own complex lifecycle. The plain state and presentation models keep that later migration possible.
