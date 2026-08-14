# Browser application structure

The browser consumes validated JSON, GeoJSON, PMTiles, PNG and GeoTIFF
derivatives. Scientific preparation belongs upstream; this directory handles
selection, rendering and interaction.

| Location | Responsibility |
| --- | --- |
| `data.js` | Load public or local manifests and core sector data |
| `layers/` | One map adapter per displayed product |
| `comparisons/` | Build map and panel models for the nine supported pairings |
| `panel.js`, `panel-shell.js` | Render result content and manage dialogs/focus |
| `map-controller.js` | Shared MapLibre source/layer lifecycle |
| `main.js` | Compose controls, layer selection and comparison/scenario workflows |
| `i18n/` | Complete English and Dutch catalogues |

Layer modules implement the contract in `layers/layer-contract.js`. Shared map
code must not know product-specific classes or palettes. Comparisons are listed
once in `comparison-pairs.js` and can be entered from either participating
layer.

To expose a new prepared product:

1. Validate and document its browser manifest.
2. Add a layer adapter and registry entry.
3. Add bilingual labels, legend and result-panel model.
4. Add unit tests and a real browser route covering load, selection and errors.

External text is escaped and external URLs pass through `safeExternalUrl`.
Local analytical endpoints and model files must never enter a Pages build.
