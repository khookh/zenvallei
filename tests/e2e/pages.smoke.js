import { expect, test } from "@playwright/test";

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

test("serves the complete application below the GitHub Pages project path", async ({ page }, testInfo) => {
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
  await expect(page.locator("[data-layer]")).toHaveCount(7);
  expect((await page.locator("[data-layer]").evaluateAll((elements) => elements.map((element) => element.dataset.layer))).sort())
    .toEqual(["groenkaart", "heat", "income", "jaarbak", "landgebruik", "landsat-temperature", "urban-atlas"]);
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
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#analysis-compare")).toBeHidden();
  await expect(page.locator("#map-mode-action")).toBeHidden();
  expect(ownResponses.some((url) => url.includes("/zenvallei/data/urban-atlas.geojson"))).toBe(true);
  await page.locator('[data-layer="landsat-temperature"]').click();
  await expect(page.locator("#analysis-compare")).toBeVisible();
  await expect(page.locator("#analysis-compare")).toHaveText(/Compare/);
  for (const layerId of ["jaarbak", "groenkaart"]) {
    await page.locator(`[data-layer="${layerId}"]`).click();
    await expect(page.locator(`[data-layer="${layerId}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#map-mode-action")).toBeVisible();
    await expect(page.locator("#analysis-compare")).toBeHidden();
  }
  for (const layerId of ["landgebruik", "income"]) {
    await page.locator(`[data-layer="${layerId}"]`).click();
    await expect(page.locator(`[data-layer="${layerId}"]`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#map-mode-action")).toBeHidden();
    await expect(page.locator("#analysis-compare")).toBeHidden();
  }
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
      landsat: "none", jaarbak: "visible", density: "none", comparison: "visible",
    });
    await page.locator("#analysis-pair-remove").click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ landsat: "visible", jaarbak: "none", comparison: "missing" });
    await page.locator('[data-layer="jaarbak"]').click();
    await expect.poll(() => rasterVisibility(page)).toMatchObject({ jaarbak: "none", density: "visible" });
    await page.locator('[data-layer="landsat-temperature"]').click();
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

test("retries the same JaarBAK source without leaving an empty comparison", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.includes("mobile"), "The responsive flow is covered by the complete mobile smoke test.");
  test.setTimeout(45_000);
  let allowJaarbak = false;
  let rejectedRequests = 0;
  await page.route("**/jaarbak-2024-all.pmtiles*", async (route) => {
    if (allowJaarbak) await route.continue();
    else {
      rejectedRequests += 1;
      await route.fulfill({ status: 503, contentType: "text/plain", body: "temporary test failure" });
    }
  });
  await page.goto(".");
  await page.locator("#project-intro-primary").click();
  await page.locator('[data-layer="landsat-temperature"]').click();
  await page.locator("#analysis-compare").click();
  await page.locator('[data-layer="jaarbak"]').click();

  await expect(page.locator("#analysis-pair-retry")).toBeVisible({ timeout: 20_000 });
  expect(rejectedRequests).toBeGreaterThan(0);
  await expect.poll(() => rasterVisibility(page)).toMatchObject({
    landsat: "visible", jaarbak: "none", comparison: "none",
  });

  allowJaarbak = true;
  await page.locator("#analysis-pair-retry").click();
  await expect(page.locator("#analysis-pair-retry")).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => rasterVisibility(page), { timeout: 20_000 }).toEqual({
    landsat: "none", jaarbak: "visible", density: "missing", comparison: "visible",
  });
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
