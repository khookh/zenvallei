import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

const runtimeErrors = new WeakMap();
const vegetationRasterRequests = new WeakMap();

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

const LAND_COVER_FIXTURE = {
  schemaVersion: 2,
  generatedAt: "2026-08-05T10:00:00.000Z",
  activeYear: 2020,
  availableYears: [2020],
  opacity: 0.68,
  raster: {
    available: true,
    year: 2020,
    imageUrl: "data/land-cover/land-cover-2020.png",
    rasterVariants: {
      all: "data/land-cover/land-cover-2020.png",
      Beersel: "data/land-cover/land-cover-2020-beersel.png",
    },
    coordinates: [[4.072, 50.828], [4.424, 50.828], [4.424, 50.689], [4.072, 50.689]],
  },
  classes: [
    { code: 10, key: "treeCover", color: "#006400", vegetation: true, present: true },
    { code: 30, key: "grassland", color: "#ffff4c", vegetation: true, present: true },
    { code: 40, key: "cropland", color: "#f096ff", vegetation: false, present: true },
    { code: 90, key: "builtUp", color: "#fa0000", vegetation: false, present: true },
    { code: 100, key: "water", color: "#0064c8", vegetation: false, present: true },
  ],
  vegetationCodes: [10, 30],
  builtUpCodes: [90],
  sectorStats: {
    "23003A001": {
      classifiedAreaHa: 24.5,
      vegetationAreaHa: 15,
      vegetationPercentage: 61.22,
      builtUpAreaHa: 5.5,
      builtUpPercentage: 22.45,
      dominantClassCode: 10,
      classes: [
        { code: 10, areaHa: 10, percentage: 40.82 },
        { code: 30, areaHa: 5, percentage: 20.41 },
        { code: 40, areaHa: 4, percentage: 16.33 },
        { code: 90, areaHa: 5.5, percentage: 22.45 },
      ],
    },
  },
  change: {
    available: false,
    baseYear: 2020,
    comparisonYear: 2026,
    palette: [{ key: "gained", color: "#009E73" }, { key: "lost", color: "#D55E00" }],
    reason: "comparison-year-not-published",
  },
  source: {
    productUrl: "https://land.copernicus.eu/en/products/global-dynamic-land-cover/land-cover-2020-raster-10-m-global-annual",
    doi: "https://doi.org/10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9",
    accessedAt: "2026-08-05T10:00:00.000Z",
  },
};

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
const VEGETATION_FIXTURE = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "public", "data", "vegetation.json"),
  "utf8",
));

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  vegetationRasterRequests.set(page, 0);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.route("**/data/land-cover.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LAND_COVER_FIXTURE) }));
  await page.route("**/data/land-cover/land-cover-2020*.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.route("**/data/urban-atlas.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(URBAN_ATLAS_FIXTURE) }));
  await page.route("**/data/urban-atlas.geojson", (route) => route.fulfill({ status: 200, contentType: "application/geo+json", body: JSON.stringify(URBAN_ATLAS_GEOJSON) }));
  await page.route("**/data/vegetation.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VEGETATION_FIXTURE) }));
  await page.route("**/data/vegetation/likely-vegetation-*.png", (route) => {
    vegetationRasterRequests.set(page, vegetationRasterRequests.get(page) + 1);
    return route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG });
  });
  await page.goto("/");
  await expect(page.locator("#map-loading")).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
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
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  await page.locator('[data-layer="land-cover"]').click();
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
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
  await expect(page.locator('[data-layer="land-cover"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
  await expect(search).toHaveValue(/23003A001/);

  const expandedResults = await new AxeBuilder({ page })
    .include("#map-controls")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(expandedResults.violations).toEqual([]);
});

test("keeps local sectors usable when basemap tiles are unavailable", async ({ page }) => {
  await page.route("**/__test-tile.png", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 20_000 });
  await expect(page.locator("#dataset-status")).toContainText("achtergrondkaart tijdelijk niet beschikbaar");
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
  await expect(page.locator(".app-header")).toHaveScreenshot("header-nl.png", { animations: "disabled" });
  await expect(page.locator("#map-controls")).toHaveScreenshot("controls-nl.png", { animations: "disabled" });

  await page.locator("#language-toggle").click();
  await expect(page.locator(".app-header")).toHaveScreenshot("header-en.png", { animations: "disabled" });
  await expect(page.locator("#map-controls")).toHaveScreenshot("controls-en.png", { animations: "disabled" });
  await page.locator('[data-heat-metric="vulnerability"]').click();
  await expect(page.locator(".app-header")).toHaveScreenshot("header-vulnerability-en.png", { animations: "disabled" });

  await page.locator("#language-toggle").click();
  await page.locator("#municipality-select").selectOption("Beersel");
  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await page.locator('[data-layer="land-cover"]').click();
  await expect(page.locator('[aria-labelledby="land-cover-summary-title"]'))
    .toHaveScreenshot("land-cover-summary-nl.png", { animations: "disabled" });
});

test("loads all sectors and opens a complete score breakdown from search", async ({ page }) => {
  await expect(page).toHaveTitle("Zennevallei - heat resilience");
  await expect(page.locator(".brand-mark")).toBeVisible();
  await expect(page.locator(".brand-mark")).toHaveAttribute("src", /assets\/zennevallei-river-mark\.png$/);
  await expect(page.locator(".eyebrow")).toHaveText("Zennevallei");
  await expect(page.locator("[data-layer]")).toHaveCount(4);
  await expect(page.locator(".layer-category")).toHaveCount(2);
  await expect(page.locator('[data-layer-category="heat"]')).toContainText("Hitte");
  await expect(page.locator('[data-layer-category="land-green"]')).toContainText("Landgebruik en groen");
  await expect(page.locator('[data-layer-category="heat"] [data-layer]')).toHaveCount(1);
  await expect(page.locator('[data-layer-category="land-green"] [data-layer]')).toHaveCount(3);
  await expect(page.locator("[data-heat-metric]")).toHaveCount(3);
  await expect(page.locator("#heat-metric-control")).toBeVisible();
  await expect(page.locator('[data-heat-metric="final"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-layer="change"]')).toHaveCount(0);
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveText("Urban Atlas 2021");
  await expect(page.locator('[data-layer="vegetation"]')).toHaveText("Vegetatie-indicatie 2020");
  expect(vegetationRasterRequests.get(page)).toBe(0);
  await expect(page.locator("#dataset-status")).toContainText("154 Statbel-sectoren · scores 2026");
  await expect(page.locator("#visible-count")).toHaveText("154 sectoren");
  await expect(page.locator("#about-button")).toContainText("Uitleg");
  await expect(page.locator("#layer-context-meta")).toHaveText("Officiële broncijfers · 154 Statbel-sectoren · 2026");
  await expect(page.locator("#layer-context-copy")).toContainText("Departement Zorg");
  await expect(page.locator("#layer-context-copy")).toContainText("wij tonen ze zonder herberekening");
  await expect(page.locator(".control-attribution")).toContainText("Vlaamse overheid · Departement Zorg");
  await expect(page.locator(".control-attribution")).toContainText("Statbel");
  const overlayRenderMs = await page.evaluate(() => performance.getEntriesByName("heat-overlay-first-render")[0]?.duration);
  expect(overlayRenderMs).toBeLessThan(500);
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

test("switches between combined, heat and vulnerability scores without losing exploration state", async ({ page }) => {
  await page.locator("#municipality-select").selectOption("Beersel");
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await panel.locator('[data-section="indicators"] > summary').click();
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
  await expect(page.locator("#dataset-status")).toContainText("hittescore 2026");
  await expect(page.locator("#legend-title")).toHaveText("Hittescore");
  await expect(page.locator("#layer-context-meta")).toContainText("Officiële hittescore");
  await expect(page.locator("#layer-context-copy")).toContainText("hittegolfgraaddagen in 2000-2019");
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

  await page.locator('[data-layer="land-cover"]').click();
  await expect(page.locator("#heat-metric-control")).toBeHidden();
  await page.locator('[data-layer="heat"]').click();
  await expect(page.locator("#heat-metric-control")).toBeVisible();
  await expect(page.locator('[data-heat-metric="vulnerability"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".score-orb strong")).toHaveText("8");

  await page.reload();
  await expect(page.locator("#map-loading")).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.locator('[data-heat-metric="final"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#active-layer-title")).toHaveText("Hittekwetsbaarheid");
});

test("switches the complete interface to English without resetting exploration state", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page).toHaveTitle("Zennevallei - heat resilience");
  await expect(page.locator("#language-toggle")).toHaveText("EN");

  await page.locator("#municipality-select").selectOption("Beersel");
  await expect(page.locator("#visible-count")).toHaveText("39 sectoren");
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await panel.locator('[data-section="indicators"] > summary').click();
  await panel.locator('[data-section="ses"] > summary').click();
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
  await expect(page.locator(".control-attribution")).toContainText("Flemish Government · Department of Care");
  await expect(panel).toContainText("Scores: Flemish Government · Department of Care (2026)");
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
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.locator("#language-toggle")).toHaveText("EN");
});

test("switches to Copernicus land cover and preserves the selected sector", async ({ page }) => {
  await page.locator("#municipality-select").selectOption("Beersel");
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await panel.locator('[data-section="indicators"] > summary').click();
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const mapStateBefore = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));

  const landCoverButton = page.locator('[data-layer="land-cover"]');
  await expect(landCoverButton).toHaveAttribute("aria-disabled", "false");
  const switchStarted = await page.evaluate(() => performance.now());
  await landCoverButton.click();
  await page.waitForFunction(() => window.__heatMap.map.getLayer("land-cover-raster")
    && window.__heatMap.map.getLayoutProperty("land-cover-raster", "visibility") === "visible");
  const switchDuration = await page.evaluate((start) => performance.now() - start, switchStarted);
  expect(switchDuration).toBeLessThan(1_000);
  const subsequentSwitchDuration = await page.evaluate(async () => {
    await window.__heatMap.setLayer("heat");
    const started = performance.now();
    await window.__heatMap.setLayer("land-cover");
    return performance.now() - started;
  });
  expect(subsequentSwitchDuration).toBeLessThan(100);
  await expect(landCoverButton).toBeFocused();
  await expect(landCoverButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#legend-title")).toHaveText("Copernicus-landbedekking 2020");
  await expect(page.locator("#dataset-status")).toContainText("Copernicus · raster 2020");
  await expect(page.locator("#layer-context-meta")).toContainText("10 m-pixels · 2020");
  await expect(page.locator("#layer-context-copy")).toContainText("officiële Copernicus LCM-10-classificatie");
  await expect(page.locator("#layer-context-copy")).toContainText("Wij knippen het raster uit");
  await expect(page.locator("#map canvas")).toHaveAttribute("aria-label", "Interactieve kaart: Landbedekking 2020 in de Zennevallei");
  await expect(page.locator("#legend-content")).toContainText("Boombedekking");
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Generated using European Union's Copernicus Land Monitoring Service information");
  await expect(panel).toContainText("Dominante landbedekking");
  await expect(panel).toContainText("Boombedekking");
  await expect(panel).toContainText("Bomen en grasland samen");
  await expect(panel.locator(".land-cover-trees")).toContainText("Boombedekking");
  await expect(panel.locator(".land-cover-trees")).toContainText("40,82%");
  await expect(panel.locator(".land-cover-cropland")).toContainText("Akkerland");
  await expect(panel.locator(".land-cover-cropland")).toContainText("16,33%");
  await expect(panel).toContainText("61,22%");
  await expect(panel).toContainText("Bebouwde oppervlakte");
  await expect(panel).toContainText("22,45%");
  await expect(panel).toContainText("Berekend door deze toepassing");
  await expect(panel).not.toContainText("Gekarteerd gebied");
  await expect(panel.locator('[data-section="land-cover-classes"]')).toHaveAttribute("open", "");
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
  await expect(search).toHaveValue(/23003A001/);
  expect(await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(mapStateBefore);

  await page.locator("#panel-close").click();
  await search.fill("23003A001");
  await search.press("Enter");
  await expect(panel).toContainText("Dominante landbedekking");
  await page.locator("#panel-close").click();
  await expect(panel).toContainText("Gemeenteoverzicht");
  await page.locator("#panel-close").click();
  await page.locator("#legend").evaluate((element) => element.removeAttribute("open"));
  await page.locator("#reset-view").click();
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const landCoverClickPoint = await findUnobstructedSectorPoint(page, "heat-sectors-hit-area");
  expect(landCoverClickPoint).not.toBeNull();
  await page.locator("#map canvas").click({ position: landCoverClickPoint });
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel.locator(".land-cover-hero")).toBeVisible();
  await search.fill("23003A001");
  await search.press("Enter");

  await page.locator("#language-toggle").click();
  await expect(landCoverButton).toHaveText("Land cover 2020");
  await expect(page.locator("#legend-title")).toHaveText("Copernicus land cover 2020");
  await expect(panel).toContainText("Dominant land cover");
  await expect(panel).toContainText("Tree cover");
  await expect(panel).toContainText("Trees and grassland combined");
  await expect(panel.locator(".land-cover-trees")).toContainText("Tree cover");
  await expect(panel.locator(".land-cover-cropland")).toContainText("Cropland");
  await expect(panel.locator(".land-cover-cropland")).toContainText("16.33%");
  await expect(panel).toContainText("61.22%");
  await expect(panel).toContainText("Built-up area");
  await expect(panel).toContainText("22.45%");
  await expect(panel).not.toContainText("Mapped area");

  await page.locator('[data-layer="heat"]').click();
  await expect(panel).toContainText("Score 6 out of 10");
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
});

test("loads Urban Atlas lazily and presents green and artificialisation statistics", async ({ page }) => {
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  const panel = page.locator("#detail-panel");
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const mapStateBefore = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));
  const atlasButton = page.locator('[data-layer="urban-atlas"]');
  await expect(atlasButton).toHaveAttribute("aria-disabled", "false");
  await atlasButton.click();
  await page.waitForFunction(() => window.__heatMap.map.getLayer("urban-atlas-fill")
    && window.__heatMap.map.getLayoutProperty("urban-atlas-fill", "visibility") === "visible");
  const firstRender = await page.evaluate(() => performance.getEntriesByName("urban-atlas-first-render")[0]?.duration);
  expect(firstRender).toBeLessThan(1_500);
  await expect(atlasButton).toBeFocused();
  await expect(atlasButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#legend-title")).toHaveText("Urban Atlas-landbedekking 2021");
  await expect(page.locator("#dataset-status")).toContainText("Copernicus · polygonen 2021");
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
  expect(await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(mapStateBefore);

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
    await page.locator("#municipality-select").selectOption(municipality);
    await expect(page.locator("#visible-count")).toHaveText(`${count} sectoren`);
    expect(await page.evaluate(() => window.__heatMap.map.getFilter("urban-atlas-fill"))).toEqual(["==", ["get", "municipality"], municipality]);
  }
});

test("loads likely vegetation lazily and presents calibrated NDVI statistics", async ({ page }) => {
  expect(vegetationRasterRequests.get(page)).toBe(0);
  await page.locator("#municipality-select").selectOption("Beersel");
  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  await page.waitForFunction(() => !window.__heatMap.map.isMoving());
  const panel = page.locator("#detail-panel");
  const mapStateBefore = await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }));

  const vegetationButton = page.locator('[data-layer="vegetation"]');
  await expect(vegetationButton).toHaveAttribute("aria-disabled", "false");
  const switchStarted = await page.evaluate(() => performance.now());
  await vegetationButton.click();
  await page.waitForFunction(() => window.__heatMap.map.getLayer("likely-vegetation-raster")
    && window.__heatMap.map.getLayoutProperty("likely-vegetation-raster", "visibility") === "visible");
  expect(await page.evaluate((start) => performance.now() - start, switchStarted)).toBeLessThan(1_000);
  expect(vegetationRasterRequests.get(page)).toBe(1);
  await expect(vegetationButton).toBeFocused();
  await expect(vegetationButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#active-layer-title")).toHaveText("Vegetatie-indicatie 2020");
  await expect(page.locator("#legend-title")).toHaveText("Vegetatie-indicatie 2020");
  await expect(page.locator("#legend-note")).toHaveText("NDVI ≥ 0,697");
  await expect(page.locator("#legend-content")).toContainText("Waarschijnlijk begroeid");
  await expect(page.locator("#legend-content")).not.toContainText("Onder de NDVI-drempel");
  await expect(page.locator("#legend-content")).not.toContainText("Uitgesloten of geen waarneming");
  await expect(page.locator("#legend-content")).toContainText("Ongekleurde pixels kunnen onder de drempel liggen");
  await expect(page.locator("#layer-context-meta")).toContainText("24 jun 2020");
  await expect(page.locator("#layer-context-copy")).toContainText("bewijst geen ecologische gezondheid");
  await expect(page.locator("#map canvas")).toHaveAttribute("aria-label", "Interactieve kaart: Vegetatie-indicatie 2020 in de Zennevallei");
  expect(await page.evaluate(() => window.__heatMap.map.getPaintProperty("likely-vegetation-raster", "raster-opacity"))).toBe(0.68);
  expect(await page.evaluate(() => window.__heatMap.map.getPaintProperty("likely-vegetation-raster", "raster-resampling"))).toBe("nearest");

  await expect(panel).toContainText("Waarschijnlijk begroeid");
  await expect(panel).toContainText("47,69");
  await expect(panel).toContainText("24,51 ha");
  await expect(panel).toContainText("NDVI is een satellietmaat voor groenheid");
  await expect(panel).toContainText("Andere oppervlakte van de sector");
  await expect(panel).toContainText("Mediane NDVI");
  await expect(panel).toContainText("0,677");
  await expect(panel).toContainText("Uitgesloten akkerland");
  await expect(panel.locator('[data-section="vegetation-methodology"]')).not.toHaveAttribute("open", "");
  await panel.locator('[data-section="vegetation-methodology"] > summary').click();
  await expect(panel).toContainText("Berekende NDVI-drempel: 0,697");
  await expect(panel).toContainText("Kalibratie van de drempel");
  await expect(panel).toContainText("ROC AUC 0,925");
  await expect(panel).toContainText("S2B_MSIL2A_20200624T104629");
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Copernicus Sentinel-2 information");
  await expect(page.locator("#municipality-select")).toHaveValue("Beersel");
  expect(await page.evaluate(() => ({
    center: window.__heatMap.map.getCenter().toArray(),
    zoom: window.__heatMap.map.getZoom(),
  }))).toEqual(mapStateBefore);

  await page.locator("#language-toggle").click();
  await expect(vegetationButton).toHaveText("Likely vegetation 2020");
  await expect(page.locator("#map-controls-title")).toHaveText("What would you like to look at?");
  await expect(page.locator('[data-layer-category="heat"]')).toContainText("Heat");
  await expect(page.locator('[data-layer-category="land-green"]')).toContainText("Land use and green cover");
  await expect(page.locator("#legend-title")).toHaveText("Likely vegetation 2020");
  await expect(panel).toContainText("Likely vegetated");
  await expect(panel).toContainText("Median NDVI");
  await expect(panel).toContainText("Calculated NDVI threshold: 0.697");
  await expect(panel).toContainText("Threshold calibration");
  await expect(panel.locator('[data-section="vegetation-methodology"]')).toHaveAttribute("open", "");
  await expect(page.locator("#vegetation-year-control")).toBeHidden();

  const subsequentSwitch = await page.evaluate(async () => {
    await window.__heatMap.setLayer("heat");
    const started = performance.now();
    await window.__heatMap.setLayer("vegetation");
    return performance.now() - started;
  });
  expect(subsequentSwitch).toBeLessThan(100);
  expect(vegetationRasterRequests.get(page)).toBe(1);

  const accessibilityResults = await new AxeBuilder({ page })
    .exclude("#map")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibilityResults.violations).toEqual([]);
});

test("filters all environmental overlays and opens area-weighted municipality summaries", async ({ page }) => {
  const panel = page.locator("#detail-panel");
  await page.locator("#municipality-select").selectOption("Beersel");
  await expect(panel).toHaveAttribute("aria-hidden", "true");

  await page.locator('[data-layer="land-cover"]').click();
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await expect(panel).toContainText("61,22%");
  expect(await page.evaluate(() => window.__heatMap.map.getSource("land-cover-image").serialize().url)).toContain("land-cover-2020-beersel.png");

  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(panel).toContainText("Groenbedekking");
  await expect(panel).toContainText("40%");
  expect(await page.evaluate(() => window.__heatMap.map.getFilter("urban-atlas-fill"))).toEqual(["==", ["get", "municipality"], "Beersel"]);

  await page.locator('[data-layer="vegetation"]').click();
  await expect(panel).toContainText("Hoeveel lijkt begroeid?");
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  expect(await page.evaluate(() => window.__heatMap.map.getSource("likely-vegetation-image").serialize().url)).toContain("likely-vegetation-2020-beersel.png");

  const search = page.locator("#sector-search");
  await search.fill("23003A001");
  await search.press("Enter");
  await expect(panel).toContainText("23003A001");
  await expect(panel).not.toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");
  await page.locator("#panel-close").click();
  await expect(panel).toContainText("Gemeenteoverzicht · 39 Statbel-sectoren");

  await page.locator('[data-layer="heat"]').click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});

test("filters the map and exposes no-data sectors honestly", async ({ page }) => {
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#visible-count")).toHaveText("41 sectoren");
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
  await expect(panel).toContainText("population or SES data is insufficient");
  await page.locator("#panel-close").click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
});

test("opens a sector by clicking the rendered overlay", async ({ page }) => {
  await page.locator("#language-toggle").click();
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
  await expect(panel).toContainText("Land use and green cover");
  await expect(panel).toContainText("Why 154 sectors?");
  await expect(panel).toContainText("Statbel defines their codes and boundaries");
  await expect(panel).toContainText("Official producer");
  await expect(panel).toContainText("What we add");
  await expect(panel).toContainText("OpenStreetMap is only the background map");
  await expect(panel).toContainText("This application uses no cookies, analytics, accounts or persistent identifiers");
  await expect(panel).toContainText("GitHub Pages records visitors' IP addresses");
  await expect(panel).toContainText("OpenStreetMap receives ordinary request information");
  await expect(panel.locator('a[href="mailto:stefanodonne@gmail.com"]')).toHaveText("stefanodonne@gmail.com");
  await expect(panel).toContainText("Where did Sentinel-2 observe a strong vegetation signal?");
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
