import { expect, test } from "@playwright/test";

async function showControls(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel = page.locator("#detail-panel");
  const adaptive = await page.locator(".map-shell").getAttribute("data-surface-mode") !== "expanded";
  if (adaptive && await panel.getAttribute("aria-hidden") === "false"
    && !await panel.evaluate((element) => element.classList.contains("is-peek"))) {
    await page.locator("#panel-toggle").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  await expect(page.locator("#map-controls-body")).toBeVisible();
}

async function showResults(page) {
  const panel = page.locator("#detail-panel");
  if (!await panel.evaluate((element) => element.classList.contains("is-peek"))) return;
  if (!await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await panel.evaluate((element) => element.classList.contains("is-peek"))) {
    await expect(page.locator("#panel-peek")).toBeVisible();
    await page.locator("#panel-peek").click();
  }
}

async function rasterVisibility(page) {
  return page.evaluate(() => {
    const map = window.__heatMap.map;
    const visibility = (id) => map.getLayer(id) ? map.getLayoutProperty(id, "visibility") ?? "visible" : "missing";
    return {
      landsat: visibility("landsat-temperature-raster"),
      jaarbak: visibility("jaarbak-local-raster"),
      density: visibility("jaarbak-density-raster"),
      sealed: visibility("landsat-jaarbak-sealed"),
      comparison: visibility("landsat-jaarbak-temperature"),
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
  await expect(page.locator("[data-layer]")).toHaveCount(8);
  expect((await page.locator("[data-layer]").evaluateAll((elements) => elements.map((element) => element.dataset.layer))).sort())
    .toEqual(["groenkaart", "heat", "income", "jaarbak", "landgebruik", "landsat-temperature", "population", "urban-atlas"]);
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
  await page.locator("#reset-view").click();
  await expect(page.locator("#detail-panel")).toContainText("140,122");
  await expect(page.locator("#detail-panel")).toContainText("7.7 inhabitants/ha");
  await page.locator("#panel-close").click();
  await expect(page.locator('[data-secondary-option="flanders-2019"]')).toBeVisible();
  await page.locator('[data-secondary-option="flanders-2019"]').click();
  await expect(page.locator('[data-secondary-option="flanders-2019"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#layer-context-copy")).toContainText("100 m cell");
  if (testInfo.project.name.includes("mobile")) await showControls(page);
  await page.locator("#reset-view").click();
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
      landsat: "none", jaarbak: "none", density: "none", sealed: "visible", comparison: "visible",
    });
    await page.locator("#analysis-pair-remove").click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ landsat: "visible", jaarbak: "none", sealed: "missing", comparison: "missing" });
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
  test.setTimeout(300_000);
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
  ];

  for (const [fromLayer, targetLayer, comparisonId] of cases) {
    await activateComparison(page, fromLayer, targetLayer, testInfo);
    if (testInfo.project.name.includes("mobile")) await showResults(page);
    if (comparisonId === "heat-income") {
      await expect(page.locator("[data-heat-income-chart]:not(.is-expanded)")).toBeVisible();
    } else if (comparisonId === "heat-population") {
      await expect(page.locator("[data-heat-population-box-chart]:not(.is-expanded)")).toBeVisible();
    } else if (["landsat-groenkaart", "groenkaart-income", "landsat-income"].includes(comparisonId)) {
      const chart = page.locator(".sealed-urban-scatter:not(.is-expanded)");
      await expect(chart).toBeVisible();
      if (comparisonId === "landsat-groenkaart") {
        await expect(chart.locator("canvas[data-pixel-scatter-canvas]")).toBeVisible();
        await expect(page.locator("#detail-panel")).toContainText(/eligible clear Landsat pixels are plotted/);
        await expect(page.locator("#detail-panel")).not.toContainText("0 eligible clear Landsat pixels are plotted");
      } else {
        await expect(chart.locator("[data-scatter-sector]").first()).toBeVisible();
      }
      if (comparisonId !== "landsat-income") {
        await expect(page.locator("[data-density-class]")).toHaveCount(4);
      }
      await chart.locator("[data-expand-comparison-chart]").click();
      await expect(page.locator("[data-comparison-chart-dialog] .sealed-urban-scatter.is-expanded")).toBeVisible();
      await page.locator("[data-comparison-chart-dialog] [data-close-comparison-chart]").click();
    } else {
      await expect(page.locator("[data-expand-comparison-chart]")).toBeVisible();
    }
    await removeComparison(page, fromLayer, testInfo);
  }
});
