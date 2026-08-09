import { expect, test } from "@playwright/test";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

test("shows the latest Python export only in the opt-in local Test layer", async ({ page }) => {
  const errors = [];
  const images = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/__playground__/test")) images.push(request.url());
  });
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.goto("/");
  await expect.poll(async () => ({
    ready: await page.locator("html").getAttribute("data-app-ready"),
    errors,
  }), { timeout: 80_000 }).toEqual({ ready: "true", errors: [] });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("#project-intro-primary").click();
  await expect(page.locator("[data-layer]")).toHaveCount(8);
  expect((await page.locator("[data-layer]").evaluateAll((elements) => elements.map((element) => element.dataset.layer))).sort())
    .toEqual(["groenkaart", "heat", "income", "jaarbak", "landgebruik", "landsat-temperature", "notebook-test", "urban-atlas"]);

  const testLayer = page.locator('[data-layer="notebook-test"]');
  await expect(testLayer).toHaveText("Test");
  await testLayer.click();
  await expect(testLayer).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#active-layer-title")).toHaveText("Test");
  await expect(page.locator("#legend-title")).toHaveText("Notebook NDVI test");
  await expect(page.locator("#legend-content")).toContainText("0.90");
  await expect(page.locator("#layer-context-meta")).toContainText("Local Python notebook export");
  await expect.poll(() => page.evaluate(() => window.__heatMap.map.getLayoutProperty("notebook-test-raster", "visibility"))).toBe("visible");

  await page.locator("#sector-search").fill("23003A001");
  await page.locator("#sector-search").press("Enter");
  await expect(page.locator("#detail-panel")).toContainText("Notebook NDVI test");
  await expect(page.locator("#detail-panel")).toContainText("Median");
  await expect(page.locator("#detail-panel")).toContainText("0.61 NDVI");
  await expect(page.locator("#detail-panel")).toContainText("not part of the public dashboard");

  await page.locator("#panel-close").click();
  await page.locator("#municipality-select").selectOption("Halle");
  await expect(page.locator("#detail-panel")).toContainText("Municipality overview");
  await expect(page.locator("#detail-panel")).toContainText("0.64 NDVI");
  await expect.poll(() => images.some((url) => url.endsWith("test-halle.png"))).toBe(true);

  await page.locator("#language-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.locator("#detail-panel")).toContainText("Notebook-NDVI-test");
  await expect(page.locator("#detail-panel")).toContainText("Mediaan");
  await expect(page.locator("#detail-panel")).toContainText("maakt geen deel uit van het publieke dashboard");
  expect(errors).toEqual([]);
});
