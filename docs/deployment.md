# Deployment

GitHub Pages serves a static `/zenvallei/` build. The land-cover scenario runs
entirely in a browser worker from immutable, hash-recorded public derivatives.
Python caches, raw sources and runtime edits are not part of the distribution.

## Release gate

Run from a clean worktree with Node.js 24 and pnpm 11:

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm test:local-data
pnpm test:e2e:cross-browser
pnpm build:pages
```

Inspect the public-data app, local-data app and Pages preview in a real browser.
Exercise all layers/comparisons, English/Dutch, desktop/mobile, temporal states,
expanded charts and scenario interactions. Console errors, failed requests,
unexplained screenshot changes or numerical mismatches block release.

## Publish data

Only run this after the relevant Python preparation and validation pass:

```powershell
pnpm official-layers:publish
pnpm data:validate
```

The publisher copies an explicit allow-list from `.cache/local-layers` into
`public/data/official-layers`. Distribution checks reject local paths, signed
URLs, credentials and local endpoints. Scenario publication is separately
allow-listed and capped at 90 MiB; the complete official bundle is capped at
650 MiB.

## Deploy Pages

Push the already-tested commit to `main`, then manually dispatch
`.github/workflows/pages.yml`. The workflow repeats Python, JavaScript, browser,
security and subpath-build checks before deploying. Verify the workflow's SHA
matches `main`, then smoke-test <https://khookh.github.io/zenvallei/> and inspect
its browser console/network activity.

Do not patch a failed deployment in place. Correct it locally, repeat the full
release gate and deploy the newly tested commit.
