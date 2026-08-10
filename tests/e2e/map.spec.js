
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

const runtimeErrors = new WeakMap();

async function findUnobstructedSectorPoint(page, layerId) {
  return page.evaluate((layer) => {
    const map = window.__heatMap.map;
    const canvas = map.getCanvas();
    const canvasBounds = canvas.getBoundingClientRect();
    for (let y = 40; y < canvas.clientHeight - 40; y += 16) {
      for (let x = 40; x < canvas.clientWidth - 40; x += 16) {
        const topElement = document.elementFromPoint(canvasBounds.left + x, canvasBounds.top + y);
        const mapReceivesClick = topElement === canvas || topElement?.closest(".maplibregl-canvas-container");
        if (mapReceivesClick && map.queryRenderedFeatures([x, y], { layers: [layer] }).length) return { x, y };
      }
    }
    return null;
  }, layerId);
}

async function clickHeatMetric(page, metric) {
  const panelButton = page.locator(`[data-panel-heat-metric="${metric}"]`);
  if (await panelButton.isVisible()) {
    await panelButton.click();
    return panelButton;
  }
  const headerButton = page.locator(`[data-heat-metric="${metric}"]`);
  await headerButton.click();
  return headerButton;
}

async function showControls(page, { minimiseResults = true } = {}) {
  // Let a close/minimise request complete before reading the adaptive state.
  // Otherwise a fast test can inspect the previous frame and immediately
  // counteract the layout controller's pending decision.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const panel = page.locator("#detail-panel");
  const adaptive = await page.locator(".map-shell").getAttribute("data-surface-mode") !== "expanded";
  if (adaptive && minimiseResults
    && await panel.getAttribute("aria-hidden") === "false"
    && !await panel.evaluate((element) => element.classList.contains("is-peek"))) {
    await page.locator("#panel-toggle").click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const controls = page.locator("#map-controls");
  if (await controls.evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
  }
  await expect(page.locator("#map-controls-body")).toBeVisible();
  // Opening the adaptive controls preserves the user's previous scroll
  // position. Tests that immediately choose a top-level layer should start
  // from the visible layer grid, just as a user would scroll back to it.
  await controls.evaluate((element) => { element.scrollTop = 0; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await controls.evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#map-controls-toggle").click();
    await expect(page.locator("#map-controls-body")).toBeVisible();
  }
}

async function mapSurfaceState(page) {
  return page.evaluate(() => {
    const entries = [
      ["controls", document.querySelector("#map-controls")],
      ["legend", document.querySelector("#legend")],
      ["results", document.querySelector("#detail-panel")],
      ["native-map-controls", document.querySelector(".maplibregl-ctrl-bottom-right")],
    ].filter(([, element]) => element && element.getClientRects().length && element.getAttribute("aria-hidden") !== "true");
    const rectangles = Object.fromEntries(entries.map(([name, element]) => {
      const rect = element.getBoundingClientRect();
      return [name, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
    }));
    const collisions = [];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const leftRect = rectangles[entries[left][0]];
        const rightRect = rectangles[entries[right][0]];
        const width = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left);
        const height = Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top);
        if (width > 1 && height > 1) collisions.push([entries[left][0], entries[right][0]]);
      }
    }
    return {
      mode: document.querySelector(".map-shell")?.dataset.surfaceMode,
      controlsExpanded: !document.querySelector("#map-controls")?.classList.contains("is-collapsed"),
      legendExpanded: document.querySelector("#legend")?.open,
      panelPresentation: document.querySelector("#detail-panel")?.classList.contains("is-peek") ? "peek" : "expanded",
      collisions,
    };
  });
}

async function waitForSurfaceState(page, expected) {
  await expect.poll(async () => {
    const state = await mapSurfaceState(page);
    return {
      mode: state.mode,
      controlsExpanded: state.controlsExpanded,
      legendExpanded: state.legendExpanded,
      panelPresentation: state.panelPresentation,
      collisions: state.collisions,
    };
  }, { timeout: 2_000 }).toMatchObject({ ...expected, collisions: [] });
  return mapSurfaceState(page);
}

const sectorData = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "public", "data", "sectors.geojson"), "utf8"));
const beerselGeometry = sectorData.features.find((feature) => feature.properties.sectorId === "23003A001").geometry;
const URBAN_ATLAS_GEOJSON = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { sectorId: "23003A001", municipality: "Beersel", classCode: "31000", renderClass: "ua-31000" },
    geometry: beerselGeometry,
  }],
};
const URBAN_ATLAS_FIXTURE = {
  schemaVersion: 1,
  generatedAt: "2026-08-05T10:00:00.000Z",
  available: true,
  activeYear: 2021,
  opacity: 0.68,
  geojsonUrl: "data/urban-atlas.geojson",
  classes: [
    { code: "11100", color: "#800000", groupKey: "artificialSurfaces", artificialGroupKey: "urbanFabric", present: true },
    { code: "12100", color: "#cc4df2", groupKey: "artificialSurfaces", artificialGroupKey: "industryServices", present: true },
    { code: "12220", color: "#b3b3b3", groupKey: "artificialSurfaces", artificialGroupKey: "transport", present: true },
    { code: "13300", color: "#b9a56e", groupKey: "artificialSurfaces", artificialGroupKey: "constructionExtraction", present: true },
    { code: "14110", color: "#8cdc00", groupKey: "greenUrbanAreas", present: true },
    { code: "14120", color: "#74b800", groupKey: "greenUrbanAreas", present: true },
    { code: "14130", color: "#5a8f00", groupKey: "greenUrbanAreas", present: true },
    { code: "14200", color: "#afd2a5", groupKey: "agricultureSemiNatural", present: true },
    { code: "21000", color: "#ffffa8", groupKey: "agricultureSemiNatural", present: true },
    { code: "23000", color: "#e6e64d", groupKey: "agricultureSemiNatural", present: true },
    { code: "31000", color: "#008c00", groupKey: "agricultureSemiNatural", present: true },
    { code: "32000", color: "#ccf24d", groupKey: "agricultureSemiNatural", present: true },
  ],
  sectorStats: {
    "23003A001": {
      validAreaHa: 25,
      dominantClassCode: "31000",
      green: {
        areaHa: 10,
        percentage: 40,
        classes: [
          { code: "31000", areaHa: 5, sectorPercentage: 20, metricPercentage: 50 },
          { code: "32000", areaHa: 2, sectorPercentage: 8, metricPercentage: 20 },
          { code: "23000", areaHa: 1.25, sectorPercentage: 5, metricPercentage: 12.5 },
          { code: "14110", areaHa: 1, sectorPercentage: 4, metricPercentage: 10 },
          { code: "14120", areaHa: 0.5, sectorPercentage: 2, metricPercentage: 5 },
          { code: "14130", areaHa: 0.25, sectorPercentage: 1, metricPercentage: 2.5 },
        ],
      },
      artificial: {
        areaHa: 10,
        percentage: 40,
        classes: [
          { code: "11100", areaHa: 4, sectorPercentage: 16, metricPercentage: 40 },
          { code: "12100", areaHa: 2, sectorPercentage: 8, metricPercentage: 20 },
          { code: "12220", areaHa: 3, sectorPercentage: 12, metricPercentage: 30 },
          { code: "13300", areaHa: 1, sectorPercentage: 4, metricPercentage: 10 },
        ],
      },
      otherClasses: [
        { code: "14200", areaHa: 2, sectorPercentage: 8 },
        { code: "21000", areaHa: 3, sectorPercentage: 12 },
      ],
    },
  },
  source: {
    productUrl: "https://land.copernicus.eu/en/products/urban-atlas/urban-atlas-2021",
    doi: "https://doi.org/10.2909/05ae1ee1-e550-4e66-b74d-4926322d981a",
    accessedAt: "2026-08-05T10:00:00.000Z",
    validationStatus: "not-yet-validated",
    validationStatusCheckedAt: "2026-08-05T10:00:00.000Z",
  },

};
test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.route("**/data/urban-atlas.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(URBAN_ATLAS_FIXTURE) }));
  await page.route("**/data/urban-atlas.geojson", (route) => route.fulfill({ status: 200, contentType: "application/geo+json", body: JSON.stringify(URBAN_ATLAS_GEOJSON) }));
  await page.goto("/");
  await expect(page.locator("#map-loading")).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
  await page.locator("#project-intro-primary").click();
  await page.locator("#language-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
});

test("introduces the personal V0.1 project on every load", async ({ page }) => {
  await page.reload();
  const dialog = page.locator("#project-intro");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(page.locator("#project-intro-primary")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#project-intro-language")).toHaveText("NL");
  await expect(dialog).toContainText("Heat Resilience");
  await expect(dialog).toContainText("urban heat-island effect");
  await expect(dialog).toContainText("Department of Care, Government of Flanders");
  await expect(dialog).toContainText("large language models (LLMs)");
  await expect(dialog.locator('a[href="https://github.com/khookh/zenvallei"]')).toHaveAttribute("rel", "noopener noreferrer");
  await expect(dialog.locator('a[href="mailto:stefanodonne@gmail.com"]')).toHaveText("Send feedback");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 20_000 });
  await expect(page.locator('[data-layer="heat"]')).toHaveAttribute("aria-pressed", "true");

  const accessibilityResults = await new AxeBuilder({ page })
    .include("#project-intro")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibilityResults.violations).toEqual([]);

  await page.locator("#project-intro-language").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(dialog).toContainText("Heat Resilience");
  await expect(dialog).toContainText("stedelijk hitte-eilandeffect");
  await expect(dialog).toContainText("grote taalmodellen (LLM’s)");
  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#about-button")).toBeFocused();
  expect(await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
  }))).toEqual({ local: 0, session: 0, cookies: "" });

  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("#project-intro-close").click();
  await expect(dialog).not.toBeVisible();
});

test("serves provider-neutral security headers", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
});

test("keeps complete map attribution collapsed until requested", async ({ page }) => {
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  const attributionButton = page.locator(".maplibregl-ctrl-attrib-button");
  const attributionDetails = page.locator(".maplibregl-ctrl-attrib-inner");

  await expect(attribution).not.toHaveAttribute("open", "");
  await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);
  await expect(attributionButton).toHaveAttribute("aria-expanded", "false");
  await expect(attributionButton).toHaveCSS("width", "44px");
  await expect(attributionButton).toHaveCSS("height", "44px");
  await expect(attributionButton).toHaveCSS("background-repeat", "no-repeat");
  await expect(attributionButton).toHaveCSS("background-position", "50% 50%");
  await expect(attributionButton).toHaveCSS("background-size", "24px 24px");
  await expect(attributionDetails).toBeHidden();

  // Expanded map controls intentionally occupy most of a narrow screen. The
  // app's disclosure leaves the map controls, including attribution, reachable.
  const controlsToggle = page.locator("#map-controls-toggle");
  if (await controlsToggle.isVisible()) await controlsToggle.click();

  await attributionButton.click();
  await expect(attribution).toHaveClass(/maplibregl-compact-show/);
  await expect(attributionButton).toHaveAttribute("aria-expanded", "true");
  await expect(attributionDetails).toBeVisible();
  await expect(attributionDetails).toContainText("DOI");
  await expect(attributionDetails).toContainText("Urban Atlas DOI");

  await attributionButton.click();
  await expect(attribution).not.toHaveClass(/maplibregl-compact-show/);
  await expect(attributionButton).toHaveAttribute("aria-expanded", "false");
  await expect(attributionDetails).toBeHidden();
});

test("discloses map controls without changing exploration state", async ({ page }) => {
  const controls = page.locator("#map-controls");
  const controlsBody = page.locator("#map-controls-body");
  const controlsToggle = page.locator("#map-controls-toggle");

  await expect(controlsBody).toBeVisible();
  await expect(controlsToggle).toBeVisible();
  await expect(controlsToggle).toHaveCSS("width", "44px");
  await expect(controlsToggle).toHaveCSS("height", "44px");
  await expect(controlsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(controlsToggle).toHaveAttribute("aria-label", "Kaartbediening inklappen");

  await page.locator('[data-heat-metric="vulnerability"]').click();
  await page.locator("#municipality-select").selectOption("Beersel");
  await showControls(page);
  const search = page.locator("#sector-search");

  await search.fill("23003A001");
  await search.press("Enter");
  await showControls(page);
  await page.locator('[data-layer="urban-atlas"]').click();
  await page.waitForFunction(() => window.__heatMap.getActiveLayer() === "urban-atlas");
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#detail-panel")).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await expect(search).toHaveValue("");
  await showControls(page);
  const stateBeforeCollapse = await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    heatMetric: window.__heatMap.getHeatMetric(),
    selectedFilter: window.__heatMap.map.getFilter("heat-sector-selected"),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));

  await controlsToggle.click();
  await expect(controls).toHaveClass(/is-collapsed/);
  await expect(controlsBody).toBeHidden();
  await expect(page.locator("#map-controls-title")).toBeVisible();
  await expect(page.locator("#about-button")).toBeHidden();
  await expect(controlsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(controlsToggle).toHaveAttribute("aria-label", "Kaartbediening uitklappen");
  await expect(page.locator("#map-controls-toggle-icon")).toHaveText("+");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
  expect(await page.evaluate(() => ({
    activeLayer: window.__heatMap.getActiveLayer(),
    heatMetric: window.__heatMap.getHeatMetric(),
    selectedFilter: window.__heatMap.map.getFilter("heat-sector-selected"),
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(stateBeforeCollapse);

  const collapsedResults = await new AxeBuilder({ page })
    .include("#map-controls")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(collapsedResults.violations).toEqual([]);

  await page.locator("#language-toggle").click();
  await expect(page.locator("#map-controls-title")).toHaveText("What would you like to look at?");
  await expect(controlsToggle).toHaveAttribute("aria-label", "Expand map controls");
  await controlsToggle.click();
  await expect(controlsBody).toBeVisible();
  await expect(controlsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(controlsToggle).toHaveAttribute("aria-label", "Collapse map controls");
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
  await expect(search).toHaveValue("");

  const expandedResults = await new AxeBuilder({ page })
    .include("#map-controls")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(expandedResults.violations).toEqual([]);
});

test("keeps controls, legend and results collision-free across adaptive layouts", async ({ page }) => {
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  const indicators = page.locator('details[data-section="indicators"]');
  const indicatorSummary = indicators.locator("summary").first();
  await indicatorSummary.focus();
  await indicatorSummary.press("Enter");
  await expect(indicators).toHaveAttribute("open", "");

  for (const viewport of [
    { width: 1440, height: 900, mode: "expanded" },
    { width: 1280, height: 720, mode: "expanded" },
    { width: 1024, height: 768, mode: "medium" },
    { width: 768, height: 1024, mode: "medium" },
    { width: 390, height: 844, mode: "compact" },
    { width: 320, height: 568, mode: "compact" },
  ]) {
    await page.setViewportSize(viewport);
    const state = await waitForSurfaceState(page, viewport.mode === "expanded"
      ? { mode: viewport.mode }
      : {
          mode: viewport.mode,
          controlsExpanded: false,
          legendExpanded: false,
          panelPresentation: "expanded",
        });
    expect(state.mode).toBe(viewport.mode);
    expect(state.collisions, `${viewport.width} by ${viewport.height}`).toEqual([]);

    if (viewport.mode !== "expanded") {
      expect(state.controlsExpanded).toBe(false);
      expect(state.legendExpanded).toBe(false);
      expect(state.panelPresentation).toBe("expanded");

      await page.locator("#map-controls-toggle").click();
      const controlsState = await waitForSurfaceState(page, {
        controlsExpanded: true,
        legendExpanded: false,
        panelPresentation: "peek",
      });
      expect(controlsState.controlsExpanded).toBe(true);
      expect(controlsState.legendExpanded).toBe(false);
      expect(controlsState.panelPresentation).toBe("peek");
      expect(controlsState.collisions).toEqual([]);
      if (viewport.width === 320) {
        const compactMetrics = await page.evaluate(() => ({
          fontSizes: [".layer-category-title", ".layer-button", ".layer-context-copy", ".field-label"]
            .map((selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)),
          targetHeights: [...document.querySelectorAll(".layer-button")]
            .map((element) => element.getBoundingClientRect().height),
        }));
        compactMetrics.fontSizes.forEach((size) => expect(size).toBeGreaterThanOrEqual(12));
        compactMetrics.targetHeights.forEach((height) => expect(height).toBeGreaterThanOrEqual(44));
        const compactAccessibility = await new AxeBuilder({ page })
          .include("#map-controls")
          .include("#detail-panel")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(compactAccessibility.violations).toEqual([]);
      }

      await page.locator("#legend > summary").click();
      const legendState = await waitForSurfaceState(page, {
        controlsExpanded: false,
        legendExpanded: true,

        panelPresentation: "peek",
      });
      expect(legendState.controlsExpanded).toBe(false);
      expect(legendState.legendExpanded).toBe(true);
      expect(legendState.panelPresentation).toBe("peek");
      expect(legendState.collisions).toEqual([]);

      await page.locator("#panel-peek").click();
      await page.waitForTimeout(220);
    }
  }

  // A 1280 by 720 viewport at 200% browser zoom exposes 640 CSS pixels.
  await page.setViewportSize({ width: 640, height: 360 });
  const zoomed = await waitForSurfaceState(page, { mode: "compact" });
  expect(zoomed.mode).toBe("compact");
  expect(zoomed.collisions).toEqual([]);
  await expect(indicators).toHaveAttribute("open", "");
});

test("keeps local sectors usable when basemap tiles are unavailable", async ({ page }) => {
  await page.route("**/__test-tile.png", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 20_000 });
  await expect(page.locator("#layer-context-note")).toContainText("background temporarily unavailable");
  await expect(page.locator("#selection-announcement")).toContainText("background temporarily unavailable");
  await expect(page.locator("#sector-options option")).toHaveCount(154);

  const expectedNetworkErrors = runtimeErrors.get(page);
  expect(expectedNetworkErrors.length).toBeGreaterThan(0);
  expect(expectedNetworkErrors.every((message) => message.includes("Failed to load resource"))).toBe(true);
  runtimeErrors.set(page, []);
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page), "De app mag geen browserfouten loggen").toEqual([]);
});

test("matches the refined hierarchy in Dutch and English", async ({ page }) => {
  test.skip(process.env.CI === "true", "Visual baselines are validated on the Windows design workstation.");
  await expect(page.locator(".app-header")).toHaveScreenshot("header-nl.png", { animations: "disabled" });
  await expect(page.locator("#map-controls")).toHaveScreenshot("controls-nl.png", { animations: "disabled" });

  await page.locator("#language-toggle").click();
  await expect(page.locator(".app-header")).toHaveScreenshot("header-en.png", { animations: "disabled" });
  await expect(page.locator("#map-controls")).toHaveScreenshot("controls-en.png", { animations: "disabled" });
  await page.locator('[data-heat-metric="vulnerability"]').click();
  await expect(page.locator(".app-header")).toHaveScreenshot("header-vulnerability-en.png", { animations: "disabled" });

  await page.locator("#language-toggle").click();
  await page.locator("#municipality-select").selectOption("Beersel");
  await showControls(page);
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await page.reload();
  await expect(page.locator("#project-intro")).toHaveScreenshot("project-intro-en.png", { animations: "disabled" });
  await page.locator("#project-intro-language").click();
  await expect(page.locator("#project-intro")).toHaveScreenshot("project-intro-nl.png", { animations: "disabled" });
});

test("loads all sectors and opens a complete score breakdown from search", async ({ page }) => {
  await expect(page).toHaveTitle("Zennevallei - heat resilience");
  await expect(page.locator(".brand-mark")).toBeVisible();
  await expect(page.locator(".brand-mark")).toHaveAttribute("src", /assets\/zennevallei-river-mark\.png$/);
  await expect(page.locator(".eyebrow")).toHaveText("Zennevallei");
  await expect(page.locator("[data-layer]")).toHaveCount(8);
  await expect(page.locator(".layer-category")).toHaveCount(3);
  await expect(page.locator('[data-layer-category="heat"]')).toContainText("Hitte");
  await expect(page.locator('[data-layer-category="land-green"]')).toContainText("Landgebruik");
  await expect(page.locator('[data-layer-category="demography"]')).toContainText("Demografie");
  await expect(page.locator('[data-layer-category="heat"] [data-layer]')).toHaveCount(2);
  await expect(page.locator('[data-layer-category="land-green"] [data-layer]')).toHaveCount(4);
  await expect(page.locator('[data-layer-category="demography"] [data-layer]')).toHaveCount(2);
  await expect(page.locator("[data-heat-metric]")).toHaveCount(3);
  await expect(page.locator("#heat-metric-control")).toBeVisible();
  await expect(page.locator('[data-heat-metric="final"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-layer="change"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveText("Urban Atlas 2021");
  await expect(page.locator('[data-layer="land-cover"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="vegetation"]')).toHaveCount(0);
  await expect(page.locator("#dataset-status")).toHaveCount(0);
  await expect(page.locator("#visible-count")).toHaveText("154 sectoren");
  await expect(page.locator("#about-button")).toContainText("Uitleg");
  await expect(page.locator("#layer-context-meta")).toHaveText("Officiële broncijfers · 154 Statbel-sectoren · 2026");
  await expect(page.locator("#layer-context-copy")).toContainText("Departement Zorg");
  await expect(page.locator("#layer-context-copy")).toContainText("wij tonen ze zonder herberekening");
  await expect(page.locator("#layer-context-sources")).toContainText("Departement Zorg van de Vlaamse overheid");
  await expect(page.locator("#analysis-pairing")).toBeVisible();
  await expect(page.locator("#analysis-compare")).toHaveText(/Vergelijken/);
  const comparisonMapState = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
    activeLayer: window.__heatMap.getActiveLayer(),
  }));
  await page.locator("#analysis-compare").click();
  await expect(page.locator("#layer-switch")).toHaveClass(/is-comparison-mode/);
  await expect(page.locator('[data-layer="income"]')).toHaveClass(/is-comparison-target/);
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveAttribute("aria-disabled", "true");
  await page.locator('[data-layer="income"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Mediaan belastbaar inkomen");
  await expect(page.locator("#analysis-pair-note")).toContainText("nog geen extra laag");
  expect(await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
    activeLayer: window.__heatMap.getActiveLayer(),
  }))).toEqual(comparisonMapState);
  expect(await page.evaluate(() => window.__heatMap.map.getLayer("statbel-income-fill")
    && window.__heatMap.map.getLayoutProperty("statbel-income-fill", "visibility"))).not.toBe("visible");
  await page.locator("#analysis-pair-change").click();
  await expect(page.locator('[data-layer="income"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#analysis-pair-change")).toBeFocused();
  await expect(page.locator("#layer-switch")).not.toHaveClass(/is-comparison-mode/);
  await page.locator("#analysis-pair-remove").click();
  await expect(page.locator("#analysis-compare")).toBeFocused();
  await expect(page.locator("#analysis-pair-result")).toBeHidden();
  const overlayRenderMs = await page.evaluate(() => performance.getEntriesByName("heat-overlay-first-render")[0]?.duration);
  // Shared GitHub runners have variable scheduling overhead. Keep the product's
  // 500 ms workstation gate while allowing a small, explicit CI-only margin.
  const overlayRenderBudgetMs = process.env.CI === "true" ? 750 : 500;
  expect(overlayRenderMs).toBeLessThan(overlayRenderBudgetMs);
  const search = page.locator("#sector-search");

  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel).toContainText("BEERSEL-KERN");
  await expect(panel).toContainText("Score 6 van 10");
  await expect(panel).toContainText("Hitte");
  await expect(panel).toContainText("Kwetsbaarheid");
  await expect(panel.locator(".summary-card").filter({ hasText: "Hitte" })).toContainText("7");
  await expect(panel.locator(".summary-card").filter({ hasText: "Kwetsbaarheid" })).toContainText("8");
  await expect(panel).toContainText("Relatieve rangschikking van het gemiddelde aantal hittegolfgraaddagen");
  await expect(panel).toContainText("geen eenvoudig gemiddelde");
  await expect(panel).toContainText("Officieel broncijfer");
  await panel.getByText("Bekijk alle kwetsbaarheidsindicatoren").click();
  await expect(panel).toContainText("3,75");
  await expect(panel).toContainText("gewicht 2");
});

test("maps Statbel median taxable income without creating municipality medians", async ({ page }) => {
  await page.locator('[data-layer="income"]').click();
  await expect(page.locator("#active-layer-title")).toHaveText("Mediaan belastbaar inkomen");
  await expect(page.locator("#temporal-output")).toHaveText("2023");
  await expect(page.locator("#legend-title")).toContainText("Mediaan netto belastbaar inkomen");
  await expect(page.locator("#layer-context-sources")).toContainText("Statbel");
  await showControls(page);
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await expect(page.locator("#detail-panel")).toContainText("Mediaan netto belastbaar inkomen per aangifte");
  await expect(page.locator("#detail-panel")).toContainText("geen loon, beschikbaar gezinsinkomen of vermogen");
  await expect(page.locator("#detail-panel")).toContainText("Hoge waarden wegen hierin sterker door dan in de mediaan");
  await expect(page.locator("#detail-panel")).toContainText("geen inwoners of huishoudens");
  await expect(page.locator("#detail-panel")).toContainText("Q3 − Q1");
  await expect(page.locator("#detail-panel")).toContainText("relatieve spreiding tussen sectoren");
  await expect(page.locator("#detail-panel")).toContainText("geen volledige verdeling over inkomensklassen");
  await page.locator("#panel-close").click();
  await showControls(page, { minimiseResults: false });
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "true");
});

test("switches between combined, heat and vulnerability scores without losing exploration state", async ({ page }) => {
  await page.locator("#municipality-select").selectOption("Beersel");
  await showControls(page);
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await panel.locator('[data-section="indicators"] > summary').focus();
  await panel.locator('[data-section="indicators"] > summary').press("Enter");
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const mapStateBefore = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));
  const sectorColor = () => page.evaluate(() => {
    const expression = window.__heatMap.map.getPaintProperty("heat-sectors-fill", "fill-color");
    const index = expression.indexOf("23003A001");
    return expression[index + 1];
  });
  expect(await sectorColor()).toBe("#B10064");

  const mapSwitchDuration = await page.evaluate(() => {
    window.__heatMap.setHeatMetric("final");
    const started = performance.now();
    window.__heatMap.setHeatMetric("heat");
    return performance.now() - started;
  });
  expect(mapSwitchDuration).toBeLessThan(100);

  const heatButton = await clickHeatMetric(page, "heat");
  await expect(heatButton).toBeFocused();
  await expect(heatButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#active-layer-title")).toHaveText("Hittekwetsbaarheid · Hitte");
  await expect(page.locator("#legend-title")).toHaveText("Hittescore");
  await expect(page.locator("#layer-context-meta")).toContainText("Officiële hittescore");
  await expect(page.locator("#layer-context-copy")).toContainText("hittegolfgraaddagen in 2000–2019");
  await expect(page.locator("#map canvas")).toHaveAttribute("aria-label", "Interactieve kaart: Hittekwetsbaarheid · Hitte in de Zennevallei");
  await expect(page.locator("#selection-announcement")).toContainText("gewijzigd naar Hitte");
  expect(await sectorColor()).toBe("#96004E");
  await expect(panel.locator(".score-orb strong")).toHaveText("7");
  await expect(panel.locator(".score-caption")).toContainText("Hitte: 7 van 10");
  await expect(panel.locator(".summary-card").nth(0)).toContainText("Eindscore");
  await expect(panel.locator(".summary-card").nth(0)).toContainText("6");
  await expect(panel.locator(".summary-card").nth(1)).toContainText("Kwetsbaarheid");
  await expect(panel.locator(".summary-card").nth(1)).toContainText("8");
  await expect(panel.locator('[data-section="indicators"]')).toHaveAttribute("open", "");

  if (!await page.locator('[data-panel-heat-metric="heat"]').isVisible()) {
    const hoverPoint = await findUnobstructedSectorPoint(page, "heat-sectors-hit-area");
    expect(hoverPoint).not.toBeNull();
    await page.locator("#map canvas").hover({ position: hoverPoint });
    await expect(page.locator(".sector-tooltip b")).toContainText("Hitte:");
  }

  const vulnerabilityButton = await clickHeatMetric(page, "vulnerability");
  await expect(vulnerabilityButton).toBeFocused();
  await expect(page.locator("#active-layer-title")).toHaveText("Hittekwetsbaarheid · Kwetsbaarheid");
  await expect(page.locator("#legend-title")).toHaveText("Kwetsbaarheidsscore");
  expect(await sectorColor()).toBe("#7C003A");
  await expect(panel.locator(".score-orb strong")).toHaveText("8");
  await expect(panel.locator(".score-caption")).toContainText("Kwetsbaarheid: 8 van 10");
  await expect(panel.locator(".summary-card").nth(0)).toContainText("Eindscore");
  await expect(panel.locator(".summary-card").nth(0)).toContainText("6");
  await expect(panel.locator(".summary-card").nth(1)).toContainText("Hitte");
  await expect(panel.locator(".summary-card").nth(1)).toContainText("7");
  await expect(panel.locator('[data-section="indicators"]')).toHaveAttribute("open", "");
  expect(await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(mapStateBefore);

  await page.locator("#language-toggle").click();
  await expect(page.locator("#active-layer-title")).toHaveText("Heat vulnerability · Vulnerability");
  await expect(vulnerabilityButton).toHaveText("Vulnerability");
  await expect(panel.locator(".score-caption")).toContainText("Vulnerability: 8 out of 10");

  await showControls(page);
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator("#heat-metric-control")).toBeHidden();
  await showControls(page);
  await page.locator('[data-layer="heat"]').click();
  await expect(page.locator("#heat-metric-control")).toBeVisible();

  await expect(page.locator('[data-heat-metric="vulnerability"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(search).toHaveValue("");

  await page.reload();
  await expect(page.locator("#map-loading")).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('[data-heat-metric="final"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#active-layer-title")).toHaveText("Heat vulnerability");
});

test("switches the complete interface to English without resetting exploration state", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page).toHaveTitle("Zennevallei - heat resilience");
  await expect(page.locator("#language-toggle")).toHaveText("EN");

  await page.locator("#municipality-select").selectOption("Beersel");
  await expect(page.locator("#visible-count")).toHaveText("39 sectoren");
  await showControls(page);
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await panel.locator('[data-section="indicators"] > summary').focus();
  await panel.locator('[data-section="indicators"] > summary').press("Enter");
  await panel.locator('[data-section="ses"] > summary').focus();
  await panel.locator('[data-section="ses"] > summary').press("Enter");
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const mapStateBefore = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));

  await page.locator("#language-toggle").click();
  await expect(page.locator("#language-toggle")).toBeFocused();
  await expect(page.locator("#language-toggle")).toHaveText("NL");
  await expect(page.locator("#language-toggle")).toHaveAttribute("lang", "nl");
  await expect(page.locator("#language-toggle")).toHaveAttribute("aria-label", "Switch to Dutch");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle("Zennevallei - heat resilience");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /statistical sectors/);
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
  await expect(page.locator("#visible-count")).toHaveText("39 sectors");
  await expect(search).toHaveValue(/23003A001/);
  await expect(search).toHaveAttribute("placeholder", "Name or sector code");
  await expect(page.locator("#legend-content")).toContainText("Insufficient data");
  await expect(page.locator("#layer-context-meta")).toHaveText("Official source values · 154 Statbel sectors · 2026");
  await expect(page.locator("#layer-context-copy")).toContainText("we display them without recalculation");
  await expect(page.locator("#layer-context-sources")).toContainText("Department of Care, Government of Flanders");
  await expect(panel).toContainText("Scores: Department of Care, Government of Flanders (2026)");
  await expect(page.locator(".maplibregl-ctrl-zoom-in")).toHaveAttribute("aria-label", "Zoom in");
  await expect(page.locator("#selection-announcement")).toContainText("Details opened");
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel).toContainText("Score 6 out of 10");
  await expect(panel.locator(".summary-card").filter({ hasText: "Heat" })).toContainText("7");
  await expect(panel.locator(".summary-card").filter({ hasText: "Vulnerability" })).toContainText("8");
  await expect(panel).toContainText("3.75");
  await expect(panel).toContainText("weight 2");
  await expect(panel.locator('[data-section="indicators"]')).toHaveAttribute("open", "");
  await expect(panel.locator('[data-section="ses"]')).toHaveAttribute("open", "");
  const mapStateAfter = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));
  expect(mapStateAfter).toEqual(mapStateBefore);

  await page.locator("#language-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(panel).toContainText("Score 6 van 10");
  await page.reload();
  await expect(page.locator("#map-loading")).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#language-toggle")).toHaveText("NL");
});

test("loads Urban Atlas lazily and presents green and artificialisation statistics", async ({ page }) => {
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  const atlasButton = page.locator('[data-layer="urban-atlas"]');
  await expect(atlasButton).toHaveAttribute("aria-disabled", "false");
  await showControls(page);
  await atlasButton.click();
  await page.waitForFunction(() => window.__heatMap.map.getLayer("urban-atlas-fill")
    && window.__heatMap.map.getLayoutProperty("urban-atlas-fill", "visibility") === "visible");
  const firstRender = await page.evaluate(() => performance.getEntriesByName("urban-atlas-first-render")[0]?.duration);
  expect(firstRender).toBeLessThan(1_500);
  await expect(panel).toBeFocused();
  await expect(atlasButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#legend-title")).toHaveText("Urban Atlas-landbedekking 2021");
  await expect(page.locator("#layer-context-meta")).toContainText("geïnterpreteerde polygonen · 2021");
  await expect(page.locator("#layer-context-copy")).toContainText("landbedekking en landgebruik");
  await expect(page.locator("#layer-context-copy")).toContainText("Wij berekenen groenbedekking");
  await expect(page.locator("#map canvas")).toHaveAttribute("aria-label", "Interactieve kaart: Urban Atlas 2021 in de Zennevallei");
  await expect(page.locator("#legend-content")).toContainText("Kunstmatige oppervlakken");
  await expect(page.locator("#legend-content")).toContainText("Kruidachtige vegetatie");
  await expect(page.locator("#legend-content")).toContainText("Groen stedelijk gebied (publieke toegang)");
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Urban Atlas DOI");
  expect(await page.evaluate(() => window.__heatMap.map.getPaintProperty("urban-atlas-fill", "fill-opacity"))).toBe(0.68);
  expect(await page.evaluate(() => window.__heatMap.map.getPaintProperty("urban-atlas-fill", "fill-color"))).toContain("#ccf24d");

  await showControls(page);
  await search.fill("23003A001");
  await search.press("Enter");
  await expect(panel).toContainText("Dominante Urban Atlas-klasse");
  await expect(panel).toContainText("Bossen");
  await expect(panel.locator(".summary-card").filter({ hasText: "Groenbedekking" })).toContainText("40%");
  await expect(panel.locator(".summary-card").filter({ hasText: "Artificialisering" })).toContainText("40%");
  await expect(panel).toContainText("Kruidachtige vegetatie");
  await expect(panel).toContainText("Weilanden");
  await expect(panel).toContainText("publieke toegang");
  await expect(panel).toContainText("private toegang");
  await expect(panel).toContainText("toegang onbekend");
  await expect(panel).toContainText("Bouwterreinen");
  await expect(panel).toContainText("Berekend door deze toepassing");
  await expect(panel.locator('[data-section="urban-atlas-other"]')).not.toHaveAttribute("open", "");
  const subsequentSwitch = await page.evaluate(async () => {
    await window.__heatMap.setLayer("heat");
    const started = performance.now();
    await window.__heatMap.setLayer("urban-atlas");
    return performance.now() - started;
  });
  expect(subsequentSwitch).toBeLessThan(100);

  await page.locator("#language-toggle").click();
  await expect(atlasButton).toHaveText("Urban Atlas 2021");
  await expect(page.locator("#legend-title")).toHaveText("Urban Atlas land cover 2021");
  await expect(panel).toContainText("Green coverage");
  await expect(panel).toContainText("Herbaceous vegetation");
  await expect(panel).toContainText("Pastures");
  await expect(panel).toContainText("not yet validated");

  await expect(panel.locator('[data-section="urban-atlas-green"]')).toHaveAttribute("open", "");

  await page.locator("#language-toggle").click();
  const municipalityCounts = {
    Beersel: 39,
    Drogenbos: 7,
    Halle: 41,
    Linkebeek: 7,
    Pepingen: 15,
    "Sint-Genesius-Rode": 22,
    "Sint-Pieters-Leeuw": 23,
  };
  for (const [municipality, count] of Object.entries(municipalityCounts)) {
    await showControls(page);
    await page.locator("#municipality-select").selectOption(municipality);
    await expect(page.locator("#visible-count")).toHaveText(`${count} sectoren`);
    expect(await page.evaluate(() => window.__heatMap.map.getFilter("urban-atlas-fill"))).toEqual(["==", ["get", "municipality"], municipality]);
  }
});

test("filters all environmental overlays and opens area-weighted municipality summaries", async ({ page }) => {
  const panel = page.locator("#detail-panel");
  await page.locator("#municipality-select").selectOption("Beersel");
  await expect(panel).toHaveAttribute("aria-hidden", "true");

  await showControls(page);
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await expect(panel).toContainText("Groenbedekking");
  await expect(panel).toContainText("40%");
  expect(await page.evaluate(() => window.__heatMap.map.getFilter("urban-atlas-fill"))).toEqual(["==", ["get", "municipality"], "Beersel"]);

  await showControls(page);
  const search = page.locator("#sector-search");

  await search.fill("23003A001");
  await search.press("Enter");
  await expect(panel).toContainText("23003A001");
  await expect(panel).not.toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await page.locator("#municipality-select").dispatchEvent("click");
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await expect(search).toHaveValue("");

  await showControls(page);
  await search.fill("23003A001");
  await search.press("Enter");
  await page.locator("#panel-close").click();
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");

  await showControls(page);
  await page.locator('[data-layer="heat"]').click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});

test("closes stale results on layer changes and opens meaningful Zennevallei summaries", async ({ page }) => {
  const panel = page.locator("#detail-panel");
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await expect(panel).toHaveAttribute("aria-hidden", "false");

  const summaries = [
    ["urban-atlas", "Groenbedekking"],
    ["jaarbak", "Afgedekte oppervlakte"],
    ["groenkaart", "Hoog groen"],
    ["landgebruik", "Grootste klasse"],
  ];
  for (const [layerId, expectedText] of summaries) {
    await showControls(page);
    await page.locator(`[data-layer="${layerId}"]`).click();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator("#sector-search")).toHaveValue("");
    await expect(panel).toContainText("HELE ZENNEVALLEI · 154 STATBEL-SECTOREN");
    await expect(panel).toContainText(expectedText);
    if (layerId === "groenkaart") {
      await showControls(page);
      await page.locator("#municipality-select").selectOption("Halle");
      await expect(panel).toContainText("Gemeenteoverzicht · 41 Statbel-sectoren");
      await showControls(page);
      await page.locator("#municipality-select").selectOption("");
      await expect(panel).toContainText("HELE ZENNEVALLEI · 154 STATBEL-SECTOREN");
    }
  }
});

test("loads the published 100 m density modes only when requested", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("/density/") && request.url().endsWith(".tif")) requests.push(request.url());
  });
  await showControls(page);
  await page.locator('[data-layer="jaarbak"]').click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.map.getLayoutProperty(
    "jaarbak-local-raster", "visibility",
  ))).toBe("visible");
  expect(requests).toEqual([]);
  await showControls(page);
  await page.locator("#map-mode-action").click();
  await expect(page.locator("#map-mode-action")).toHaveText("Toon classificatie");
  await expect(page.locator("#legend-title")).toContainText("Dichtheid bodemafdekking");
  await expect.poll(() => requests.some((url) => url.includes("jaarbak-2024-density.tif"))).toBe(true);
  await expect.poll(() => page.evaluate(() => ({
    classification: window.__heatMap.map.getLayoutProperty("jaarbak-local-raster", "visibility"),
    density: window.__heatMap.map.getLayoutProperty("jaarbak-density-raster", "visibility"),
  }))).toEqual({ classification: "none", density: "visible" });
  await showControls(page);
  await page.locator("#map-mode-action").click();
  await expect.poll(() => page.evaluate(() => ({
    classification: window.__heatMap.map.getLayoutProperty("jaarbak-local-raster", "visibility"),
    density: window.__heatMap.map.getLayoutProperty("jaarbak-density-raster", "visibility"),
  }))).toEqual({ classification: "visible", density: "none" });
  await page.locator('[data-layer="groenkaart"]').click();
  await expect.poll(() => page.evaluate(() => window.__heatMap.map.getLayoutProperty(
    "groenkaart-local-raster", "visibility",
  ))).toBe("visible");
  await showControls(page);
  await page.locator("#map-mode-action").click();
  await expect(page.locator("#legend-title")).toContainText("Dichtheid geselecteerde Groenkaartklassen");
  await expect.poll(() => requests.some((url) => url.includes("groenkaart-2021-density.tif"))).toBe(true);
  await expect.poll(() => page.evaluate(() => ({
    classification: window.__heatMap.map.getLayoutProperty("groenkaart-local-raster", "visibility"),
    density: window.__heatMap.map.getLayoutProperty("groenkaart-density-raster", "visibility"),
  }))).toEqual({ classification: "none", density: "visible" });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.locator("#map-mode-action").click();
    await expect.poll(() => page.evaluate(() => ({
      classification: window.__heatMap.map.getLayoutProperty("groenkaart-local-raster", "visibility"),
      density: window.__heatMap.map.getLayoutProperty("groenkaart-density-raster", "visibility"),
    }))).toEqual({ classification: "visible", density: "none" });
    if (cycle === 0) {
      await page.locator("#temporal-previous").click();
      await expect(page.locator("#temporal-output")).toHaveText("2018");
      await page.locator("#municipality-select").selectOption("Halle");
      await showControls(page);
    }
    await page.locator("#map-mode-action").click();
    await expect.poll(() => page.evaluate(() => ({
      classification: window.__heatMap.map.getLayoutProperty("groenkaart-local-raster", "visibility"),
      density: window.__heatMap.map.getLayoutProperty("groenkaart-density-raster", "visibility"),
    }))).toEqual({ classification: "none", density: "visible" });
  }
  await page.locator("#map-mode-action").click();
  await expect.poll(() => page.evaluate(() => ({
    classification: window.__heatMap.map.getLayoutProperty("groenkaart-local-raster", "visibility"),
    density: window.__heatMap.map.getLayoutProperty("groenkaart-density-raster", "visibility"),
  }))).toEqual({ classification: "visible", density: "none" });
  expect(runtimeErrors.get(page)).toEqual([]);
});

test("filters the map and exposes no-data sectors honestly", async ({ page }) => {
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#visible-count")).toHaveText("41 sectoren");
  await showControls(page);
  const search = page.locator("#sector-search");
  await search.fill("23027A183");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await expect(panel).toContainText("SMEERHOUT");
  await expect(panel).toContainText("Onvoldoende gegevens");
  await expect(panel).toContainText("onvoldoende bevolkings- of SES-gegevens");
  await clickHeatMetric(page, "heat");
  await expect(panel.locator(".score-orb strong")).toHaveText("n.v.t.");
  await expect(panel).toContainText("Onvoldoende gegevens");
  await clickHeatMetric(page, "vulnerability");
  await expect(panel.locator(".score-orb strong")).toHaveText("n.v.t.");
  await page.locator("#language-toggle").click();
  await expect(panel).toContainText("Insufficient data");
  await expect(panel).toContainText("population or SES information is insufficient");
  await page.locator("#panel-close").click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});

test("opens a sector by clicking the rendered overlay", async ({ page }) => {
  await page.locator("#language-toggle").click();
  const controlsToggle = page.locator("#map-controls-toggle");
  if (await controlsToggle.isVisible()) await controlsToggle.click();
  await page.evaluate(() => new Promise((resolve) => {
    const map = window.__heatMap.map;
    const timeout = window.setTimeout(resolve, 3_000);
    map.once("idle", () => {
      window.clearTimeout(timeout);
      resolve();
    });
    map.triggerRepaint();
  }));
  const clickPoint = await findUnobstructedSectorPoint(page, "heat-sectors-fill");
  expect(clickPoint).not.toBeNull();
  await page.locator("#map canvas").click({ position: clickPoint });
  await expect(page.locator("#detail-panel")).toHaveAttribute("aria-hidden", "false");
});

test("offers an accessible explanatory layer", async ({ page }) => {
  await page.locator("#language-toggle").click();
  await page.locator("#about-button").click();
  const panel = page.locator("#detail-panel");
  await expect(panel).toContainText("About this map");
  await expect(panel).toContainText("How to use the map");
  await expect(panel).toContainText("What each layer tells you");
  await expect(panel).toContainText("Land use");
  await expect(panel).toContainText("Why 154 sectors?");
  await expect(panel).toContainText("Statbel defines their codes and boundaries");
  await expect(panel).toContainText("Official producer");
  await expect(panel).toContainText("What we add");
  await expect(panel).toContainText("OpenStreetMap is only the background map");
  await expect(panel).toContainText("A personal and open V0.1 project");
  await expect(panel).toContainText("large language models (LLMs)");
  await expect(panel.locator('a[href="https://github.com/khookh/zenvallei"]')).toHaveAttribute("rel", "noopener noreferrer");
  await expect(panel).toContainText("This application uses no cookies, analytics, accounts or persistent identifiers");
  await expect(panel).toContainText("GitHub Pages records visitors' IP addresses");
  await expect(panel).toContainText("OpenStreetMap receives ordinary request information");
  await expect(panel.locator('.about-privacy a[href="mailto:stefanodonne@gmail.com"]')).toHaveText("stefanodonne@gmail.com");
  await expect(panel).toContainText("Sources and reference dates");
  await panel.press("Escape");
  await expect(page.locator("#about-button")).toBeFocused();
});

test("keeps the explanatory controls and panel free of automated accessibility violations", async ({ page }) => {
  for (const metric of ["final", "heat", "vulnerability"]) {
    await page.locator(`[data-heat-metric="${metric}"]`).click();
    const controlsResults = await new AxeBuilder({ page })
      .exclude("#map")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(controlsResults.violations).toEqual([]);
  }

  await page.locator("#about-button").click();
  const aboutResults = await new AxeBuilder({ page })
    .include("#detail-panel")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(aboutResults.violations).toEqual([]);
});
