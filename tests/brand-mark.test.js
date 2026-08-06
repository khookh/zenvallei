/* @vitest-environment node */
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const markPath = path.resolve(import.meta.dirname, "..", "public", "assets", "zennevallei-river-mark.png");

describe("generated Zennevallei brand mark", () => {
  it("has a transparent margin, a white Statbel-derived silhouette and a blue river", async () => {
    const { data, info } = await sharp(markPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 512, height: 512, channels: 4 });

    let whitePixels = 0;
    let bluePixels = 0;
    let opaquePixels = 0;
    let touchesEdge = false;
    const whiteBounds = [Infinity, Infinity, -Infinity, -Infinity];
    const blueBounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < data.length; offset += 4) {
      const pixel = offset / 4;
      const x = pixel % info.width;
      const y = Math.floor(pixel / info.width);
      const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
      if (alpha === 0) continue;
      opaquePixels += 1;
      if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) touchesEdge = true;
      if (red >= 248 && green >= 248 && blue >= 248) {
        whitePixels += 1;
        whiteBounds[0] = Math.min(whiteBounds[0], x);
        whiteBounds[1] = Math.min(whiteBounds[1], y);
        whiteBounds[2] = Math.max(whiteBounds[2], x);
        whiteBounds[3] = Math.max(whiteBounds[3], y);
      }
      if (blue > red + 50 && blue > green + 15) {
        bluePixels += 1;
        blueBounds[0] = Math.min(blueBounds[0], x);
        blueBounds[1] = Math.min(blueBounds[1], y);
        blueBounds[2] = Math.max(blueBounds[2], x);
        blueBounds[3] = Math.max(blueBounds[3], y);
      }
    }

    expect(opaquePixels).toBeGreaterThan(25_000);
    expect(whitePixels).toBeGreaterThan(20_000);
    expect(bluePixels).toBeGreaterThan(2_000);
    expect(touchesEdge).toBe(false);
    const blueWidth = blueBounds[2] - blueBounds[0] + 1;
    const blueHeight = blueBounds[3] - blueBounds[1] + 1;
    expect(blueHeight / blueWidth).toBeGreaterThan(1.8);
    expect(blueBounds[1]).toBeLessThan(whiteBounds[1]);
    expect(blueBounds[3]).toBeGreaterThan(whiteBounds[3]);
  });
});
