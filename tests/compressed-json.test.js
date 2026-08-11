import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonAsset } from "../src/comparisons/compressed-json.js";

describe("compressed comparison JSON", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("losslessly reads a static gzip index", async () => {
    const payload = { schemaVersion: 2, records: [[1, 42, 1000.25]] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gzipSync(JSON.stringify(payload)))));
    await expect(fetchJsonAsset("/points.json.gz")).resolves.toEqual(payload);
  });

  it("keeps ordinary JSON compatible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(fetchJsonAsset("/statistics.json")).resolves.toEqual({ ok: true });
  });
});
