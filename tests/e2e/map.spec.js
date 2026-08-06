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
  expect(expectedNetworkErrors.leï}¶‰žËkºwµçqÑ•È¡ì¡…ÍQ•áÐè€‰É½•¹‰•‘•­­¥¹œˆô¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÐÀ”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È ˆ¹ÍÕµµ…Éäµ…Éˆ¤¹™¥±Ñ•È¡ì¡…ÍQ•áÐè€‰ÉÑ¥™¥¥…±¥Í•É¥¹œˆô¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÐÀ”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰-ÉÕ¥‘…¡Ñ¥”Ù••Ñ…Ñ¥”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]•¥±…¹‘•¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰ÁÕ‰±¥•­”Ñ½•…¹œˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰ÁÉ¥Ù…Ñ”Ñ½•…¹œˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰Ñ½•…¹œ½¹‰•­•¹ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰	½ÕÝÑ•ÉÉ•¥¹•¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰	•É•­•¹‘½½È‘•é”Ñ½•Á…ÍÍ¥¹œˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È m‘…Ñ„µÍ•Ñ¥½¸ô‰ÕÉ‰…¸µ…Ñ±…Ìµ½Ñ¡•È‰tœ¤¤¹¹½Ð¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôø€¡ì(€€€•¹Ñ•ÈèÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ•¹Ñ•È ¤¹Ñ½ÉÉ…ä ¤°(€€€é½½´èÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñi½½´ ¤°(€ô¤¤¤¹Ñ½ÅÕ…°¡µ…ÁMÑ…Ñ•	•™½É”¤ì((€½¹ÍÐÍÕ‰Í•ÅÕ•¹ÑMÝ¥Ñ €ô…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”¡…Íå¹Œ€ ¤€ôøì(€€€…Ý…¥ÐÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹Í•Ñ1…å•È ‰¡•…Ðˆ¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ôÁ•É™½Éµ…¹”¹¹½Ü ¤ì(€€€…Ý…¥ÐÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹Í•Ñ1…å•È ‰ÕÉ‰…¸µ…Ñ±…Ìˆ¤ì(€€€É•ÑÕÉ¸Á•É™½Éµ…¹”¹¹½Ü ¤€´ÍÑ…ÉÑ•ì(€ô¤ì(€•áÁ•Ð¡ÍÕ‰Í•ÅÕ•¹ÑMÝ¥Ñ ¤¹Ñ½	•1•ÍÍQ¡…¸ ÄÀÀ¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡…Ñ±…Í	ÕÑÑ½¸¤¹Ñ½!…Ù•Q•áÐ ‰UÉ‰…¸Ñ±…Ì€ÈÀÈÄˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µÑ¥Ñ±”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰UÉ‰…¸Ñ±…Ì±…¹½Ù•È€ÈÀÈÄˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰É••¸½Ù•É…”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰!•É‰…•½ÕÌÙ••Ñ…Ñ¥½¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰A…ÍÑÕÉ•Ìˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰¹½Ðå•ÐÙ…±¥‘…Ñ•ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È m‘…Ñ„µÍ•Ñ¥½¸ô‰ÕÉ‰…¸µ…Ñ±…ÌµÉ••¸‰tœ¤¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€½¹ÍÐµÕ¹¥¥Á…±¥Ñå½Õ¹ÑÌ€ôì(€€€	••ÉÍ•°è€Ìä°(€€€É½•¹‰½Ìè€Ü°(€€€!…±±”è€ÐÄ°(€€€1¥¹­•‰••¬è€Ü°(€€€A•Á¥¹•¸è€ÄÔ°(€€€€‰M¥¹Ðµ•¹•Í¥ÕÌµI½‘”ˆè€ÈÈ°(€€€€‰M¥¹ÐµA¥•Ñ•ÉÌµ1••ÕÜˆè€ÈÌ°(€ôì(€™½È€¡½¹ÍÐmµÕ¹¥¥Á…±¥Ñä°½Õ¹Ñt½˜=‰©•Ð¹•¹ÑÉ¥•Ì¡µÕ¹¥¥Á…±¥Ñå½Õ¹ÑÌ¤¤ì(€€€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆµÕ¹¥¥Á…±¥ÑäµÍ•±•Ðˆ¤¹Í•±•Ñ=ÁÑ¥½¸¡µÕ¹¥¥Á…±¥Ñä¤ì(€€€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆÙ¥Í¥‰±”µ½Õ¹Ðˆ¤¤¹Ñ½!…Ù•Q•áÐ¡€‘í½Õ¹ÑôÍ•Ñ½É•¹€¤ì(€€€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ¥±Ñ•È ‰ÕÉ‰…¸µ…Ñ±…Ìµ™¥±°ˆ¤¤¤¹Ñ½ÅÕ…°¡lˆôôˆ°l‰•Ðˆ°€‰µÕ¹¥¥Á…±¥Ñä‰t°µÕ¹¥¥Á…±¥Ñåt¤ì(€ô)ô¤ì()Ñ•ÍÐ ‰±½…‘Ì±¥­•±äÙ••Ñ…Ñ¥½¸±…é¥±ä…¹ÁÉ•Í•¹ÑÌ…±¥‰É…Ñ•9Y$ÍÑ…Ñ¥ÍÑ¥Ìˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€•áÁ•Ð¡Ù••Ñ…Ñ¥½¹I…ÍÑ•ÉI•ÅÕ•ÍÑÌ¹•Ð¡Á…”¤¤¹Ñ½	” À¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆµÕ¹¥¥Á…±¥ÑäµÍ•±•Ðˆ¤¹Í•±•Ñ=ÁÑ¥½¸ ‰	••ÉÍ•°ˆ¤ì(€½¹ÍÐÍ•…É €ôÁ…”¹±½…Ñ½È ˆÍ•Ñ½ÈµÍ•…É ˆ¤ì(€…Ý…¥ÐÍ•…É ¹™¥±° ˆÈÌÀÀÍÀÀÄˆ¤ì(€…Ý…¥ÐÍ•…É ¹ÁÉ•ÍÌ ‰¹Ñ•Èˆ¤ì(€…Ý…¥ÐÁ…”¹Ý…¥Ñ½ÉÕ¹Ñ¥½¸  ¤€ôø€…Ý¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹¥Í5½Ù¥¹œ ¤¤ì(€½¹ÍÐÁ…¹•°€ôÁ…”¹±½…Ñ½È ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤ì(€½¹ÍÐµ…ÁMÑ…Ñ•	•™½É”€ô…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôø€¡ì(€€€•¹Ñ•ÈèÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ•¹Ñ•È ¤¹Ñ½ÉÉ…ä ¤°(€€€é½½´èÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñi½½´ ¤°(€ô¤¤ì((€½¹ÍÐÙ••Ñ…Ñ¥½¹	ÕÑÑ½¸€ôÁ…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èô‰Ù••Ñ…Ñ¥½¸‰tœ¤ì(€…Ý…¥Ð•áÁ•Ð¡Ù••Ñ…Ñ¥½¹	ÕÑÑ½¸¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ‘¥Í…‰±•ˆ°€‰™…±Í”ˆ¤ì(€½¹ÍÐÍÝ¥Ñ¡MÑ…ÉÑ•€ô…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÁ•É™½Éµ…¹”¹¹½Ü ¤¤ì(€…Ý…¥ÐÙ••Ñ…Ñ¥½¹	ÕÑÑ½¸¹±¥¬ ¤ì(€…Ý…¥ÐÁ…”¹Ý…¥Ñ½ÉÕ¹Ñ¥½¸  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ1…å•È ‰±¥­•±äµÙ••Ñ…Ñ¥½¸µÉ…ÍÑ•Èˆ¤(€€€€˜˜Ý¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ1…å½ÕÑAÉ½Á•ÉÑä ‰±¥­•±äµÙ••Ñ…Ñ¥½¸µÉ…ÍÑ•Èˆ°€‰Ù¥Í¥‰¥±¥Ñäˆ¤€ôôô€‰Ù¥Í¥‰±”ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ” ¡ÍÑ…ÉÐ¤€ôøÁ•É™½Éµ…¹”¹¹½Ü ¤€´ÍÑ…ÉÐ°ÍÝ¥Ñ¡MÑ…ÉÑ•¤¤¹Ñ½	•1•ÍÍQ¡…¸ Å|ÀÀÀ¤ì(€•áÁ•Ð¡Ù••Ñ…Ñ¥½¹I…ÍÑ•ÉI•ÅÕ•ÍÑÌ¹•Ð¡Á…”¤¤¹Ñ½	” Ä¤ì(€…Ý…¥Ð•áÁ•Ð¡Ù••Ñ…Ñ¥½¹	ÕÑÑ½¸¤¹Ñ½	•½ÕÍ• ¤ì(€…Ý…¥Ð•áÁ•Ð¡Ù••Ñ…Ñ¥½¹	ÕÑÑ½¸¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µÁÉ•ÍÍ•ˆ°€‰ÑÉÕ”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ…Ñ¥Ù”µ±…å•ÈµÑ¥Ñ±”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰Y••Ñ…Ñ¥”µ¥¹‘¥…Ñ¥”€ÈÀÈÀˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µÑ¥Ñ±”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰Y••Ñ…Ñ¥”µ¥¹‘¥…Ñ¥”€ÈÀÈÀˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µ¹½Ñ”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰9Y$ƒŠ&”€À°ØäÜˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µ½¹Ñ•¹Ðˆ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]……ÉÍ¡¥©¹±¥©¬‰•É½•¥ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µ½¹Ñ•¹Ðˆ¤¤¹¹½Ð¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=¹‘•È‘”9Y$µ‘É•µÁ•°ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µ½¹Ñ•¹Ðˆ¤¤¹¹½Ð¹Ñ½½¹Ñ…¥¹Q•áÐ ‰U¥Ñ•Í±½Ñ•¸½˜••¸Ý……É¹•µ¥¹œˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µ½¹Ñ•¹Ðˆ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=¹•­±•ÕÉ‘”Á¥á•±Ì­Õ¹¹•¸½¹‘•È‘”‘É•µÁ•°±¥•¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±…å•Èµ½¹Ñ•áÐµµ•Ñ„ˆ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÈÐ©Õ¸€ÈÀÈÀˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±…å•Èµ½¹Ñ•áÐµ½Áäˆ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰‰•Ý¥©ÍÐ••¸•½±½¥Í¡”•é½¹‘¡•¥ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆµ…À…¹Ù…Ìˆ¤¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ±…‰•°ˆ°€‰%¹Ñ•É…Ñ¥•Ù”­……ÉÐèY••Ñ…Ñ¥”µ¥¹‘¥…Ñ¥”€ÈÀÈÀ¥¸‘”i•¹¹•Ù…±±•¤ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•ÑA…¥¹ÑAÉ½Á•ÉÑä ‰±¥­•±äµÙ••Ñ…Ñ¥½¸µÉ…ÍÑ•Èˆ°€‰É…ÍÑ•Èµ½Á…¥Ñäˆ¤¤¤¹Ñ½	” À¸Øà¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•ÑA…¥¹ÑAÉ½Á•ÉÑä ‰±¥­•±äµÙ••Ñ…Ñ¥½¸µÉ…ÍÑ•Èˆ°€‰É…ÍÑ•ÈµÉ•Í…µÁ±¥¹œˆ¤¤¤¹Ñ½	” ‰¹•…É•ÍÐˆ¤ì((€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]……ÉÍ¡¥©¹±¥©¬‰•É½•¥ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÐÜ°Øäˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÈÐ°ÔÄ¡„ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰9Y$¥Ì••¸Í…Ñ•±±¥•Ñµ……ÐÙ½½ÈÉ½•¹¡•¥ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰¹‘•É”½ÁÁ•ÉÙ±…­Ñ”Ù…¸‘”Í•Ñ½Èˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰5•‘¥…¹”9Y$ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÀ°ØÜÜˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰U¥Ñ•Í±½Ñ•¸…­­•É±…¹ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È m‘…Ñ„µÍ•Ñ¥½¸ô‰Ù••Ñ…Ñ¥½¸µµ•Ñ¡½‘½±½ä‰tœ¤¤¹¹½Ð¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì(€…Ý…¥ÐÁ…¹•°¹±½…Ñ½È m‘…Ñ„µÍ•Ñ¥½¸ô‰Ù••Ñ…Ñ¥½¸µµ•Ñ¡½‘½±½ä‰t€øÍÕµµ…Éäœ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰	•É•­•¹‘”9Y$µ‘É•µÁ•°è€À°ØäÜˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰-…±¥‰É…Ñ¥”Ù…¸‘”‘É•µÁ•°ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰I=U€À°äÈÔˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰LÉ	}5M%0É|ÈÀÈÀÀØÈÑPÄÀÐØÈäˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ¹µ…Á±¥‰É•°µÑÉ°µ…ÑÑÉ¥ˆˆ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰½Á•É¹¥ÕÌM•¹Ñ¥¹•°´È¥¹™½Éµ…Ñ¥½¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆµÕ¹¥¥Á…±¥ÑäµÍ•±•Ðˆ¤¤¹Ñ½!…Ù•Y…±Õ” ‰	••ÉÍ•°ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôø€¡ì(€€€•¹Ñ•ÈèÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ•¹Ñ•È ¤¹Ñ½ÉÉ…ä ¤°(€€€é½½´èÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñi½½´ ¤°(€ô¤¤¤¹Ñ½ÅÕ…°¡µ…ÁMÑ…Ñ•	•™½É”¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Ù••Ñ…Ñ¥½¹	ÕÑÑ½¸¤¹Ñ½!…Ù•Q•áÐ ‰1¥­•±äÙ••Ñ…Ñ¥½¸€ÈÀÈÀˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆµ…Àµ½¹ÑÉ½±ÌµÑ¥Ñ±”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰]¡…ÐÝ½Õ±å½Ô±¥­”Ñ¼±½½¬…Ðüˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èµ…Ñ•½Éäô‰¡•…Ð‰tœ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰!•…Ðˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èµ…Ñ•½Éäô‰±…¹µÉ••¸‰tœ¤¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰1…¹ÕÍ”…¹É••¸½Ù•Èˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ±••¹µÑ¥Ñ±”ˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰1¥­•±äÙ••Ñ…Ñ¥½¸€ÈÀÈÀˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰1¥­•±äÙ••Ñ…Ñ•ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰5•‘¥…¸9Y$ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰…±Õ±…Ñ•9Y$Ñ¡É•Í¡½±è€À¸ØäÜˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰Q¡É•Í¡½±…±¥‰É…Ñ¥½¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È m‘…Ñ„µÍ•Ñ¥½¸ô‰Ù••Ñ…Ñ¥½¸µµ•Ñ¡½‘½±½ä‰tœ¤¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰½Á•¸ˆ°€ˆˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆÙ••Ñ…Ñ¥½¸µå•…Èµ½¹ÑÉ½°ˆ¤¤¹Ñ½	•!¥‘‘•¸ ¤ì((€½¹ÍÐÍÕ‰Í•ÅÕ•¹ÑMÝ¥Ñ €ô…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”¡…Íå¹Œ€ ¤€ôøì(€€€…Ý…¥ÐÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹Í•Ñ1…å•È ‰¡•…Ðˆ¤ì(€€€½¹ÍÐÍÑ…ÉÑ•€ôÁ•É™½Éµ…¹”¹¹½Ü ¤ì(€€€…Ý…¥ÐÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹Í•Ñ1…å•È ‰Ù••Ñ…Ñ¥½¸ˆ¤ì(€€€É•ÑÕÉ¸Á•É™½Éµ…¹”¹¹½Ü ¤€´ÍÑ…ÉÑ•ì(€ô¤ì(€•áÁ•Ð¡ÍÕ‰Í•ÅÕ•¹ÑMÝ¥Ñ ¤¹Ñ½	•1•ÍÍQ¡…¸ ÄÀÀ¤ì(€•áÁ•Ð¡Ù••Ñ…Ñ¥½¹I…ÍÑ•ÉI•ÅÕ•ÍÑÌ¹•Ð¡Á…”¤¤¹Ñ½	” Ä¤ì((€½¹ÍÐ…•ÍÍ¥‰¥±¥ÑåI•ÍÕ±ÑÌ€ô…Ý…¥Ð¹•Üá•	Õ¥±‘•È¡ìÁ…”ô¤(€€€€¹•á±Õ‘” ˆµ…Àˆ¤(€€€€¹Ý¥Ñ¡Q…Ì¡l‰Ý…œÉ„ˆ°€‰Ý…œÉ…„‰t¤(€€€€¹…¹…±åé” ¤ì(€•áÁ•Ð¡…•ÍÍ¥‰¥±¥ÑåI•ÍÕ±ÑÌ¹Ù¥½±…Ñ¥½¹Ì¤¹Ñ½ÅÕ…°¡mt¤ì)ô¤ì()Ñ•ÍÐ ‰™¥±Ñ•ÉÌ…±°•¹Ù¥É½¹µ•¹Ñ…°½Ù•É±…åÌ…¹½Á•¹Ì…É•„µÝ•¥¡Ñ•µÕ¹¥¥Á…±¥ÑäÍÕµµ…É¥•Ìˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€½¹ÍÐÁ…¹•°€ôÁ…”¹±½…Ñ½È ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆµÕ¹¥¥Á…±¥ÑäµÍ•±•Ðˆ¤¹Í•±•Ñ=ÁÑ¥½¸ ‰	••ÉÍ•°ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰ÑÉÕ”ˆ¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èô‰±…¹µ½Ù•È‰tœ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰™…±Í”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰•µ••¹Ñ•½Ù•Éé¥¡Ðƒ
Ü€ÌäMÑ…Ñ‰•°µÍ•Ñ½É•¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆØÄ°ÈÈ”ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•ÑM½ÕÉ” ‰±…¹µ½Ù•Èµ¥µ…”ˆ¤¹Í•É¥…±¥é” ¤¹ÕÉ°¤¤¹Ñ½½¹Ñ…¥¸ ‰±…¹µ½Ù•È´ÈÀÈÀµ‰••ÉÍ•°¹Á¹œˆ¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èô‰ÕÉ‰…¸µ…Ñ±…Ì‰tœ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰É½•¹‰•‘•­­¥¹œˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÐÀ”ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•Ñ¥±Ñ•È ‰ÕÉ‰…¸µ…Ñ±…Ìµ™¥±°ˆ¤¤¤¹Ñ½ÅÕ…°¡lˆôôˆ°l‰•Ðˆ°€‰µÕ¹¥¥Á…±¥Ñä‰t°€‰	••ÉÍ•°‰t¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èô‰Ù••Ñ…Ñ¥½¸‰tœ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰!½•Ù••°±¥©­Ð‰•É½•¥üˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰•µ••¹Ñ•½Ù•Éé¥¡Ðƒ
Ü€ÌäMÑ…Ñ‰•°µÍ•Ñ½É•¸ˆ¤ì(€•áÁ•Ð¡…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôøÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…À¹•ÑM½ÕÉ” ‰±¥­•±äµÙ••Ñ…Ñ¥½¸µ¥µ…”ˆ¤¹Í•É¥…±¥é” ¤¹ÕÉ°¤¤¹Ñ½½¹Ñ…¥¸ ‰±¥­•±äµÙ••Ñ…Ñ¥½¸´ÈÀÈÀµ‰••ÉÍ•°¹Á¹œˆ¤ì((€½¹ÍÐÍ•…É €ôÁ…”¹±½…Ñ½È ˆÍ•Ñ½ÈµÍ•…É ˆ¤ì(€…Ý…¥ÐÍ•…É ¹™¥±° ˆÈÌÀÀÍÀÀÄˆ¤ì(€…Ý…¥ÐÍ•…É ¹ÁÉ•ÍÌ ‰¹Ñ•Èˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ˆÈÌÀÀÍÀÀÄˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹¹½Ð¹Ñ½½¹Ñ…¥¹Q•áÐ ‰•µ••¹Ñ•½Ù•Éé¥¡Ðƒ
Ü€ÌäMÑ…Ñ‰•°µÍ•Ñ½É•¸ˆ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆÁ…¹•°µ±½Í”ˆ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰•µ••¹Ñ•½Ù•Éé¥¡Ðƒ
Ü€ÌäMÑ…Ñ‰•°µÍ•Ñ½É•¸ˆ¤ì((€…Ý…¥ÐÁ…”¹±½…Ñ½È m‘…Ñ„µ±…å•Èô‰¡•…Ð‰tœ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰ÑÉÕ”ˆ¤ì)ô¤ì()Ñ•ÍÐ ‰™¥±Ñ•ÉÌÑ¡”µ…À…¹•áÁ½Í•Ì¹¼µ‘…Ñ„Í•Ñ½ÉÌ¡½¹•ÍÑ±äˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆµÕ¹¥¥Á…±¥ÑäµÍ•±•Ðˆ¤¹Í•±•Ñ=ÁÑ¥½¸ ‰!…±±”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆÙ¥Í¥‰±”µ½Õ¹Ðˆ¤¤¹Ñ½!…Ù•Q•áÐ ˆÐÄÍ•Ñ½É•¸ˆ¤ì(€½¹ÍÐÍ•…É €ôÁ…”¹±½…Ñ½È ˆÍ•Ñ½ÈµÍ•…É ˆ¤ì(€…Ý…¥ÐÍ•…É ¹™¥±° ˆÈÌÀÈÝÄàÌˆ¤ì(€…Ý…¥ÐÍ•…É ¹ÁÉ•ÍÌ ‰¹Ñ•Èˆ¤ì(€½¹ÍÐÁ…¹•°€ôÁ…”¹±½…Ñ½È ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰M5I!=UPˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=¹Ù½±‘½•¹‘”••Ù•¹Ìˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰½¹Ù½±‘½•¹‘”‰•Ù½±­¥¹Ì´½˜MLµ••Ù•¹Ìˆ¤ì(€…Ý…¥Ð±¥­!•…Ñ5•ÑÉ¥Œ¡Á…”°€‰¡•…Ðˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È ˆ¹Í½É”µ½ÉˆÍÑÉ½¹œˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰¸¹Ø¹Ð¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=¹Ù½±‘½•¹‘”••Ù•¹Ìˆ¤ì(€…Ý…¥Ð±¥­!•…Ñ5•ÑÉ¥Œ¡Á…”°€‰ÙÕ±¹•É…‰¥±¥Ñäˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È ˆ¹Í½É”µ½ÉˆÍÑÉ½¹œˆ¤¤¹Ñ½!…Ù•Q•áÐ ‰¸¹Ø¹Ð¸ˆ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰%¹ÍÕ™™¥¥•¹Ð‘…Ñ„ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰Á½ÁÕ±…Ñ¥½¸½ÈML‘…Ñ„¥Ì¥¹ÍÕ™™¥¥•¹Ðˆ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆÁ…¹•°µ±½Í”ˆ¤¹±¥¬ ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰ÑÉÕ”ˆ¤ì)ô¤ì()Ñ•ÍÐ ‰½Á•¹Ì„Í•Ñ½È‰ä±¥­¥¹œÑ¡”É•¹‘•É•½Ù•É±…äˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€…Ý…¥ÐÁ…”¹•Ù…±Õ…Ñ”  ¤€ôø¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøì(€€€½¹ÍÐµ…À€ôÝ¥¹‘½Ü¹}}¡•…Ñ5…À¹µ…Àì(€€€½¹ÍÐÑ¥µ•½ÕÐ€ôÝ¥¹‘½Ü¹Í•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°€Í|ÀÀÀ¤ì(€€€µ…À¹½¹” ‰¥‘±”ˆ°€ ¤€ôøì(€€€€€Ý¥¹‘½Ü¹±•…ÉQ¥µ•½ÕÐ¡Ñ¥µ•½ÕÐ¤ì(€€€€€É•Í½±Ù” ¤ì(€€€ô¤ì(€€€µ…À¹ÑÉ¥•ÉI•Á…¥¹Ð ¤ì(€ô¤¤ì(€½¹ÍÐ±¥­A½¥¹Ð€ô…Ý…¥Ð™¥¹‘U¹½‰ÍÑÉÕÑ•‘M•Ñ½ÉA½¥¹Ð¡Á…”°€‰¡•…ÐµÍ•Ñ½ÉÌµ™¥±°ˆ¤ì(€•áÁ•Ð¡±¥­A½¥¹Ð¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆµ…À…¹Ù…Ìˆ¤¹±¥¬¡ìÁ½Í¥Ñ¥½¸è±¥­A½¥¹Ðô¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤¤¹Ñ½!…Ù•ÑÑÉ¥‰ÕÑ” ‰…É¥„µ¡¥‘‘•¸ˆ°€‰™…±Í”ˆ¤ì)ô¤ì()Ñ•ÍÐ ‰½™™•ÉÌ…¸…•ÍÍ¥‰±”•áÁ±…¹…Ñ½Éä±…å•Èˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ±…¹Õ…”µÑ½±”ˆ¤¹±¥¬ ¤ì(€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ…‰½ÕÐµ‰ÕÑÑ½¸ˆ¤¹±¥¬ ¤ì(€½¹ÍÐÁ…¹•°€ôÁ…”¹±½…Ñ½È ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰‰½ÕÐÑ¡¥Ìµ…Àˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰!½ÜÑ¼ÕÍ”Ñ¡”µ…Àˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]¡…Ð•… ±…å•ÈÑ•±±Ìå½Ôˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰1…¹ÕÍ”…¹É••¸½Ù•Èˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]¡ä€ÄÔÐÍ•Ñ½ÉÌüˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰MÑ…Ñ‰•°‘•™¥¹•ÌÑ¡•¥È½‘•Ì…¹‰½Õ¹‘…É¥•Ìˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=™™¥¥…°ÁÉ½‘Õ•Èˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]¡…ÐÝ”…‘ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=Á•¹MÑÉ••Ñ5…À¥Ì½¹±äÑ¡”‰…­É½Õ¹µ…Àˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰Q¡¥Ì…ÁÁ±¥…Ñ¥½¸ÕÍ•Ì¹¼½½­¥•Ì°…¹…±åÑ¥Ì°…½Õ¹ÑÌ½ÈÁ•ÉÍ¥ÍÑ•¹Ð¥‘•¹Ñ¥™¥•ÉÌˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰¥Ñ!ÕˆA…•ÌÉ•½É‘ÌÙ¥Í¥Ñ½ÉÌœ%@…‘‘É•ÍÍ•Ìˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰=Á•¹MÑÉ••Ñ5…ÀÉ••¥Ù•Ì½É‘¥¹…ÉäÉ•ÅÕ•ÍÐ¥¹™½Éµ…Ñ¥½¸ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¹±½…Ñ½È …m¡É•˜ô‰µ…¥±Ñ¼éÍÑ•™…¹½‘½¹¹•µ…¥°¹½´‰tœ¤¤¹Ñ½!…Ù•Q•áÐ ‰ÍÑ•™…¹½‘½¹¹•µ…¥°¹½´ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰]¡•É”‘¥M•¹Ñ¥¹•°´È½‰Í•ÉÙ”„ÍÑÉ½¹œÙ••Ñ…Ñ¥½¸Í¥¹…°üˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…¹•°¤¹Ñ½½¹Ñ…¥¹Q•áÐ ‰M½ÕÉ•Ì…¹É•™•É•¹”‘…Ñ•Ìˆ¤ì(€…Ý…¥ÐÁ…¹•°¹ÁÉ•ÍÌ ‰Í…Á”ˆ¤ì(€…Ý…¥Ð•áÁ•Ð¡Á…”¹±½…Ñ½È ˆ…‰½ÕÐµ‰ÕÑÑ½¸ˆ¤¤¹Ñ½	•½ÕÍ• ¤ì)ô¤ì()Ñ•ÍÐ ‰­••ÁÌÑ¡”•áÁ±…¹…Ñ½Éä½¹ÑÉ½±Ì…¹Á…¹•°™É•”½˜…ÕÑ½µ…Ñ•…•ÍÍ¥‰¥±¥ÑäÙ¥½±…Ñ¥½¹Ìˆ°…Íå¹Œ€¡ìÁ…”ô¤€ôøì(€™½È€¡½¹ÍÐµ•ÑÉ¥Œ½˜l‰™¥¹…°ˆ°€‰¡•…Ðˆ°€‰ÙÕ±¹•É…‰¥±¥Ñä‰t¤ì(€€€…Ý…¥ÐÁ…”¹±½…Ñ½È¡m‘…Ñ„µ¡•…Ðµµ•ÑÉ¥Œôˆ‘íµ•ÑÉ¥ô‰u€¤¹±¥¬ ¤ì(€€€½¹ÍÐ½¹ÑÉ½±ÍI•ÍÕ±ÑÌ€ô…Ý…¥Ð¹•Üá•	Õ¥±‘•È¡ìÁ…”ô¤(€€€€€€¹•á±Õ‘” ˆµ…Àˆ¤(€€€€€€¹Ý¥Ñ¡Q…Ì¡l‰Ý…œÉ„ˆ°€‰Ý…œÉ…„‰t¤(€€€€€€¹…¹…±åé” ¤ì(€€€•áÁ•Ð¡½¹ÑÉ½±ÍI•ÍÕ±ÑÌ¹Ù¥½±…Ñ¥½¹Ì¤¹Ñ½ÅÕ…°¡mt¤ì(€ô((€…Ý…¥ÐÁ…”¹±½…Ñ½È ˆ…‰½ÕÐµ‰ÕÑÑ½¸ˆ¤¹±¥¬ ¤ì(€½¹ÍÐ…‰½ÕÑI•ÍÕ±ÑÌ€ô…Ý…¥Ð¹•Üá•	Õ¥±‘•È¡ìÁ…”ô¤(€€€€¹¥¹±Õ‘” ˆ‘•Ñ…¥°µÁ…¹•°ˆ¤(€€€€¹Ý¥Ñ¡Q…Ì¡l‰Ý…œÉ„ˆ°€‰Ý…œÉ…„‰t¤(€€€€¹…¹…±åé” ¤ì(€•áÁ•Ð¡…‰½ÕÑI•ÍÕ±ÑÌ¹Ù¥½±…Ñ¥½¹Ì¤¹Ñ½ÅÕ…°¡mt¤ì)ô¤ì