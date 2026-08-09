import { expect, test } from "@playwright/test";

test("live release exposes seven layers and both Landsat comparisons", async ({ page }) => {
  const failedSameOrigin = [];
  const applicationOrigin = new URL(process.env.LIVE_PAGES_URL ?? "https://khookh.github.io/zenvallei/").origin;
  page.on("response", (response) => {
    if (new URL(response.url()).origin === applicationOrigin && response.status() >= 400) {
      failedSameOrigin.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`.?smoke=${Date.now()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#project-intro")).toBeVisible();
  await page.locator("#project-intro-primary").click();
  await expect(page.locator("[data-layer]")).toHaveCount(7);

  await page.locator('[data-layer="landsat-temperature"]').click();
  await expect(page.locator("#analysis-compare")).toBeVisible();
  await page.locator("#analysis-compare").click();
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Urban Atlas 2021");

  await page.locator("#analysis-pair-change").click();
  await page.locator('[data-layer="jaarbak"]').click();
  await expect(page.locator("#analysis-pair-label")).toContainText("Soil sealing");
  await expect.poll(() => failedSameOrigin).toEqual([]);

  await page.locator("#language-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.locator("#analysis-pair-label")).toContainText("Bodemafdekking");
});
