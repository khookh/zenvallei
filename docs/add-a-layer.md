# Add a map layer

A normal new layer needs one prepared asset, one JavaScript module, translation keys, one registry entry and tests. It should not require changes to `main.js`, `map-controller.js` or `panel.js`.

## 1. Prepare a browser asset

Write a small manifest to `public/data/tree-canopy.json` and, for a polygon layer, a matching GeoJSON file. Statistics should be keyed by the existing Statbel `sectorId`.

```json
{
  "schemaVersion": 1,
  "available": true,
  "geojsonUrl": "data/tree-canopy.geojson",
  "classes": [
    { "id": "low", "labelKey": "treeCanopy.class.low", "color": "#d9f0d3" },
    { "id": "high", "labelKey": "treeCanopy.class.high", "color": "#006d2c" }
  ],
  "sectorStats": {
    "23003A001": { "percentage": 28.4, "classId": "high" }
  }
}
```

Validate identifiers, coordinate system, class codes and sector coverage during preparation. Do not calculate expensive geometry intersections in the browser.

## 2. Create the layer module

Use the existing heat, Urban Atlas and Landsat temperature modules as working examples. A polygon module follows this shape:

```js
import { t } from "../i18n.js";
import { defineLayer } from "./layer-contract.js";

export function createTreeCanopyLayer({ manifest }) {
  const sourceId = "tree-canopy-source";
  const mapLayerId = "tree-canopy-fill";
  let dataPromise = null;

  return defineLayer({
    id: "tree-canopy",
    isAvailable: () => Boolean(manifest?.available && manifest.geojsonUrl),
    getLabel: () => t("layers.treeCanopy"),
    getDatasetStatus: () => t("dataset.readyTreeCanopy"),
    getContext: () => ({
      meta: t("treeCanopy.contextMeta"),
      text: t("treeCanopy.contextText"),
    }),
    getLegendModel: () => ({
      title: t("treeCanopy.legend"),
      layout: "groups",
      groups: [{
        items: manifest.classes.map((entry) => ({
          label: t(entry.labelKey),
          color: entry.color,
        })),
      }],
    }),
    getPopupModel: (feature) => ({
      title: feature.properties.sectorName,
      subtitle: feature.properties.municipality,
      lines: [`${manifest.sectorStats[feature.properties.sectorId]?.percentage ?? 0}%`],
    }),
    getPanelModel: (record) => ({
      template: "metric-summary",
      record,
      title: t("treeCanopy.panelTitle"),
      value: manifest.sectorStats[record.sectorId]?.percentage,
    }),
    async mount(map, { beforeLayerId }) {
      if (map.getLayer(mapLayerId)) return true;
      dataPromise ??= fetch(manifest.geojsonUrl).then((response) => response.json());
      const data = await dataPromise;
      map.addSource(sourceId, { type: "geojson", data });
      map.addLayer({
        id: mapLayerId,
        type: "fill",
        source: sourceId,
        layout: { visibility: "none" },
        paint: { "fill-color": "#238b45", "fill-opacity": 0.68 },
      }, beforeLayerId);
      return true;
    },
    setVisible(map, visible) {
      if (map.getLayer(mapLayerId)) {
        map.setLayoutProperty(mapLayerId, "visibility", visible ? "visible" : "none");
      }
    },
    applyFilter(map, filter) {
      if (map.getLayer(mapLayerId)) map.setFilter(mapLayerId, filter);
    },
  });
}
```

Add a reusable panel template only when existing templates cannot express the new statistics. Keep HTML and focus behaviour in the UI renderer, not in the dataset module.

## 3. Register and translate

Import the factory in `src/layers/registry.js`, create the module from loaded data and add it to the registry array. Add identical keys to `src/i18n/nl.js` and `src/i18n/en.js`.

If the manifest is a new top-level asset, load and validate it in `src/data.js` and `src/data-validation.js`.

## 4. Test the contract

At minimum, test:

- schema and sector-ID validation;
- unique layer ID and complete translation keys;
- exact palette and legend entries;
- unavailable and corrupt asset behaviour;
- municipality filtering;
- popup and panel values in Dutch and English;
- lazy loading and switching without losing viewport or selection.

Run `pnpm verify:quick` during development and `pnpm verify` before handing over the layer.
