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

test("serves all seven layers from the prepared working catalogue in local-data mode", async ({ page }, testInfo) => {
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
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 45_000 });
  await page.locator("#project-intro-primary").click();
  await expect(page.locator("[data-layer]")).toHaveCount(7);
  await expect(page.locator('[data-layer="land-cover"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="vegetation"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="tree-cover-density"]')).toHaveCount(0);
  expect(localRequests.filter((url) => url.endsWith("manifest.json"))).toEqual([]);
  expect(localRequests.filter((url) => url.endsWith(".pmtiles"))).toEqual([]);

  await page.locator('[data-layer="jaarbak"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Soil sealing 2024");
  await expect(page.locator("#temporal-control")).toBeVisible();
  await expect(page.locator("#temporal-output")).toHaveText("2024");
  await expect(page.locator("#layer-context-note")).toContainText(/provisional/i);
  expect(localRequests.some((url) => url.includes("/jaarbak/manifest.json"))).toBe(true);
  expect(localRequests.some((url) => url.includes("/groenkaart/manifest.json"))).toBe(false);
  expect(localRequests.some((url) => url.includes("/landsat-temperature/manifest.json"))).toBe(false);
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
  if (isMobile) await page.locator("#panel-peek").click();
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
    await page.locator("#panel-close").click();
    await expandControls(page);
  }
  await page.locator("#temporal-previous").click();
  await expect(page.locator("#temporal-output")).toHaveText("2018");

  await page.locator('[data-layer="landsat-temperature"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Landsat surface temperature");
  await expect(page.locator("#temporal-control")).toBeVisible();
  const landsatMapState = await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));
  await page.locator("#analysis-compare").click();
  await expect(page.locator('[data-layer="landsat-temperature"]')).toHaveClass(/is-comparison-primary/);
  for (const target of ["urban-atlas", "jaarbak", "groenkaart", "landgebruik"]) {
    await expect(page.locator(`[data-layer="${target}"]`)).toHaveClass(/is-comparison-target/);
  }
  await expect(page.locator('[data-layer="income"]')).toHaveAttribute("aria-disabled", "true");
  await page.locator('[data-layer="jaarbak"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Soil sealing 2024");
  expect(await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(landsatMapState);
  await page.locator("#temporal-previous").click();
  await expect(page.locator("#temporal-output")).toContainText("Heatwave observation");
  await page.locator("#temporal-next").click();
  if (isMobile) {
    await page.locator("#sector-search").fill("23003A001");
    await page.locator("#sector-search").press("Enter");
  }
  await expect(page.locator(".timeline-marker.is-heatwave")).toHaveCount(2);
  await expect(page.locator(".timeline-marker.is-reference")).toHaveCount(0);
  await expect(page.locator("#legend-title")).toContainText(/12:|12\./);
  await expect(page.locator("#layer-context-note")).toContainText("28 June to 2 July 2025");
  await expect(page.locator("#detail-panel")).toContainText("Median clear-sky surface temperature");
  await expect(page.locator("#detail-panel")).toContainText("36.4");
  await expect(page.locator("#detail-panel")).toContainText("not air temperature");
  await expect(page.locator("#detail-panel")).toContainText("Clear coverage: 91.2%");
  await expect(page.locator("#detail-panel")).toContainText("P10");
  await expect(page.locator("#detail-panel")).toContainText("P90");
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
  if (isMobile) await expandControls(page);
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Municipality overview");
  await expect.poll(() => rangeResponses.some(({ status, url }) => status === 206 && url.includes("halle.pmtiles"))).toBe(true);

  await page.locator("#language-toggle").click();
  await expect(page.locator('[data-layer="landsat-temperature"]')).toContainText("Landsat-oppervlaktetemperatuur");
  await expect(page.locator("#detail-panel")).toContainText("Waarneming tijdens een hittegolf");
  await expect(page.locator("#detail-panel")).toContainText("geen luchttemperatuur");
  if (isMobile) {
    await page.locator("#panel-close").click();
    await expandControls(page);
  }
  await page.locator('[data-layer="jaarbak"]').click();
  expect(localRequests.filter((url) => url.includes("/jaarbak/manifest.json"))).toHaveLength(1);
  if (isMobile) {
    await page.locator("#panel-close").click();
    await expandControls(page);
  }

  await page.locator('[data-layer="landgebruik"]').click();
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
    await page.locator("#panel-close").click();
    await expandControls(page);
  }
  await page.locator("#temporal-previous").click();
  await expect(page.locator('[data-secondary-option="agriculture"]')).toBeDisabled();

  await page.locator('[data-layer="income"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Mediaan belastbaar inkomen");
  await expect(page.locator("#temporal-output")).toHaveText("2023");
  expect(errors).toEqual([]);
});
