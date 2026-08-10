import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

async function expandControls(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const adaptive = await page.locator(".map-shell").getAttribute("data-surface-mode") !== "expanded";
  const panel = page.locator("#detail-panel");
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

async function closePanelIfOpen(page) {
  const panel = page.locator("#detail-panel");
  if (await panel.getAttribute("aria-hidden") === "true") return;
  await expect(page.locator("#panel-close")).toBeVisible();
  await page.locator("#panel-close").click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
}

async function expandComparisonLegend(page) {
  const legend = page.locator("#legend");
  if (!await legend.evaluate((element) => element.open)) {
    const panel = page.locator("#detail-panel");
    if (await panel.getAttribute("aria-hidden") === "false"
      && !await panel.evaluate((element) => element.classList.contains("is-peek"))) {
      await page.locator("#panel-toggle").click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    if (!await legend.evaluate((element) => element.open)) await legend.locator("summary").click();
  }
  await expect(page.locator("#legend-content")).toBeVisible();
}

async function rasterVisibility(page) {
  return page.evaluate(() => {
    const map = window.__heatMap.map;
    const visibility = (id) => map.getLayer(id) ? map.getLayoutProperty(id, "visibility") ?? "visible" : "missing";
    return {
      landsat: visibility("landsat-temperature-raster"),
      jaarbak: visibility("jaarbak-local-raster"),
      density: visibility("jaarbak-density-raster"),
      comparison: visibility("landsat-jaarbak-temperature"),
    };
  });
}

test("loads JaarBAK before revealing the first Landsat soil-sealing comparison", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "The reported first-load race is covered at desktop size.");
  const jaarbakResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("jaarbak-2024-all.pmtiles")) jaarbakResponses.push(response.status());
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 80_000 });
  await page.locator("#project-intro-primary").click();
  await page.locator('[data-layer="landsat-temperature"]').click();
  await expect(page.locator("#temporal-output")).toContainText("22 Jun 2026");
  await page.locator("#analysis-compare").click();
  await page.locator('[data-layer="jaarbak"]').click();

  await expect(page.locator("#legend-title")).toHaveText("Temperature and soil sealing", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => {
    const map = window.__heatMap.map;
    const ids = map.getStyle().layers.map((layer) => layer.id);
    return {
      jaarbakVisibility: map.getLayoutProperty("jaarbak-local-raster", "visibility"),
      jaarbakOpacity: map.getPaintProperty("jaarbak-local-raster", "raster-opacity"),
      comparisonVisibility: map.getLayoutProperty("landsat-jaarbak-temperature", "visibility"),
      stack: [
        ids.indexOf("jaarbak-local-raster"),
        ids.indexOf("landsat-jaarbak-temperature"),
        ids.indexOf("heat-sectors-hit-area"),
      ],
    };
  }), { timeout: 20_000 }).toEqual({
    jaarbakVisibility: "visible",
    jaarbakOpacity: 0.2,
    comparisonVisibility: "visible",
    stack: expect.arrayContaining([expect.any(Number)]),
  });
  const stack = await page.evaluate(() => {
    const ids = window.__heatMap.map.getStyle().layers.map((layer) => layer.id);
    return [ids.indexOf("jaarbak-local-raster"), ids.indexOf("landsat-jaarbak-temperature"), ids.indexOf("heat-sectors-hit-area")];
  });
  expect(stack[0]).toBeGreaterThanOrEqual(0);
  expect(stack[0]).toBeLessThan(stack[1]);
  expect(stack[1]).toBeLessThan(stack[2]);
  expect(jaarbakResponses.some((status) => status === 206 || status === 200)).toBe(true);
  await expect(page.locator("#temporal-output")).toContainText("22 Jun 2026");
  await expect(page.locator("#legend-content")).toContainText("Sealed");
  await expect(page.locator("#legend-content")).not.toContainText("Unsealed");
});

test("serves all eight layers from the prepared working catalogue in local-data mode", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const isMobile = testInfo.project.name.includes("mobile");
  const errors = [];
  const rangeResponses = [];
  const localRequests = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().endsWith(".pmtiles")) rangeResponses.push({ status: response.status(), url: response.url() });
  });
  page.on("request", (request) => {
    if (request.url().includes("/__local-data__/")) localRequests.push(request.url());
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 80_000 });
  await page.locator("#project-intro-primary").click();
  await expect(page.locator("[data-layer]")).toHaveCount(8);
  await expect(page.locator('[data-layer="land-cover"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="vegetation"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="tree-cover-density"]')).toHaveCount(0);
  expect(localRequests.filter((url) => url.endsWith("manifest.json"))).toEqual([]);
  expect(localRequests.filter((url) => url.endsWith(".pmtiles"))).toEqual([]);

  await page.locator('[data-layer="jaarbak"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Soil sealing 2024");
  if (isMobile) {
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
    await expandControls(page);
  }
  await expect(page.locator("#temporal-control")).toBeVisible();
  await expect(page.locator("#temporal-output")).toHaveText("2024");
  await expect(page.locator("#layer-context-note")).toContainText(/provisional/i);
  expect(localRequests.some((url) => url.includes("/jaarbak/manifest.json"))).toBe(true);
  expect(localRequests.some((url) => url.endsWith("jaarbak-2024-density.tif"))).toBe(false);
  expect(localRequests.some((url) => url.includes("/groenkaart/manifest.json"))).toBe(false);
  expect(localRequests.some((url) => url.includes("/landsat-temperature/manifest.json"))).toBe(false);
  await expect(page.locator("#map-mode-action")).toHaveText("Show density");
  await page.locator("#map-mode-action").click();
  await expect(page.locator("#map-mode-action")).toHaveText("Show classification");
  await expect(page.locator("#map-mode-action")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#legend-title")).toContainText("Sealed-surface density");
  expect(localRequests.some((url) => url.endsWith("jaarbak-2024-density.tif"))).toBe(true);
  if (!isMobile) {
    const mapBounds = await page.locator("#map").boundingBox();
    await page.mouse.move(mapBounds.x + mapBounds.width * 0.62, mapBounds.y + mapBounds.height * 0.45);
    await expect(page.locator(".maplibregl-popup")).toContainText("Surface density within 100 m");
    await expect(page.locator(".maplibregl-popup")).toContainText("ha");
  }
  await page.locator("#map-mode-action").click();
  await expect(page.locator("#map-mode-action")).toHaveText("Show density");
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await expect(page.locator("#detail-panel")).toContainText("Sealed surface");
  await expect(page.locator("#detail-panel")).toContainText("42%");
  await expect(page.locator("#detail-panel")).toContainText("artificial material that is wholly or partly impermeable");
  await expect(page.locator(".local-layer-body > section")).not.toContainText("Missing coverage");
  await expect(page.locator('[data-section="local-raster-methodology"] .accordion-content')).toBeHidden();
  await page.locator('[data-section="local-raster-methodology"] summary').click();
  await expect(page.locator("#detail-panel")).toContainText("Missing coverage");
  await page.locator("#detail-panel").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  if (isMobile) {
    await page.locator("#panel-toggle").click();
    await page.locator("#map-controls-toggle").click();
  }

  await page.locator('[data-layer="groenkaart"]').click();
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#panel-title")).toHaveText("Entire Zennevallei");
  if (isMobile) await expandControls(page);
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => page.locator("#detail-panel").evaluate((element) => element.scrollTop)).toBeLessThan(5);
  await expect(page.locator("#detail-panel")).toContainText("High green");
  await expect(page.locator("#detail-panel")).toContainText("Vegetation higher than 3 m");
  await expect(page.locator("#detail-panel")).toContainText("Vegetation lower than 3 m");
  await expect(page.locator("#detail-panel")).toContainText("Agriculture");
  await expect(page.locator("#detail-panel")).toContainText("Non-green");
  await expect(page.locator(".local-layer-body > section")).not.toContainText("Missing coverage");
  const agricultureRow = page.locator(".local-breakdown-row", { has: page.getByText("Agriculture", { exact: true }) });
  const agricultureValueColor = await agricultureRow.locator(".local-breakdown-value strong").evaluate((element) => getComputedStyle(element).color);
  expect(agricultureValueColor).not.toBe("rgb(255, 255, 0)");
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }
  await page.locator("#map-mode-action").click();
  await expandComparisonLegend(page);
  await expect(page.locator("[data-density-class]")).toHaveCount(4);
  await expect(page.locator('[data-density-class="1"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-density-class="2"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-density-class="2"]').click();
  await page.locator('[data-density-class="1"]').click();
  await expect(page.locator("[data-density-feedback]")).toContainText("at least one");
  if (isMobile && !await page.locator("#map-controls-body").isVisible()) await expandControls(page);
  await page.locator("#map-mode-action").click();
  await page.locator("#temporal-previous").click();
  await expect(page.locator("#temporal-output")).toHaveText("2018");

  await page.locator('[data-layer="landsat-temperature"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Landsat surface temperature");
  if (isMobile) {
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
    await expandControls(page);
  }
  await expect(page.locator("#temporal-control")).toBeVisible();
  const landsatMapState = await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));
  await page.locator("#analysis-compare").click();
  await expect(page.locator('[data-layer="landsat-temperature"]')).toHaveClass(/is-comparison-primary/);
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveClass(/is-comparison-target/);
  await expect(page.locator('[data-layer="jaarbak"]')).toHaveClass(/is-comparison-target/);
  for (const target of ["groenkaart", "landgebruik"]) {
    await expect(page.locator(`[data-layer="${target}"]`)).not.toHaveClass(/is-comparison-target/);
  }
  await expect(page.locator('[data-layer="income"]')).toHaveAttribute("aria-disabled", "true");
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Urban Atlas 2021");
  await expect(page.locator("#legend-title")).toHaveText("Temperature by Urban Atlas surface");
  await expect(page.locator('[data-comparison-series="family:greenUrbanAreas"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-comparison-series="class:11100"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#detail-panel")).toContainText("Temperature distribution by surface");
  await expect(page.locator("#detail-panel")).toContainText("Urban Atlas land-cover results");
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveClass(/is-linked-comparison/);
  expect(localRequests.some((url) => url.includes("/landsat-urban-atlas/manifest.json"))).toBe(true);
  expect(await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(landsatMapState);
  await expandComparisonLegend(page);
  await page.locator('[data-comparison-series="family:artificialSurfaces"]').click();
  await expect(page.locator('[data-comparison-series="family:artificialSurfaces"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-comparison-series="class:11100"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator('[data-comparison-family-toggle="artificialSurfaces"]').click();
  await page.locator('[data-comparison-series="class:11100"]').click();
  await expect(page.locator('[data-comparison-series="family:artificialSurfaces"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator('[data-comparison-series="family:agriculture"]').click();
  await page.locator('[data-comparison-series="family:forestSemiNatural"]').click();
  await page.locator('[data-comparison-series="family:sportsLeisure"]').click();
  await page.locator('[data-comparison-series="family:water"]').click();
  await expect(page.locator('[data-comparison-series="family:water"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-comparison-feedback]")).toContainText("no more than four");
  if (isMobile) await page.locator("#panel-peek").click();
  const firstHistogramBin = page.locator("[data-histogram-bin]").first();
  await expect(page.locator(".comparison-axis-y").first()).toHaveText("Surface share (%)");
  const chartSpacing = await page.locator(".comparison-chart").first().evaluate((chart) => {
    const axis = chart.querySelector(".comparison-axis-label:not(.comparison-axis-y)").getBoundingClientRect();
    const output = chart.querySelector("[data-histogram-output]").getBoundingClientRect();
    return { axisBottom: axis.bottom, outputTop: output.top };
  });
  expect(chartSpacing.outputTop).toBeGreaterThan(chartSpacing.axisBottom);
  await firstHistogramBin.focus();
  await firstHistogramBin.press("ArrowRight");
  expect(await page.locator("[data-histogram-bin]").nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
  await page.locator("[data-expand-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).toBeVisible();
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("Land-surface temperature by Urban Atlas surface");
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("ha represented area");
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("0.5°C bins");
  await expect(page.locator("[data-comparison-chart-dialog]")).toHaveScreenshot("landsat-urban-atlas-expanded.png", { animations: "disabled" });
  await page.locator("[data-close-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).not.toBeVisible();
  if (isMobile) await expandControls(page);
  await page.locator("#analysis-pair-change").click();
  await page.locator('[data-layer="jaarbak"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Soil sealing");
  await expect(page.locator('[data-layer="jaarbak"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator("#legend-title")).toHaveText("Temperature and soil sealing", { timeout: 20_000 });
  await expect(page.locator("#legend-content")).toContainText("Sealed");
  await expect(page.locator("#legend-content")).not.toContainText("Unsealed");
  await expect(page.locator("#detail-panel")).toContainText("Soil-sealing composition");
  await page.locator("[data-expand-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("Land-surface temperature on sealed and unsealed surfaces");
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("JaarBAK");
  await page.locator("[data-close-comparison-chart]").click();
  await expect(page.locator("[data-comparison-series]")).toHaveCount(0);
  expect(localRequests.some((url) => url.includes("/landsat-jaarbak/manifest.json"))).toBe(true);
  await expect.poll(() => rasterVisibility(page), { timeout: 20_000 }).toEqual({
    landsat: "none", jaarbak: "visible", density: "none", comparison: "visible",
  });
  expect(await page.evaluate(() => {
    const canvas = document.querySelector("#landsat-jaarbak-comparison-canvas");
    return canvas.getContext("2d").getImageData(20, 20, 1, 1).data[3];
  })).toBe(255);
  if (isMobile) await expandControls(page);
  await page.locator("#analysis-pair-change").click();
  await page.locator('[data-layer="urban-atlas"]').click();
  if (isMobile) await expandControls(page);
  await page.locator("#temporal-previous").click();
  await expect(page.locator("#temporal-output")).toContainText("Heatwave observation");
  await page.locator("#temporal-next").click();
  if (isMobile) {
    await page.locator("#sector-search").fill("23003A001");
    await page.locator("#sector-search").press("Enter");
  }
  await expect(page.locator(".timeline-marker.is-heatwave")).toHaveCount(2);
  await expect(page.locator(".timeline-marker.is-reference")).toHaveCount(0);
  await expect(page.locator("#legend-note")).toContainText(/12:|12\./);
  await expect(page.locator("#layer-context-note")).toContainText("28 June to 2 July 2025");
  await expect(page.locator("#detail-panel")).toContainText("not air temperature");
  await expect(page.locator("#detail-panel")).toContainText("Clear Landsat pixels");
  await expect(page.locator("#detail-panel")).toContainText("P10 to P90");
  const inspectedPixel = await page.evaluate(async () => (await fetch(
    "/__local-data-query__/landsat-temperature?observation=landsat-2026-06-22&lng=4.29&lat=50.73",
  )).json());
  expect(inspectedPixel).toMatchObject({ status: "clear", temperatureC: 37.25 });
  expect(inspectedPixel.uncertaintyK).toBeCloseTo(0.65, 5);
  const accessibilityResults = await new AxeBuilder({ page })
    .include("#detail-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibilityResults.violations).toEqual([]);
  await page.locator("#panel-close").click();
  if (isMobile) {
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator("#panel-title")).toHaveText("Entire Zennevallei");
  } else {
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "true");
  }
  if (isMobile) await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#panel-title")).toHaveText("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Urban Atlas land-cover results");

  await page.locator("#language-toggle").click();
  await expect(page.locator('[data-layer="landsat-temperature"]')).toContainText("Landsat-oppervlaktetemperatuur");
  await expect(page.locator("#detail-panel")).toContainText("Temperatuurverdeling per oppervlak");
  await expect(page.locator("#detail-panel")).toContainText("niet de luchttemperatuur");
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }
  await page.locator('[data-layer="jaarbak"]').click();
  expect(localRequests.filter((url) => url.includes("/jaarbak/manifest.json"))).toHaveLength(1);
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }

  await page.locator('[data-layer="landgebruik"]').click();
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#panel-title")).toHaveText("Halle");
  if (isMobile) await expandControls(page);
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  if (isMobile) await expandControls(page);
  await expect(page.locator("#active-layer-title")).toHaveText("Landgebruik Vlaanderen");
  await expect(page.locator("#temporal-output")).toHaveText("2025");
  await expect(page.locator("#secondary-control")).toBeVisible();
  expect(localRequests.some((url) => url.endsWith("agpa-2025.geojson"))).toBe(false);
  await page.locator('[data-secondary-option="agriculture"]').click();
  if (isMobile) await page.locator("#panel-peek").click();
  await expect(page.locator("#legend-title")).toContainText("Landbouwgebruikspercelen 2025");
  await expect.poll(() => localRequests.some((url) => url.endsWith("agpa-2025.geojson"))).toBe(true);
  await expect(page.locator("#detail-panel")).toContainText("20%");
  await expect(page.locator("#detail-panel")).toContainText("20 ha in 8 gekarteerde percelen");
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }
  await page.locator("#temporal-previous").click();
  await expect(page.locator('[data-secondary-option="agriculture"]')).toBeDisabled();

  await page.locator('[data-layer="income"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Mediaan belastbaar inkomen");
  await expect(page.locator("#temporal-output")).toHaveText("2023");

  await page.locator('[data-layer="heat"]').click();
  await page.locator("#analysis-compare").click();
  await page.locator('[data-layer="income"]').click();
  await expect(page.locator("#active-layer-title")).toContainText("Hittekwetsbaarheid × mediaan belastbaar inkomen");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  const inlineHeatIncomeChart = page.locator("[data-heat-income-chart]:not(.is-expanded)");
  await expect(inlineHeatIncomeChart).toBeVisible();
  await expect(inlineHeatIncomeChart.locator("[data-scatter-sector]")).toHaveCount(140);
  await expect(page.locator("#detail-panel")).toContainText("140 vergelijkbare sectoren");
  await expect(page.locator("#legend-content")).toContainText("exacte inkomenswaarden");
  await expect(page.locator("#detail-panel")).toHaveScreenshot("heat-income-comparison.png", {
    animations: "disabled", maxDiffPixelRatio: .001,
  });
  const heatIncomeAccessibility = await new AxeBuilder({ page })
    .include("#detail-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(heatIncomeAccessibility.violations).toEqual([]);
  await inlineHeatIncomeChart.locator("[data-expand-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("Eindscore en belastbaar inkomen in de sectoren van de Zennevallei");
  await expect(page.locator("[data-comparison-chart-dialog] .heat-income-boxplots rect")).not.toHaveCount(0);
  await expect(page.locator("[data-comparison-chart-dialog]")).toHaveScreenshot("heat-income-expanded.png", {
    animations: "disabled", maxDiffPixelRatio: .001,
  });
  await page.locator("[data-close-comparison-chart]").click();
  expect(await page.evaluate(() => ({
    heat: window.__heatMap.map.getLayoutProperty("heat-sectors-fill", "visibility"),
    income: window.__heatMap.map.getLayoutProperty("statbel-income-fill", "visibility"),
    symbols: window.__heatMap.map.getLayoutProperty("heat-income-symbols", "visibility"),
  }))).toEqual({ heat: "visible", income: "none", symbols: "visible" });
  await expect(page.locator("#legend-content")).toContainText("€30.000–39.999");

  await expandControls(page);
  await page.locator("#sector-search").fill("23027C091");
  await page.locator("#sector-search").press("Enter");
  await expect(inlineHeatIncomeChart.locator('[data-scatter-sector="23027C091"]')).toHaveClass(/is-selected/);
  await expect(inlineHeatIncomeChart).toBeVisible();

  if (await page.locator("#detail-panel").evaluate((element) => element.classList.contains("is-peek"))) {
    await page.locator("#panel-peek").click();
  }
  await page.locator('[data-panel-heat-metric="vulnerability"]').click();
  await expect(page.locator("#detail-panel")).toContainText("Kwetsbaarheid tegenover mediaan belastbaar inkomen");
  const firstPoint = inlineHeatIncomeChart.locator("[data-scatter-sector]").first();
  await firstPoint.focus();
  await firstPoint.press("ArrowRight");
  expect(await inlineHeatIncomeChart.locator("[data-scatter-sector]").nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
  await expect(inlineHeatIncomeChart.locator("[data-scatter-output]")).toContainText("Mediaan inkomen");

  await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(inlineHeatIncomeChart.locator("[data-scatter-sector]")).toHaveCount(140);
  if (await page.locator("#detail-panel").evaluate((element) => element.classList.contains("is-peek"))) {
    await page.locator("#panel-peek").click();
  }
  await expandControls(page);
  await page.locator("#about-button").click();
  await expect(page.locator("#panel-title")).toHaveText("Over deze kaart");
  await page.locator("#panel-close").click();
  if (await page.locator("#detail-panel").evaluate((element) => element.classList.contains("is-peek"))) {
    await page.locator("#panel-peek").click();
  }
  await expect(inlineHeatIncomeChart).toBeVisible();
  await page.locator("#panel-close").click();
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#detail-panel")).toHaveClass(/is-peek/);
  await expandControls(page);
  await page.locator("#analysis-pair-remove").click();
  expect(await page.evaluate(() => ({
    heat: window.__heatMap.map.getLayoutProperty("heat-sectors-fill", "visibility"),
    income: window.__heatMap.map.getLayoutProperty("statbel-income-fill", "visibility"),
  }))).toEqual({ heat: "visible", income: "none" });
  expect(errors).toEqual([]);
});
