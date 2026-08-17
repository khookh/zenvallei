import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Screenshot rendering depends on the operating system's font rasterisation.
// Linux CI still runs all semantic and interaction assertions; the committed
// visual-regression baselines are intentionally generated on Windows.
const RUN_VISUAL_REGRESSION = process.platform === "win32";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

async function expandControls(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const adaptive = await page.locator(".map-shell").getAttribute("data-surface-mode") !== "expanded";
  const panel = page.locator("#detail-panel");
  if (adaptive && await panel.getAttribute("aria-hidden") === "false") {
    await page.locator("#panel-close").click();
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

async function reopenCurrentScope(page) {
  const panel = page.locator("#detail-panel");
  if (await panel.getAttribute("aria-hidden") === "false") return;
  await page.locator("#municipality-select").evaluate((element) => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(panel).toHaveAttribute("aria-hidden", "false");
}

const THEME_BY_LAYER = {
  "landsat-temperature": "heat", heat: "heat",
  "urban-atlas": "land-green", jaarbak: "land-green", groenkaart: "land-green",
  population: "demography", income: "demography",
};

async function activateLayer(page, layerId) {
  const theme = THEME_BY_LAYER[layerId];
  const tab = theme ? page.locator(`[data-layer-tab="${theme}"]`) : null;
  const picking = await page.locator("#layer-switch").evaluate((element) => element.classList.contains("is-comparison-mode"));
  if (tab && !picking && !await tab.isVisible()) await expandControls(page);
  if (tab && !picking) await tab.click();
  await page.locator(`[data-layer="${layerId}"]`).click();
}

async function expandComparisonLegend(page) {
  const legend = page.locator("#legend");
  if (!await legend.evaluate((element) => element.open)) {
    const panel = page.locator("#detail-panel");
    if (await panel.getAttribute("aria-hidden") === "false") {
      await page.locator("#panel-close").click();
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

async function activateComparison(page, fromLayer, targetLayer, readySelector = "#detail-panel .sealed-urban-scatter:not(.is-expanded)") {
  await expandControls(page);
  await activateLayer(page, fromLayer);
  await expect(page.locator(`[data-layer="${fromLayer}"]`)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe(fromLayer);
  await expandControls(page);
  await page.locator("#analysis-compare").click();
  await expect(page.locator(`[data-layer="${targetLayer}"]`)).toHaveClass(/is-comparison-target/);
  await page.locator(`[data-layer="${targetLayer}"]`).click();
  await expect(page.locator("#active-layer-title")).toContainText("×", { timeout: 20_000 });
  await expect(page.locator(readySelector)).toHaveCount(1, { timeout: 20_000 });
}

test("compares heat vulnerability with authoritative sector population", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 120_000 });
  await page.locator("#project-intro-primary").click();

  await expandControls(page);
  await activateLayer(page, "heat");
  await expandControls(page);
  await page.locator("#analysis-compare").click();
  await expect(page.locator('[data-layer="population"]')).toHaveClass(/is-comparison-target/);
  await activateLayer(page, "population");
  await expect(page.locator("#active-layer-title")).toHaveText("Heat vulnerability × population");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");

  const inlineBox = page.locator("[data-heat-population-box-chart]:not(.is-expanded)");
  const inlineBars = page.locator("[data-heat-population-bar-chart]:not(.is-expanded)");
  await expect(inlineBox.locator("[data-scatter-sector]")).toHaveCount(140);
  await expect(inlineBars.locator("[data-population-score-bar]")).toHaveCount(11);
  await expect(page.locator("#detail-panel")).toContainText("139,939 of 140,122 residents are represented");
  if (RUN_VISUAL_REGRESSION) {
    await expect(inlineBox.locator("svg")).toHaveScreenshot("heat-population-comparison.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
    await expect(inlineBars.locator("svg")).toHaveScreenshot("heat-population-bars.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
  }

  expect(await page.evaluate(() => ({
    heat: window.__heatMap.map.getLayoutProperty("heat-sectors-fill", "visibility"),
    populationGrid: window.__heatMap.map.getLayer("population-grid-2025-fill")
      ? window.__heatMap.map.getLayoutProperty("population-grid-2025-fill", "visibility")
      : "missing",
    symbols: window.__heatMap.map.getLayoutProperty("heat-population-symbols", "visibility"),
    images: Array.from({ length: 5 }, (_, index) => window.__heatMap.map.hasImage(`heat-population-level-${index + 1}`)),
  }))).toEqual({ heat: "visible", populationGrid: "missing", symbols: "visible", images: [true, true, true, true, true] });

  await expandComparisonLegend(page);
  await expect(page.locator("#legend-content .legend-person-strip")).toHaveCount(5);
  await expect(page.locator("#legend-content")).toContainText(/2,000/);
  await expect(page.locator(".legend-comparison-section div > span").last())
    .toHaveAttribute("aria-label", /Five-person symbol.*2,000 residents or more/i);
  await reopenCurrentScope(page);
  await page.locator('[data-panel-heat-metric="vulnerability"]').click();
  await expect(page.locator("#detail-panel")).toContainText("Vulnerability score (0–10)");
  await expect(inlineBox.locator("[data-scatter-sector]")).toHaveCount(140);
  const firstPoint = inlineBox.locator("[data-scatter-sector]").first();
  await firstPoint.focus();
  await firstPoint.press("ArrowRight");
  await expect(inlineBox.locator("[data-scatter-output]")).toContainText("Population");
  const firstBar = inlineBars.locator("[data-population-score-bar]").first();
  await firstBar.focus();
  await firstBar.press("End");
  await expect(inlineBars.locator("[data-population-bar-output]")).toContainText("Score 10");

  await inlineBox.locator('[data-dialog-target="heat-population-boxes"]').click();
  const dialog = page.locator('[data-chart-dialog-id="heat-population-boxes"]:visible');
  await expect(dialog).toContainText("Heat vulnerability and population in Entire Zennevallei");
  await expect(dialog.locator("[data-heat-population-box-chart].is-expanded")).toBeVisible();
  await expect(dialog.locator("[data-heat-population-bar-chart]")).toHaveCount(0);
  if (RUN_VISUAL_REGRESSION) {
    await expect(dialog.locator("[data-heat-population-box-chart].is-expanded svg")).toHaveScreenshot("heat-population-expanded.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
  }
  await dialog.locator("[data-close-comparison-chart]").click();

  await inlineBars.locator('[data-dialog-target="heat-population-bars"]').click();
  const residentsDialog = page.locator('[data-chart-dialog-id="heat-population-bars"]:visible');
  await expect(residentsDialog).toContainText("Residents by heat-vulnerability score");
  await expect(residentsDialog.locator("[data-population-score-bar]")).toHaveCount(11);
  await expect(residentsDialog.locator("[data-heat-population-box-chart]")).toHaveCount(0);
  if (RUN_VISUAL_REGRESSION) {
    await expect(residentsDialog.locator("[data-heat-population-bar-chart].is-expanded svg")).toHaveScreenshot("heat-population-bars-expanded.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
  }
  await residentsDialog.locator("[data-close-comparison-chart]").click();

  const accessibility = await new AxeBuilder({ page })
    .include("#detail-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(inlineBox.locator("[data-scatter-sector]")).toHaveCount(39);
  await expect(page.locator("#detail-panel")).toContainText("42,846 of 42,877 residents are represented");
  expect(await page.evaluate(() => window.__heatMap.map.getFilter("heat-population-symbols")))
    .toEqual(["==", ["get", "municipality"], "Halle"]);

  await expandControls(page);
  await page.locator("#analysis-pair-remove").click();
  expect(await page.evaluate(() => ({
    heat: window.__heatMap.map.getLayoutProperty("heat-sectors-fill", "visibility"),
    symbols: window.__heatMap.map.getLayoutProperty("heat-population-symbols", "visibility"),
  }))).toEqual({ heat: "visible", symbols: "none" });
  expect(errors).toEqual([]);
});

test("reveals the aligned sealed mask and Landsat comparison atomically", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "The reported first-load race is covered at desktop size.");
  const jaarbakResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("jaarbak-2024-all.pmtiles")) jaarbakResponses.push(response.status());
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  // The first local-data page in a fresh fixture can spend most of a minute
  // warming the analytical catalogue before comparison assets are requested.
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 120_000 });
  await page.locator("#project-intro-primary").click();
  await activateLayer(page, "landsat-temperature");
  await expect(page.locator("#temporal-output")).toContainText("22 Jun 2026");
  await page.locator("#analysis-compare").click();
  await activateLayer(page, "jaarbak");

  await expect(page.locator("#legend-title")).toHaveText("Temperature and soil sealing", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => {
    const map = window.__heatMap.map;
    const ids = map.getStyle().layers.map((layer) => layer.id);
    const sealedId = ids.find((id) => id.startsWith("landsat-jaarbak-sealed-"));
    return {
      sealedVisibility: sealedId ? map.getLayoutProperty(sealedId, "visibility") ?? "visible" : "missing",
      sealedOpacity: sealedId ? map.getPaintProperty(sealedId, "raster-opacity") : null,
      landsatVisibility: map.getLayoutProperty("landsat-temperature-raster", "visibility"),
      landsatOpacity: map.getPaintProperty("landsat-temperature-raster", "raster-opacity"),
      stack: [
        ids.indexOf(sealedId),
        ids.indexOf("landsat-temperature-raster"),
        ids.indexOf("heat-sectors-hit-area"),
      ],
    };
  }), { timeout: 20_000 }).toEqual({
    sealedVisibility: "visible",
    sealedOpacity: 0.96,
    landsatVisibility: "visible",
    landsatOpacity: 0.72,
    stack: expect.arrayContaining([expect.any(Number)]),
  });
  const stack = await page.evaluate(() => {
    const ids = window.__heatMap.map.getStyle().layers.map((layer) => layer.id);
    const sealedId = ids.find((id) => id.startsWith("landsat-jaarbak-sealed-"));
    return [ids.indexOf(sealedId), ids.indexOf("landsat-temperature-raster"), ids.indexOf("heat-sectors-hit-area")];
  });
  expect(stack[0]).toBeGreaterThanOrEqual(0);
  expect(stack[0]).toBeLessThan(stack[1]);
  expect(stack[1]).toBeLessThan(stack[2]);
  expect(jaarbakResponses.some((status) => [200, 206].includes(status))).toBe(true);
  await expect(page.locator("#temporal-output")).toContainText("22 Jun 2026");
  await expect(page.locator("#legend-content")).toContainText("Sealed");
  await expect(page.locator("#legend-content")).not.toContainText("Unsealed");
});

test("opens every sealed urban-fabric comparison from both layers", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 80_000 });
  await page.locator("#project-intro-primary").click();
  const cases = [
    ["landsat-temperature", "groenkaart", "Land-surface temperature and surrounding vegetation cover", "landsat-groenkaart-temperature-"],
    ["groenkaart", "landsat-temperature", "Land-surface temperature and surrounding vegetation cover", "landsat-groenkaart-temperature-"],
    ["groenkaart", "income", "Vegetation cover versus median taxable income", "groenkaart-income-density-"],
    ["income", "groenkaart", "Vegetation cover versus median taxable income", "groenkaart-income-density-"],
    ["landsat-temperature", "income", "Mean land-surface temperature versus median taxable income", "landsat-income-temperature-"],
    ["income", "landsat-temperature", "Mean land-surface temperature versus median taxable income", "landsat-income-temperature-"],
  ];
  let checkedLandsatGreenControls = false;
  for (const [fromLayer, targetLayer, chartTitle, mapLayer] of cases) {
    await activateComparison(page, fromLayer, targetLayer);
    await expect(page.locator("#detail-panel")).toContainText(chartTitle, { timeout: 20_000 });
    await expect(page.locator(".sealed-urban-scatter:not(.is-expanded)")).toBeVisible();
    await expect.poll(() => page.evaluate((id) => {
      const map = window.__heatMap.map;
      const layer = id.endsWith("-")
        ? map.getStyle().layers.find((item) => item.id.startsWith(id))
        : map.getLayer(id);
      return layer ? map.getLayoutProperty(layer.id, "visibility") ?? "visible" : "missing";
    }, mapLayer)).toBe("visible");
    if (targetLayer === "groenkaart" || fromLayer === "groenkaart") {
      await expandComparisonLegend(page);
      await expect(page.locator("[data-density-class]")).toHaveCount(4);
    }
    if (fromLayer === "landsat-temperature" && targetLayer === "groenkaart") {
      // Sector records do not carry the synthetic scope field used by area
      // summaries. The chart must nevertheless use the selected sector only.
      await expandControls(page);
      await page.locator("#sector-search").fill("23027A00-");
      await page.locator("#sector-search").press("Enter");
      await expect(page.locator("#detail-panel")).toContainText("5 eligible clear Landsat observations are plotted.");
      await expandControls(page);
      await page.locator("#municipality-select").evaluate((element) => element.dispatchEvent(new Event("change", { bubbles: true })));
      await expect(page.locator("#detail-panel")).toContainText("770 eligible clear Landsat observations are plotted.");
    }
    if (!checkedLandsatGreenControls && [fromLayer, targetLayer].includes("landsat-temperature")
      && [fromLayer, targetLayer].includes("groenkaart")) {
      await expandComparisonLegend(page);
      await expect(page.locator('[data-comparison-series="residential"]'))
        .toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('[data-comparison-series="employmentInstitutional"]'))
        .toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-comparison-series="employmentInstitutional"]').click();
      await expect(page.locator('[data-comparison-series="employmentInstitutional"]'))
        .toHaveAttribute("aria-pressed", "false");
      await page.locator('[data-comparison-series="residential"]').click();
      await expect(page.locator('[data-comparison-series="residential"]'))
        .toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-comparison-series="employmentInstitutional"]').click();
      await expect(page.locator('[data-comparison-series="employmentInstitutional"]'))
        .toHaveAttribute("aria-pressed", "true");
      await expandControls(page);
      await expect(page.locator("#map-mode-action")).toHaveText("Show vegetation cover");
      await page.locator("#map-mode-action").click();
      await expect(page.locator("#map-mode-action")).toHaveText("Show temperature");
      await expect(page.locator("#legend-content .legend-continuous-scale"))
        .toHaveAttribute("aria-label", /vegetation-cover scale/i);
      await page.locator("#map-mode-action").click();
      await expect(page.locator("#map-mode-action")).toHaveText("Show vegetation cover");
      checkedLandsatGreenControls = true;
    }
    if ([fromLayer, targetLayer].includes("groenkaart") && [fromLayer, targetLayer].includes("income")) {
      const ramp = page.locator("#legend-content .legend-continuous-scale");
      await expect(ramp).toHaveAttribute("aria-label", /continuous vegetation-cover scale/i);
      expect(await ramp.locator(".legend-continuous-ramp").evaluate((element) => getComputedStyle(element).backgroundImage))
        .toContain("linear-gradient");
      await expect(ramp.locator(".legend-continuous-ticks")).toContainText("100%");
    }
    await expandControls(page);
    await expect(page.locator("#analysis-pairing")).toBeVisible();
    const bounds = await page.locator("#analysis-pairing").evaluate((element) => {
      const own = element.getBoundingClientRect();
      const parent = document.querySelector("#map-controls").getBoundingClientRect();
      return { left: own.left, right: own.right, parentLeft: parent.left, parentRight: parent.right };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft - 1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight + 1);
    await reopenCurrentScope(page);
    await page.locator("[data-expand-comparison-chart]").first().click();
    await expect(page.locator("[data-comparison-chart-dialog]:visible")).toBeVisible();
    await page.locator("[data-comparison-chart-dialog]:visible [data-close-comparison-chart]").click();
    await expandControls(page);
    await page.locator("#analysis-pair-remove").click();
    await expect(page.locator("#analysis-pair-result")).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe(fromLayer);
    await expect(page.locator(`[data-layer="${fromLayer}"]`)).toHaveAttribute("aria-pressed", "true");
  }
});

test("compares Green Map vegetation cover with the uniform 2019 population model", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  // A cold local fixture validates its analytical catalogue before it exposes
  // the comparison controls; slower developer disks can exceed 80 seconds.
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 120_000 });
  await page.locator("#project-intro-primary").click();

  await activateComparison(page, "population", "groenkaart", "#detail-panel [data-green-population-chart]:not(.is-expanded) .population-temperature-step");
  await expect(page.locator('[data-layer="groenkaart"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator('[data-layer="population"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator("#secondary-control")).toBeHidden();
  await expect(page.locator("#detail-panel")).toContainText("Cumulative residents by vegetation cover");
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded)")).toHaveCount(2);
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded) [data-green-population-group]").first())
    .toBeVisible();
  await expect(page.locator("#legend-content .legend-continuous-scale"))
    .toHaveAttribute("aria-label", /continuous vegetation cover within 100 m/i);
  await expect(page.locator("#legend-content .legend-comparison-section"))
    .toContainText("Population density model, 2019");

  await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Halle");
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded) [data-green-population-group]").first())
    .toBeVisible();

  for (const target of ["groenkaart-population-cumulative", "groenkaart-population-histogram"]) {
    await page.locator(`[data-dialog-target="${target}"]`).click();
    await expect(page.locator(`[data-chart-dialog-id="${target}"] [data-green-population-chart].is-expanded`))
      .toBeVisible();
    await page.locator(`[data-chart-dialog-id="${target}"] [data-close-comparison-chart]`).click();
  }

  await expandControls(page);
  await page.locator("#analysis-pair-remove").click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe("population");
  await expect(page.locator("#secondary-control")).toContainText("Current grid · 2025");
});

test("profiles selected sealed-surface Landsat temperature across the 2019 modelled population", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 80_000 });
  await page.locator("#project-intro-primary").click();

  await activateComparison(page, "population", "landsat-temperature", "#detail-panel [data-green-population-chart]:not(.is-expanded) .population-temperature-step");
  await expect(page.locator('[data-layer="landsat-temperature"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator('[data-layer="population"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator("#detail-panel")).toContainText("Cumulative residents by land-surface temperature");
  await expect(page.locator("#detail-panel")).toContainText("Distribution of modelled residents by temperature");
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded)")).toHaveCount(2);
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded) .population-temperature-step")).toBeVisible();
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded) .population-temperature-bars")).toBeVisible();
  await expect(page.locator("#legend-content .legend-comparison-section"))
    .toContainText("Modelled inhabitants per hectare, 2019");

  await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Halle");
  await expect(page.locator("[data-green-population-chart]:not(.is-expanded)")).toHaveCount(2);

  for (const target of ["landsat-population-cumulative", "landsat-population-histogram"]) {
    await page.locator(`[data-dialog-target="${target}"]`).click();
    await expect(page.locator(`[data-chart-dialog-id="${target}"] [data-green-population-chart].is-expanded`))
      .toBeVisible();
    await page.locator(`[data-chart-dialog-id="${target}"] [data-close-comparison-chart]`).click();
  }

  await expandControls(page);
  await page.locator("#analysis-pair-remove").click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe("population");
  await expect(page.locator("#secondary-control")).toContainText("Current grid · 2025");
});

test("paints a local land-cover scenario and switches between both estimates", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const isMobile = testInfo.project.name.includes("mobile");
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: TRANSPARENT_PNG,
  }));
  await page.goto("/");
  // The local-data fixture builds several analytical assets on first startup.
  // Allow slower developer machines to reach the app before exercising drawing.
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 120_000 });
  await page.locator("#project-intro-primary").click();
  await page.locator('[data-layer="land-cover-scenario"]').click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.getActiveLayer())).toBe("land-cover-scenario");
  await closePanelIfOpen(page);
  await expandControls(page);
  await expect(page.locator("#scenario-editor")).toBeVisible();
  await page.locator("#scenario-draw").click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.map.getCanvas().style.cursor)).toBe("crosshair");
  // Leave the whole map available on narrow viewports before placing vertices.
  // The interaction itself remains a real MapLibre pointer click.
  if (!await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  if (await page.locator("#legend").evaluate((element) => element.open)) {
    await page.locator("#legend summary").click();
  }
  await page.evaluate(() => {
    window.__heatMap.map.jumpTo({ center: [4.238, 50.737], zoom: 15 });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const findDrawPoints = () => page.evaluate(() => {
    const map = window.__heatMap.map;
    const canvas = map.getCanvas();
    const rectangle = map.getCanvas().getBoundingClientRect();
    const positions = [
      [4.236, 50.7355], [4.240, 50.7355], [4.240, 50.7385], [4.236, 50.7385],
    ].map((coordinate) => map.project(coordinate));
    if (!positions.every(({ x, y }) => document.elementFromPoint(rectangle.left + x, rectangle.top + y) === canvas)) return null;
    return positions.map(({ x, y }) => [rectangle.left + x, rectangle.top + y]);
  });
  const points = await findDrawPoints();
  expect(points).not.toBeNull();
  for (const [x, y] of points) {
    if (isMobile) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  }
  const draftPresentation = await page.evaluate(() => {
    const map = window.__heatMap.map;
    const order = map.getStyle().layers.map((layer) => layer.id);
    return {
      fill: map.getPaintProperty("lst-scenario-drawing-fill", "fill-color"),
      casing: map.getPaintProperty("lst-scenario-drawing-casing", "line-color"),
      casingWidth: map.getPaintProperty("lst-scenario-drawing-casing", "line-width"),
      line: map.getPaintProperty("lst-scenario-drawing-line", "line-color"),
      lineWidth: map.getPaintProperty("lst-scenario-drawing-line", "line-width"),
      vertex: map.getPaintProperty("lst-scenario-drawing-vertices", "circle-color"),
      draftIndex: order.indexOf("lst-scenario-drawing-vertices"),
      deltaIndex: order.indexOf("lst-scenario-delta-layer"),
      boundaryIndex: order.indexOf("heat-sectors-hit-area"),
    };
  });
  expect(draftPresentation).toMatchObject({
    fill: "#ffffff", casing: "#123b43", casingWidth: 7,
    line: "#ffffff", lineWidth: 4, vertex: "#ffffff",
  });
  expect(draftPresentation.draftIndex).toBeGreaterThan(draftPresentation.deltaIndex);
  expect(draftPresentation.draftIndex).toBeGreaterThan(draftPresentation.boundaryIndex);
  await testInfo.attach("scenario-white-drawing", {
    body: await page.screenshot(), contentType: "image/png",
  });
  await expandControls(page);
  await expect(page.locator("#scenario-finish")).toBeEnabled();
  await page.locator("#scenario-finish").click();
  await expect(page.locator("#scenario-editor-state")).toHaveText("Ready", { timeout: 60_000 });
  await closePanelIfOpen(page);
  await expandControls(page);
  await page.locator('[data-scenario-target="remove-high"]').click();
  await expect(page.locator('[data-scenario-target="remove-high"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator("#scenario-draw").click();
  if (!await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const removePoints = await findDrawPoints();
  expect(removePoints).not.toBeNull();
  for (const [x, y] of removePoints) {
    if (isMobile) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  }
  await expandControls(page);
  await page.locator("#scenario-finish").click();
  await expect(page.locator("#scenario-editor-state")).toHaveText("Ready", { timeout: 60_000 });
  await expandComparisonLegend(page);
  await expect(page.locator('[data-scenario-delta]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => {
    const map = window.__heatMap.map;
    const cover = map.getStyle().layers.find((layer) => /^lst-scenario-cover-[01]$/.test(layer.id)
      && map.getLayoutProperty(layer.id, "visibility") !== "none");
    return {
      coverOpacity: cover ? map.getPaintProperty(cover.id, "raster-opacity") : null,
      deltaOpacity: map.getPaintProperty("lst-scenario-delta-layer", "raster-opacity"),
    };
  })).toEqual({ coverOpacity: .48, deltaOpacity: 1 });
  await page.locator('[data-scenario-delta]').click();
  await expect.poll(() => page.evaluate(() => {
    const map = window.__heatMap.map;
    const cover = map.getStyle().layers.find((layer) => /^lst-scenario-cover-[01]$/.test(layer.id)
      && map.getLayoutProperty(layer.id, "visibility") !== "none");
    return cover ? map.getPaintProperty(cover.id, "raster-opacity") : null;
  })).toBe(.78);
  await page.locator('[data-scenario-delta]').click();
  await expect(page.locator('[data-scenario-category="sealed"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-scenario-category="sealed"]').click();
  await expect(page.locator('[data-scenario-category="sealed"]')).toHaveAttribute("aria-pressed", "false");
  await page.locator('[data-scenario-category="sealed"]').click();
  await expect(page.locator('[data-scenario-method="xgboost"]')).toBeEnabled();
  await expect(page.locator('[data-scenario-method]')).toHaveCount(2);
  await page.locator('[data-scenario-method="radoux"]').click();
  await expect(page.locator('[data-scenario-method="radoux"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-scenario-method="xgboost"]').click();
  await testInfo.attach("scenario-visible-delta", {
    body: await page.screenshot(), contentType: "image/png",
  });
  const scenarioAccessibility = await new AxeBuilder({ page })
    .include("#scenario-editor")
    .include("#legend")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(scenarioAccessibility.violations).toEqual([]);
  if (await page.locator("#legend").evaluate((element) => element.open)) {
    await page.locator("#legend summary").click();
  }
  if (await page.locator("#detail-panel").getAttribute("aria-hidden") === "true") {
    await reopenCurrentScope(page);
  }
  await expect(page.locator("#detail-panel")).toContainText("2026 Heatwave XGBoost");
  await expect(page.locator("#detail-panel")).toContainText(/°C/);
  await expect(page.locator("#detail-panel")).toContainText("Ground composition");
  await expect(page.locator("#detail-panel")).toContainText("High-vegetation canopy");
  await expect(page.locator("#detail-panel .scenario-change-table")).toBeVisible();
  const scenarioMethod = page.locator('#detail-panel details[data-section="methodology"]');
  await scenarioMethod.locator("summary").click();
  await expect(scenarioMethod).toContainText("Shared calculation");
  await expect(scenarioMethod).toContainText("2026 Heatwave XGBoost");
  await expect(scenarioMethod.locator('a[href*="xgboost_2026_heatwave_regression_zennevallei.ipynb"]')).toHaveCount(1);
  await expect(scenarioMethod).not.toContainText("Radoux et al. (2025) estimated");
  await expect(scenarioMethod).toContainText("22 June 2026 at 12:33 CEST");
  await expect(scenarioMethod).toContainText("Limitations");
  await page.locator("#panel-close").click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (!await page.locator("#map-controls").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  await expect(page.locator("#map-controls")).toHaveClass(/is-collapsed/);
  await page.evaluate(() => {
    window.__heatMap.map.jumpTo({ center: [4.238, 50.737], zoom: 15 });
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const inspectionPoint = await page.evaluate(() => {
    const map = window.__heatMap.map;
    const rectangle = map.getCanvas().getBoundingClientRect();
    const point = map.project([4.238, 50.737]);
    return [rectangle.left + point.x, rectangle.top + point.y];
  });
  if (isMobile) await page.touchscreen.tap(...inspectionPoint);
  else await page.mouse.move(...inspectionPoint);
  await expect(page.locator(".maplibregl-popup")).toContainText("Urban Atlas:", { timeout: 20_000 });
  await expect(page.locator(".maplibregl-popup")).toContainText(/2026 Heatwave XGBoost: .*°C ΔLST/);
  await expect(page.locator(".maplibregl-popup")).not.toContainText("Radoux et al. model");
  expect(await page.evaluate(() => window.__heatMap.map.getCanvas().style.cursor)).toBe("pointer");
});

test("serves seven thematic layers and the scenario tool from the prepared working catalogue", async ({ page }, testInfo) => {
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
  await expect(page.locator('[data-layer="land-cover-scenario"]')).toHaveCount(1);
  await expect(page.locator('[data-layer="land-cover"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="vegetation"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="tree-cover-density"]')).toHaveCount(0);
  expect(localRequests.filter((url) => url.endsWith("manifest.json"))).toEqual([
    expect.stringContaining("/landsat-temperature/manifest.json"),
  ]);
  expect(localRequests.filter((url) => url.endsWith(".pmtiles")))
    .toEqual(expect.arrayContaining([expect.stringContaining("/landsat-temperature/")]));
  expect(localRequests.filter((url) => url.endsWith(".pmtiles"))
    .every((url) => url.includes("/landsat-temperature/"))).toBe(true);

  await activateLayer(page, "jaarbak");
  await expect(page.locator("#active-layer-title")).toHaveText("Soil sealing 2024");
  if (isMobile) {
    await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
    await expandControls(page);
  }
  await expect(page.locator("#temporal-control")).toBeVisible();
  await expect(page.locator("#temporal-output")).toHaveText("2024");
  await expect(page.locator("#layer-context-note")).not.toContainText(/provisional/i);
  await expect(page.locator('details[data-section="local-raster-methodology"]')).toContainText(/provisional/i);
  expect(localRequests.some((url) => url.includes("/jaarbak/manifest.json"))).toBe(true);
  expect(localRequests.some((url) => url.endsWith("jaarbak-2024-density.tif"))).toBe(false);
  expect(localRequests.some((url) => url.includes("/groenkaart/manifest.json"))).toBe(false);
  expect(localRequests.some((url) => url.includes("/landsat-temperature/manifest.json"))).toBe(true);
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
    await page.locator("#panel-close").click();
    await expandControls(page);
  }

  await activateLayer(page, "groenkaart");
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

  await activateLayer(page, "landsat-temperature");
  await expect(page.locator("#active-layer-title")).toHaveText("Heatwave surface temperature");
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
  for (const target of ["heat"]) {
    await expect(page.locator(`[data-layer="${target}"]`)).not.toHaveClass(/is-comparison-target/);
  }
  await expect(page.locator('[data-layer="groenkaart"]')).toHaveClass(/is-comparison-target/);
  await expect(page.locator('[data-layer="income"]')).toHaveClass(/is-comparison-target/);
  await expect(page.locator('[data-layer="population"]')).toHaveClass(/is-comparison-target/);
  await activateLayer(page, "urban-atlas");
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
  await expect(page.locator('[data-comparison-series="family:agriculture"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-comparison-series="family:forestSemiNatural"]').click();
  await expect(page.locator('[data-comparison-series="family:forestSemiNatural"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-comparison-series="family:sportsLeisure"]').click();
  await expect(page.locator('[data-comparison-series="family:sportsLeisure"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-comparison-feedback]")).toContainText("no more than four");
  await page.locator('[data-comparison-series="family:water"]').click();
  await expect(page.locator('[data-comparison-series="family:water"]')).toHaveAttribute("aria-pressed", "false");
  // Opening the comparison legend may close the result panel to avoid a map
  // collision at any viewport width. Recommit the active scope before testing
  // the inline chart so geometry is never measured inside a hidden panel.
  await reopenCurrentScope(page);
  // Series changes can complete a final asynchronous panel refresh. Wait for
  // the chart's data requests to settle before asserting roving keyboard focus.
  await page.waitForLoadState("networkidle");
  const visibleHistogram = page.locator("#detail-panel .comparison-chart:not(.is-expanded)");
  const firstHistogramBin = visibleHistogram.locator("[data-histogram-bin]").first();
  await expect(visibleHistogram).toBeVisible();
  await expect(visibleHistogram.locator("[data-histogram-output]")).toBeVisible();
  await expect(visibleHistogram.locator(".comparison-axis-y")).toHaveText("Surface share (%)");
  const chartSpacing = await visibleHistogram.evaluate((chart) => {
    const axis = chart.querySelector(".comparison-axis-label:not(.comparison-axis-y)").getBoundingClientRect();
    const output = chart.querySelector("[data-histogram-output]").getBoundingClientRect();
    return { axisBottom: axis.bottom, outputTop: output.top };
  });
  expect(chartSpacing.outputTop).toBeGreaterThan(chartSpacing.axisBottom);
  await firstHistogramBin.focus();
  await firstHistogramBin.press("ArrowRight");
  await expect.poll(() => visibleHistogram.locator("[data-histogram-bin]").nth(1)
    .evaluate((element) => element === document.activeElement)).toBe(true);
  await page.locator("[data-expand-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).toBeVisible();
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("Land-surface temperature by Urban Atlas surface");
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("ha · 100 Landsat observations");
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("0.5°C bins");
  if (RUN_VISUAL_REGRESSION) {
    await expect(page.locator("[data-comparison-chart-dialog]")).toHaveScreenshot("landsat-urban-atlas-expanded.png", { animations: "disabled" });
  }
  await page.locator("[data-close-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).not.toBeVisible();
  if (isMobile) await expandControls(page);
  await page.locator("#analysis-pair-change").click();
  await activateLayer(page, "jaarbak");
  await expect(page.locator("#analysis-pair-label")).toContainText("Soil sealing");
  await expect(page.locator('[data-layer="jaarbak"]')).toHaveClass(/is-linked-comparison/);
  await expect(page.locator("#legend-title")).toHaveText("Temperature and soil sealing", { timeout: 20_000 });
  await expect(page.locator("#legend-content")).toContainText("Sealed");
  await expect(page.locator("#legend-content")).not.toContainText("Unsealed");
  await expect(page.locator("#detail-panel")).toContainText("Soil-sealing composition");
  await page.locator('[aria-labelledby="soil-temperature-distribution-title"] [data-expand-comparison-chart]').click();
  const soilChartsDialog = page.locator("[data-comparison-chart-dialog]:visible");
  await expect(soilChartsDialog).toBeVisible();
  await expect(soilChartsDialog).toContainText("Land-surface temperature on sealed and unsealed surfaces");
  await expect(soilChartsDialog).toContainText("soil-sealing classification");
  await soilChartsDialog.locator("[data-close-comparison-chart]").click();
  const densitySection = page.locator('[aria-labelledby="soil-density-analysis-title"]');
  await densitySection.locator("[data-expand-comparison-chart]").click();
  const densityDialog = page.locator("[data-comparison-chart-dialog]:visible");
  await expect(densityDialog).toContainText("Land-surface temperature and surrounding soil sealing");
  await expect(densityDialog).toContainText("Sealed surface within 100 m (%)");
  const densityHitArea = densityDialog.locator("[data-pixel-scatter-hit]");
  await expect(densityHitArea).toBeVisible();
  // Address and inspect the active chart in one browser task. The comparison
  // can refresh its SVG once as source readiness settles, so retaining a DOM
  // handle across focus and key dispatch would make this assertion flaky.
  await expect.poll(() => densityDialog.evaluate((dialog) => {
    const hitArea = dialog.querySelector("[data-pixel-scatter-hit]");
    if (!hitArea) return "";
    hitArea.focus();
    hitArea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return dialog.querySelector("[data-scatter-output]")?.textContent ?? "";
  })).toContain("3.1416 ha");
  await densityDialog.locator("[data-close-comparison-chart]").click();
  await expect(page.locator("[data-comparison-series]")).toHaveCount(0);
  expect(localRequests.some((url) => url.includes("/landsat-jaarbak/manifest.json"))).toBe(true);
  await expect.poll(() => rasterVisibility(page), { timeout: 20_000 }).toEqual({
    landsat: "visible", jaarbak: "none", density: "none", sealed: "visible",
  });
  expect(await page.evaluate(() => window.__heatMap.map.getPaintProperty(
    "landsat-temperature-raster", "raster-opacity",
  ))).toBe(.72);
  if (isMobile) await expandControls(page);
  await page.locator("#analysis-pair-change").click();
  await activateLayer(page, "urban-atlas");
  // Comparison activation renders the adaptive result sheet asynchronously.
  // Wait for that canonical state before reopening mobile controls; otherwise
  // the completed transition can legitimately collapse controls mid-click.
  await expect(page.locator("#active-layer-title")).toContainText("Urban Atlas 2021", { timeout: 20_000 });
  await expect(page.locator("#detail-panel")).toContainText("Temperature distribution by surface", { timeout: 20_000 });
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
  await expect(page.locator("#temporal-output")).toContainText(/12:|12\./);
  await expect(page.locator("#legend-note")).toContainText("exact selected Urban Atlas polygons");
  await expect(page.locator("#layer-context-note")).not.toContainText("28 June to 2 July 2025");
  await expect(page.locator("#detail-panel")).toContainText("not air temperature");
  await expect(page.locator("#detail-panel")).toContainText("Landsat observations");
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
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "true");
  if (isMobile) await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#panel-title")).toHaveText("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Urban Atlas land-cover results");

  await page.locator("#language-toggle").click();
  await expect(page.locator('[data-layer="landsat-temperature"]')).toContainText("Oppervlaktetemperatuur tijdens hittegolven");
  await expect(page.locator("#detail-panel")).toContainText("Temperatuurverdeling per oppervlak");
  await expect(page.locator("#detail-panel")).toContainText("geen luchttemperatuur");
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }
  await activateLayer(page, "jaarbak");
  expect(localRequests.filter((url) => url.includes("/jaarbak/manifest.json"))).toHaveLength(1);
  if (isMobile) {
    await closePanelIfOpen(page);
    await expandControls(page);
  }

  await activateLayer(page, "income");
  await expect(page.locator("#active-layer-title")).toHaveText("Mediaan belastbaar inkomen");
  await expect(page.locator("#temporal-output")).toHaveText("2023");

  await activateLayer(page, "heat");
  await expandControls(page);
  await page.locator("#municipality-select").selectOption("");
  await page.locator("#analysis-compare").click();
  await activateLayer(page, "income");
  await expect(page.locator("#active-layer-title")).toContainText("Hittekwetsbaarheid × mediaan belastbaar inkomen");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  const inlineHeatIncomeChart = page.locator("[data-heat-income-chart]:not(.is-expanded)");
  await expect(inlineHeatIncomeChart).toBeVisible();
  await expect(inlineHeatIncomeChart.locator("[data-scatter-sector]")).toHaveCount(140);
  await expect(page.locator("#detail-panel")).toContainText("140 vergelijkbare sectoren");
  await expect(page.locator("#legend-content")).toContainText("exacte inkomenswaarden");
  if (RUN_VISUAL_REGRESSION) {
    await expect(page.locator("#detail-panel")).toHaveScreenshot("heat-income-comparison.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
  }
  const heatIncomeAccessibility = await new AxeBuilder({ page })
    .include("#detail-panel")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(heatIncomeAccessibility.violations).toEqual([]);
  await inlineHeatIncomeChart.locator("[data-expand-comparison-chart]").click();
  await expect(page.locator("[data-comparison-chart-dialog]")).toContainText("Eindscore en belastbaar inkomen in Hele Zennevallei");
  await expect(page.locator("[data-comparison-chart-dialog] .heat-income-boxplots rect")).not.toHaveCount(0);
  if (RUN_VISUAL_REGRESSION) {
    await expect(page.locator("[data-comparison-chart-dialog]")).toHaveScreenshot("heat-income-expanded.png", {
      animations: "disabled", maxDiffPixelRatio: .001,
    });
  }
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

  await page.locator('[data-panel-heat-metric="vulnerability"]').click();
  await expect(page.locator("#detail-panel")).toContainText("Kwetsbaarheid tegenover mediaan belastbaar inkomen");
  const firstPoint = inlineHeatIncomeChart.locator("[data-scatter-sector]").first();
  await firstPoint.focus();
  await firstPoint.press("ArrowRight");
  expect(await inlineHeatIncomeChart.locator("[data-scatter-sector]").nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
  await expect(inlineHeatIncomeChart.locator("[data-scatter-output]")).toContainText("Mediaan inkomen");

  await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(inlineHeatIncomeChart.locator("[data-scatter-sector]")).toHaveCount(39);
  await expect(page.locator("#detail-panel")).toContainText("39 vergelijkbare sectoren");
  await page.locator("#about-button").click();
  await expect(page.locator("#panel-title")).toHaveText("Over deze kaart");
  await page.locator("#panel-close").click();
  await expect(inlineHeatIncomeChart).toBeVisible();
  await page.locator("#panel-close").click();
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "true");
  await expandControls(page);
  await expect(page.locator("#analysis-pair-result")).toBeVisible();
  await page.locator("#analysis-pair-remove").click();
  expect(await page.evaluate(() => ({
    heat: window.__heatMap.map.getLayoutProperty("heat-sectors-fill", "visibility"),
    income: window.__heatMap.map.getLayoutProperty("statbel-income-fill", "visibility"),
  }))).toEqual({ heat: "visible", income: "none" });
  expect(errors).toEqual([]);
});
