import { expect, test } from "@playwright/test";

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==",
  "base64",
);

test("loads the static map and switches its core presentation", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: TRANSPARENT_PNG,
  }));

  await page.goto("/");
  try {
    await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true", { timeout: 45_000 });
  } catch (error) {
    throw new Error(`${error.message}\nBrowser errors:\n${errors.join("\n") || "(none reported)"}`, { cause: error });
  }
  await expect(page.locator("[data-layer]")).toHaveCount(3);
  await page.locator("#language-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator('[data-heat-metric="heat"]').click();
  await expect(page.locator("#active-layer-title")).toContainText("Heat");
  await page.locator('[data-layer="land-cover"]').click();
  await expect(page.locator("#active-layer-title")).toContainText("Land cover 2020");
  expect(errors).toEqual([]);
});
