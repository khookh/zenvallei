import { expect, test } from "@playwright/test";

test("serves the complete application below the GitHub Pages project path", async ({ page }) => {
  const failedOwnRequests = [];
  const ownResponses = [];
  page.on("response", (response) => {
    if (response.url().startsWith("http://127.0.0.1:4181/zenvallei/")) {
      ownResponses.push(response.url());
      if (response.status() >= 400) failedOwnRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(".");
  await expect(page).toHaveURL(/\/zenvallei\/$/);
  await expect(page.locator("#project-intro")).toBeVisible();
  await expect(page.locator(".project-intro-heading img")).toHaveAttribute("src", "/zenvallei/assets/zennevallei-river-mark.png");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("[data-layer]")).toHaveCount(4);
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
  await page.locator('[data-layer="urban-atlas"]').click();
  await expect(page.locator('[data-layer="urban-atlas"]')).toHaveAttribute("aria-pressed", "true");
  expect(ownResponses.some((url) => url.includes("/zenvallei/data/urban-atlas.geojson"))).toBe(true);
  expect(failedOwnRequests).toEqual([]);
});
