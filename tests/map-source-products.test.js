import { describe, expect, it } from "vitest";
import { MAP_SOURCE_PRODUCTS } from "../src/map-source-dialog.js";
import { en } from "../src/i18n/en.js";
import { nl } from "../src/i18n/nl.js";

describe("map and data source product registry", () => {
  it("lists every analytical product once under one authority", () => {
    const products = MAP_SOURCE_PRODUCTS.flatMap(({ authorityId, products: entries }) => (
      entries.map(({ productId, labelKey, url }) => ({ productId, authorityId, labelKey, url }))
    ));
    expect(new Set(products.map(({ url }) => url)).size).toBe(products.length);
    expect(new Set(products.map(({ labelKey }) => labelKey)).size).toBe(products.length);
    expect(products).toHaveLength(13);
  });

  it("has matching English and Dutch product labels", () => {
    MAP_SOURCE_PRODUCTS.forEach(({ products }) => products.forEach(({ labelKey }) => {
      expect(en[labelKey]).toBeTruthy();
      expect(nl[labelKey]).toBeTruthy();
    }));
  });
});
