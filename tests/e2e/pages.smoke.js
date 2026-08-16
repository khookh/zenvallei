import { expect, test } from "@playwright/test";

// Product-level regression inventory: content simplification may remove prose,
// but every established analytical chart and Expand action remains first-class.
const COMPARISON_CHART_INVENTORY = {
  "heat-income": { selectors: ["[data-heat-income-chart]:not(.is-expanded)"], expandActions: 1 },
  "heat-population": { selectors: ["[data-heat-population-box-chart]:not(.is-expanded)", "[data-heat-population-bar-chart]:not(.is-expanded)"], expandActions: 2 },
  "landsat-urban-atlas": { selectors: ["[data-comparison-chart]:not(.is-expanded)"], expandActions: 1 },
  "landsat-jaarbak": { selectors: ["[data-comparison-chart]:not(.is-expanded)", ".sealed-urban-scatter:not(.is-expanded)"], expandActions: 2 },
  "landsat-groenkaart": { selectors: [".sealed-urban-scatter:not(.is-expanded)"], expandActions: 1 },
  "groenkaart-income": { selectors: [".sealed-urban-scatter:not(.is-expanded)", ".income-temperature-box-chart:not(.is-expanded)"], expandActions: 2 },
  "landsat-income": { selectors: [".sealed-urban-scatter:not(.is-expanded)", ".income-temperature-box-chart:not(.is-expanded)"], expandActions: 2 },
  "groenkaart-population": { selectors: ["[data-green-population-chart]:not(.is-expanded) .population-temperature-step", "[data-green-population-chart]:not(.is-expanded) .population-temperature-bars"], expandActions: 2 },
  "jaarbak-income": { selectors: [".sealed-urban-scatter:not(.is-expanded)", ".income-temperature-box-chart:not(.is-expanded)"], expandActions: 2 },
  "jaarbak-population": { selectors: ["[data-green-population-chart]:not(.is-expanded) .population-temperature-step", "[data-green-population-chart]:not(.is-expanded) .population-temperature-bars"], expandActions: 2 },
  "landsat-population": {
    selectors: [
      "[data-green-population-chart]:not(.is-expanded) .population-temperature-step",
      "[data-green-population-chart]:not(.is-expanded) .population-temperature-bars",
    ],
    expandActions: 2,
  },
};

async function showControls(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel = page.locator("#detail-panel");
  const adaptive = await page.locator(".map-shell").getAttribute("data-surface-mode") !== "expanded";
  if (adaptive && await panel.getAttribute("aria-hidden") === "false") {
    await page.locator("#panel-close").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  await expect(page.locator("#map-controls-body")).toBeVisible();
}

async function showResults(page) {
  const panel = page.locator("#detail-panel");
  if (await panel.getAttribute("aria-hidden") === "false") return;
  await page.locator("#municipality-select").evaluate((element) => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(panel).toHaveAttribute("aria-hidden", "false");
}

async function rasterVisibility(page) {
  return page.evaluate(() => {
    const map = window.__heatMap.map;
    const visibility = (id) => map.getLayer(id) ? map.getLayoutProperty(id, "visibility") ?? "visible" : "missing";
    const prefixedVisibility = (prefix) => {
      const layer = map.getStyle().layers.find(({ id }) => id.startsWith(`${prefix}-`));
      return layer ? map.getLayoutProperty(layer.id, "visibility") ?? "visible" : "missing";
    };
    return {
      landsat: visibility("landsat-temperature-raster"),
      jaarbak: visibility("jaarbak-local-raster"),
      density: visibility("jaarbak-density-raster"),
      sealed: prefixedVisibility("landsat-jaarbak-sealed"),
    };
  });
}

async function activateComparison(page, fromLayer, targetLayer, testInfo) {
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator(`[data-layer="${fromLayer}"]`).click();
  await expect(page.locator(`[data-layer="${fromLayer}"]`)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  if (fromLayer === "groenkaart") {
    const actionPositions = await Promise.all([
      page.locator("#map-mode-action").boundingBox(),
      page.locator("#analysis-compare").boundingBox(),
    ]);
    expect(actionPositions.every(Boolean)).toBe(true);
    expect(Math.abs(actionPositions[0].y - actionPositions[1].y)).toBeLessThan(3);
  }
  await page.locator("#analysis-compare").click();
  await expect(page.locator(`[data-layer="${targetLayer}"]`)).toHaveClass(/is-comparison-target/);
  await page.locator(`[data-layer="${targetLayer}"]`).click();
  await expect(page.locator("#active-layer-title")).toContainText("×", { timeout: 20_000 });
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await expect(page.locator("#analysis-pair-result")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-layer="${fromLayer}"]`)).toHaveClass(/is-linked-comparison/);
  await expect(page.locator(`[data-layer="${targetLayer}"]`)).toHaveClass(/is-linked-comparison/);
}

async function removeComparison(page, restoredLayer, testInfo) {
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator("#analysis-pair-remove").click();
  await expect(page.locator(`[data-layer="${restoredLayer}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#analysis-pair-result")).toBeHidden();
}

test("serves the complete application below the GitHub Pages project path", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const failedOwnRequests = [];
  const ownResponses = [];
  const rangeResponses = [];
  page.on("response", (response) => {
    if (response.url().startsWith("http://127.0.0.1:4181/zenvallei/")) {
      ownResponses.push(response.url());
      if (response.status() >= 400) failedOwnRequests.push(`${response.status()} ${response.url()}`);
      if (response.url().endsWith(".pmtiles")) rangeResponses.push(response.status());
    }
  });

  await page.goto(".");
  await expect(page).toHaveURL(/\/zenvallei\/$/);
  await expect(page.locator("#project-intro")).toBeVisible();
  await expect(page.locator(".project-intro-heading img")).toHaveAttribute("src", "/zenvallei/assets/zennevallei-river-mark.png");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("[data-layer]")).toHaveCount(9);
  expect((await page.locator("[data-layer]").evaluateAll((elements) => elements.map((element) => element.dataset.layer))).sort())
    .toEqual(["groenkaart", "heat", "income", "jaarbak", "land-cover-scenario", "landgebruik", "landsat-temperature", "population", "urban-atlas"]);
  await expect(page.locator('[data-layer="land-cover"], [data-layer="vegetation"], [data-layer="tree-cover-density"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="notebook-test"]')).toHaveCount(0);
  await expect(page.locator("#visible-count")).toHaveText("154 sectors");
  await expect(page.locator("#map canvas")).toBeVisible();
  expect(ownResponses.some((url) => url.includes("urban-atlas.geojson"))).toBe(false);
  expect(ownResponses.some((url) => url.includes("land-cover-2020.png"))).toBe(false);
  expect(ownResponses.some((url) => url.includes("likely-vegetation-2020.png"))).toBe(false);

  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("http://127.0.0.1:4181");
  expect(policy).not.toContain("frame-ancestors");

  await page.locator("#project-intro-primary").click();
  await expect(page.locator("#analysis-compare")).toBeVisible();
  await expect(page.locator("#map-mode-action")).toBeHidden();
  await page.locator("#analysis-compare").click();
  await expect(page.locator('[data-layer="income"]')).toHaveClass(/is-comparison-target/);
  await expect(page.locator('[data-layer="population"]')).toHaveClass(/is-comparison-target/);
  await page.locator("#analysis-pick-cancel").click();
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveAttribute("aria-pressed", "true");
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await expect(page.locator("#analysis-compare")).toBeVisible();
  await expect(page.locator("#map-mode-action")).toBeHidden();
  expect(ownResponses.some((url) => url.includes("/zenvallei/data/urban-atlas.geojson"))).toBe(true);
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator('[data-layer="landsat-temperature"]').click();
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await expect(page.locator("#analysis-compare")).toBeVisible();
  await expect(page.locator("#analysis-compare")).toHaveText(/Compare/);
  for (const layerId of ["jaarbak", "groenkaart"]) {
    if (testInfo.project.name.includes("mobile")) await showControls(page);
    await page.locator(`[data-layer="${layerId}"]`).click();
    await expect(page.locator(`[data-layer="${layerId}"]`)).toHaveAttribute("aria-pressed", "true");
    if (testInfo.project.name.includes("mobile")) await showControls(page);
    await expect(page.locator("#map-mode-action")).toBeVisible();
    await expect(page.locator("#analysis-compare")).toBeVisible();
  }
  for (const layerId of ["population", "income"]) {
    if (testInfo.project.name.includes("mobile")) await showControls(page);
    await page.locator(`[data-layer="${layerId}"]`).click();
    await expect(page.locator(`[data-layer="${layerId}"]`)).toHaveAttribute("aria-pressed", "true");
    if (testInfo.project.name.includes("mobile")) await showControls(page);
    await expect(page.locator("#map-mode-action")).toBeHidden();
    await expect(page.locator("#analysis-compare")).toBeVisible();
  }
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator('[data-layer="landgebruik"]').click();
  await expect(page.locator("#map-mode-action")).toBeHidden();
  await expect(page.locator("#analysis-compare")).toBeHidden();
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator('[data-layer="population"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Population density");
  await expect(page.locator('[data-secondary-option="statbel-2025"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/population/population-grid-2025.geojson"))).toBe(true);
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator("#municipality-select").evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
  await expect(page.locator("#detail-panel")).toContainText("140,122");
  await expect(page.locator("#detail-panel")).toContainText("7.7 inhabitants/ha");
  await page.locator("#panel-close").click();
  await expect(page.locator('[data-secondary-option="flanders-2019"]')).toBeVisible();
  await page.locator('[data-secondary-option="flanders-2019"]').click();
  await expect(page.locator('[data-secondary-option="flanders-2019"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#layer-context-copy")).toContainText("uniform but older and modelled");
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator("#municipality-select").evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
  await expect(page.locator("#detail-panel")).toContainText("132,216");
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/population/population-density-2019.png"))).toBe(true);
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/official-layers/landsat-temperature/manifest.json"))).toBe(true);
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/official-layers/jaarbak/manifest.json"))).toBe(true);
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/official-layers/groenkaart/manifest.json"))).toBe(true);
  await expect.poll(() => ownResponses.some((url) => url.endsWith("/data/official-layers/landgebruik/manifest.json"))).toBe(true);
  await expect.poll(() => rangeResponses.includes(206)).toBe(true);
  const landsatManifest = await page.evaluate(async () => (await fetch("./data/official-layers/landsat-temperature/manifest.json")).json());
  expect(landsatManifest.timelineItems.map(({ value }) => value)).toEqual([
    "landsat-2020-08-07",
    "landsat-2022-08-14",
    "landsat-2023-06-13",
    "landsat-2023-09-09",
    "landsat-2025-08-13",
    "landsat-2026-06-22",
  ]);
  expect(landsatManifest.timelineItems.every(({ kind }) => kind === "heatwave")).toBe(true);
  expect(landsatManifest.timelineItems.some(({ value }) => value === "landsat-2020-08-16")).toBe(false);
  expect(ownResponses.some((url) => url.includes("/__local-data__/"))).toBe(false);
  expect(ownResponses.some((url) => url.includes("/landsat-urban-atlas/manifest.json")
    || url.includes("/landsat-jaarbak/manifest.json"))).toBe(false);

  if (!testInfo.project.name.includes("mobile")) {
    // Preserve a user's density preference while the comparison temporarily
    // forces JaarBAK's binary classification.
    await page.locator('[data-layer="jaarbak"]').click();
    await page.locator("#map-mode-action").click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ jaarbak: "none", density: "visible" });
    await page.locator('[data-layer="landsat-temperature"]').click();
    await page.locator("#analysis-compare").click();
    await expect(page.locator('[data-layer="urban-atlas"]')).toHaveClass(/is-comparison-target/);
    await expect(page.locator('[data-layer="jaarbak"]')).toHaveClass(/is-comparison-target/);
    await page.locator('[data-layer="urban-atlas"]').click();
    await expect(page.locator("#analysis-pair-label")).toContainText("Urban Atlas 2021");
    await expect.poll(() => ownResponses.some((url) => url.endsWith("/landsat-urban-atlas/manifest.json"))).toBe(true);
    await page.locator("#analysis-pair-change").click();
    await page.locator('[data-layer="jaarbak"]').click();
    await expect(page.locator("#analysis-pair-label")).toContainText("Soil sealing");
    await expect.poll(() => ownResponses.some((url) => url.endsWith("/landsat-jaarbak/manifest.json"))).toBe(true);
    await expect.poll(() => rasterVisibility(page), { timeout: 20_000 }).toEqual({
      landsat: "visible", jaarbak: "none", density: "none", sealed: "visible",
    });
    await page.locator("#analysis-pair-remove").click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ landsat: "visible", jaarbak: "none", sealed: "missing" });
    await page.locator('[data-layer="jaarbak"]').click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ jaarbak: "none", density: "visible" });
    await page.locator('[data-layer="landsat-temperature"]').click();
    await page.locator("#panel-close").click();
    // The panel closes with a short transition. Wait until it no longer covers
    // the map before moving the pointer, otherwise a slower CI runner can send
    // the single hover event to the departing panel instead of MapLibre.
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "true");
    await page.waitForTimeout(250);
    const point = await page.evaluate(() => {
      const projected = window.__heatMap.map.project([4.29, 50.73]);
      const rectangle = window.__heatMap.map.getCanvas().getBoundingClientRect();
      return { x: rectangle.left + projected.x, y: rectangle.top + projected.y };
    });
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".maplibregl-popup")).toContainText(/°C|cloud|missing/i, { timeout: 20_000 });
    expect(ownResponses.some((url) => url.endsWith("/landsat-temperature/query/landsat-2026-06-22.tif"))).toBe(true);
  }
  expect(failedOwnRequests).toEqual([]);
});

test("runs the land-cover scenario entirely in the compiled Pages build", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "The full public worker calculation is exercised once; mobile layout is covered separately.");
  test.setTimeout(180_000);
  const responses = [];
  const failures = [];
  page.on("response", (response) => {
    if (!response.url().startsWith("http://127.0.0.1:4181/zenvallei/")) return;
    responses.push(response.url());
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(".");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 60_000 });
  expect(responses.some((url) => url.includes("scenario-baseline-1m.tif"))).toBe(false);
  expect(responses.some((url) => url.includes("xgboost-inference-grid.bin.gz"))).toBe(false);
  await page.locator("#project-intro-primary").click();
  await page.locator('[data-layer="land-cover-scenario"]').click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe("land-cover-scenario");
  await expect.poll(() => responses.some((url) => url.includes("scenario-baseline-1m.tif")), { timeout: 60_000 }).toBe(true);
  expect(responses.some((url) => url.includes("xgboost-inference-grid.bin.gz"))).toBe(false);

  if (await page.locator("#detail-panel").getAttribute("aria-hidden") === "false") {
    await page.locator("#panel-close").click();
  }
  await showControls(page);
  await page.locator('[data-scenario-target="unseal"]').click();
  await page.locator("#scenario-draw").click();
  if (!await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  if (await page.locator("#legend").evaluate((element) => element.open)) {
    await page.locator("#legend summary").click();
  }
  await page.evaluate(() => {
    window.__heatMap.map.jumpTo({ center: [4.238, 50.737], zoom: 15 });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const points = await page.evaluate(() => {
    const map = window.__heatMap.map;
    const canvas = map.getCanvas();
    const rectangle = canvas.getBoundingClientRect();
    // Central Halle contains a stable mix of sealed and unsealed urban land,
    // so converting this small polygon always exercises a real public edit.
    const positions = [
      [4.236, 50.7355], [4.240, 50.7355], [4.240, 50.7385], [4.236, 50.7385],
    ].map((coordinate) => map.project(coordinate));
    if (!positions.every(({ x, y }) => document.elementFromPoint(rectangle.left + x, rectangle.top + y) === canvas)) return null;
    return positions.map(({ x, y }) => [rectangle.left + x, rectangle.top + y]);
  });
  expect(points).not.toBeNull();
  for (const [x, y] of points) await page.mouse.click(x, y);
  await showControls(page);
  await expect(page.locator("#scenario-finish")).toBeEnabled();
  await page.locator("#scenario-finish").click();
  await expect(page.locator("#scenario-editor-state")).toHaveText("Ready", { timeout: 90_000 });
  await expect.poll(() => responses.some((url) => url.includes("xgboost-inference-grid.bin.gz")), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => responses.some((url) => url.includes("xgboost-model.json"))).toBe(true);
  await expect(page.locator('[data-scenario-delta]')).toHaveAttribute("aria-pressed", "true");
  await showResults(page);
  await expect(page.locator("#detail-panel")).toContainText("Converted area");
  expect(failures).toEqual([]);
});

test("keeps classification visible when density loading fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "Repeated density transitions are covered on mobile by the complete smoke suite.");
  await page.route("**/groenkaart-2021-density.tif*", (route) => route.fulfill({
    status: 503, contentType: "text/plain", body: "temporary test failure",
  }));
  await page.goto(".");
  await page.locator("#project-intro-primary").click();
  await page.locator('[data-layer="groenkaart"]').click();
  await page.locator("#map-mode-action").click();
  await expect(page.locator("#map-mode-action")).not.toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => {
    const map = window.__heatMap.map;
    return {
      classification: map.getLayoutProperty("groenkaart-local-raster", "visibility"),
      density: map.getLayer("groenkaart-density-raster")
        ? map.getLayoutProperty("groenkaart-density-raster", "visibility")
        : "missing",
    };
  })).toEqual({ classification: "visible", density: "none" });
});

test("opens every public comparison from either participant and restores the initiating layer", async ({ page }, testInfo) => {
  // This intentionally exercises 22 lazy-loaded entry paths serially. Mobile
  // emulation is substantially slower on the shared GitHub runner than on a
  // developer machine, so keep the timeout scoped to this exhaustive matrix.
  test.setTimeout(480_000);
  await page.goto(".");
  await page.locator("#project-intro-primary").click();

  const cases = [
    ["heat", "income", "heat-income"],
    ["income", "heat", "heat-income"],
    ["heat", "population", "heat-population"],
    ["population", "heat", "heat-population"],
    ["landsat-temperature", "urban-atlas", "landsat-urban-atlas"],
    ["urban-atlas", "landsat-temperature", "landsat-urban-atlas"],
    ["landsat-temperature", "jaarbak", "landsat-jaarbak"],
    ["jaarbak", "landsat-temperature", "landsat-jaarbak"],
    ["landsat-temperature", "groenkaart", "landsat-groenkaart"],
    ["groenkaart", "landsat-temperature", "landsat-groenkaart"],
    ["groenkaart", "income", "groenkaart-income"],
    ["income", "groenkaart", "groenkaart-income"],
    ["landsat-temperature", "income", "landsat-income"],
    ["income", "landsat-temperature", "landsat-income"],
    ["groenkaart", "population", "groenkaart-population"],
    ["population", "groenkaart", "groenkaart-population"],
    ["landsat-temperature", "population", "landsat-population"],
    ["population", "landsat-temperature", "landsat-population"],
    ["jaarbak", "population", "jaarbak-population"],
    ["population", "jaarbak", "jaarbak-population"],
    ["jaarbak", "income", "jaarbak-income"],
    ["income", "jaarbak", "jaarbak-income"],
  ];

  for (const [fromLayer, targetLayer, comparisonId] of cases) {
    await activateComparison(page, fromLayer, targetLayer, testInfo);
    if (testInfo.project.name.includes("mobile")) await showResults(page);
    const inventory = COMPARISON_CHART_INVENTORY[comparisonId];
    for (const selector of inventory.selectors) await expect(page.locator(`#detail-panel ${selector}`).first()).toBeVisible();
    await expect(page.locator("#detail-panel [data-expand-comparison-chart]")).toHaveCount(inventory.expandActions);
    if (comparisonId === "heat-income") {
      await expect(page.locator("[data-heat-income-chart]:not(.is-expanded)")).toBeVisible();
    } else if (comparisonId === "heat-population") {
      await expect(page.locator("[data-heat-population-box-chart]:not(.is-expanded)")).toBeVisible();
    } else if (["landsat-groenkaart", "groenkaart-income", "landsat-income", "jaarbak-income"].includes(comparisonId)) {
      const chart = page.locator(".sealed-urban-scatter:not(.is-expanded)");
      await expect(chart).toBeVisible();
      if (comparisonId === "landsat-groenkaart") {
        await expect(chart.locator("canvas[data-pixel-scatter-canvas]")).toBeVisible();
        const scatterOutput = chart.locator("[data-scatter-output]");
        await expect(scatterOutput).toContainText(/eligible clear Landsat observations are plotted/);
        const plottedCount = Number((await scatterOutput.textContent())
          ?.match(/^([\d,]+) eligible clear Landsat observations/)?.[1].replaceAll(",", ""));
        expect(plottedCount).toBeGreaterThan(0);
      } else {
        await expect(chart.locator("[data-scatter-sector]").first()).toBeVisible();
      }
      if (comparisonId === "landsat-groenkaart" || comparisonId === "groenkaart-income") {
        await expect(page.locator("[data-density-class]")).toHaveCount(4);
      }
      await chart.locator("[data-expand-comparison-chart]").click();
      const expandedDialog = page.locator("[data-comparison-chart-dialog][open]");
      await expect(expandedDialog.locator(".sealed-urban-scatter.is-expanded")).toBeVisible();
      if (["landsat-income", "groenkaart-income", "jaarbak-income"].includes(comparisonId)) {
        await expect(expandedDialog.locator(".income-temperature-box-chart.is-expanded")).toHaveCount(0);
      }
      await expandedDialog.locator("[data-close-comparison-chart]").click();
      if (["landsat-income", "groenkaart-income", "jaarbak-income"].includes(comparisonId)) {
        await page.locator(`[data-dialog-target="${comparisonId}-income-boxes"]`).click();
        const boxDialog = page.locator(`[data-chart-dialog-id="${comparisonId}-income-boxes"][open]`);
        await expect(boxDialog.locator(".income-temperature-box-chart.is-expanded")).toHaveCount(1);
        await expect(boxDialog.locator(".sealed-urban-scatter.is-expanded")).toHaveCount(0);
        await expect(boxDialog).not.toContainText("Clear-pixel temperatures by income category");
        await boxDialog.locator("[data-close-comparison-chart]").click();
      }
    } else if (["groenkaart-population", "jaarbak-population"].includes(comparisonId)) {
      await expect(page.locator("#secondary-control")).toBeHidden();
      const charts = page.locator("[data-green-population-chart]:not(.is-expanded)");
      await expect(charts).toHaveCount(2);
      await expect(charts.first().locator("[data-green-population-group]").first()).toBeVisible();
      await expect(page.locator("#legend-content .legend-continuous-scale").first())
        .toHaveAttribute("aria-label", comparisonId === "groenkaart-population"
          ? /vegetation cover within 100 m/i : /soil-sealing density/i);
      await expect(page.locator("#legend-content .legend-comparison-section"))
        .toContainText(/Population density|Modelled inhabitants per hectare/);
      for (const target of [`${comparisonId}-cumulative`, `${comparisonId}-histogram`]) {
        await page.locator(`[data-dialog-target="${target}"]`).click();
        const dialog = page.locator(`[data-chart-dialog-id="${target}"][open]`);
        await expect(dialog.locator("[data-green-population-chart].is-expanded")).toBeVisible();
        await dialog.locator("[data-close-comparison-chart]").click();
      }
    } else if (comparisonId === "landsat-population") {
      await expect(page.locator("#secondary-control")).toBeHidden();
      const charts = page.locator("[data-green-population-chart]:not(.is-expanded)");
      await expect(charts).toHaveCount(2);
      await expect(charts.nth(0).locator(".population-temperature-step")).toBeVisible();
      await expect(charts.nth(1).locator(".population-temperature-bars")).toBeVisible();
      const thermalStops = page.locator("#legend-content .legend-scale .legend-score");
      await expect(thermalStops).toHaveCount(9);
      await expect(thermalStops.first()).toHaveText("15");
      await expect(thermalStops.last()).toHaveText("50");
      await expect(page.locator("#legend-content .legend-comparison-section"))
        .toContainText(/Population density|Modelled inhabitants per hectare/);
      for (const target of ["landsat-population-cumulative", "landsat-population-histogram"]) {
        await page.locator(`[data-dialog-target="${target}"]`).click();
        const openDialog = page.locator(`[data-chart-dialog-id="${target}"][open]`);
        await expect(openDialog.locator("[data-green-population-chart].is-expanded"))
          .toBeVisible();
        // Close the currently mounted dialog atomically. A late comparison
        // source refresh can replace the panel DOM after the visibility check.
        await page.evaluate((dialogId) => {
          document.querySelector(`[data-chart-dialog-id="${dialogId}"][open]`)?.close();
        }, target);
        await expect(openDialog).not.toBeVisible();
      }
    } else {
      await expect(page.locator("[data-expand-comparison-chart]").first()).toBeVisible();
    }
    await removeComparison(page, fromLayer, testInfo);
  }
});
