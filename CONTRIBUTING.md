# Contributing

Choose the smallest path that matches the change.

## Documentation or copy

Edit the concise guide nearest to the code. Keep facts about a product in
`docs/data-reference.md`, not in several feature guides. English and Dutch UI
copy must change together.

## Scientific or data-processing change

The production geospatial pipeline is Python under `processing/local-layers`.
JavaScript is not required to change an existing source, mask, aggregation,
statistic or model diagnostic.

```powershell
pnpm local-data:setup
processing\local-layers\.venv\Scripts\greenwave-local-layers.exe --list
processing\local-layers\.venv\Scripts\greenwave-local-layers.exe --describe landsat-jaarbak
pnpm local-data:test
```

Read the [Python preparation guide](processing/local-layers/README.md) before
changing a scientific contract. Add a frozen, small fixture for the numerical
rule; large official inputs stay outside Git.

## New browser presentation

A new visual layer or comparison needs a small adapter under `src/layers` or
`src/comparisons`, a registry entry, English and Dutch labels, and browser
tests. See [the frontend structure](src/README.md). Keep scientific processing
in Python or the existing preparation scripts rather than recreating it in the
browser.

## Definition of done

- Source authority, year, units, masks and aggregation remain explicit.
- Categorical rasters use nearest-neighbour resampling; continuous rasters use
  a documented method.
- Missing/cloud/nodata values never become zeros silently.
- Generated assets pass `pnpm data:validate` and contain no credentials or
  local paths.
- English and Dutch catalogues remain in parity.
- Relevant unit and browser tests pass; run `pnpm verify` before release.

Comment why a non-obvious constraint exists—especially CRS alignment, area
weighting, spatial validation and security boundaries. Do not comment code that
is already clear from its names.
