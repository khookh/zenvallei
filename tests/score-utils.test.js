import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/i18n.js";
import { escapeHtml, formatScore, interpretationFor, scoreClass, scoreColor, scorePercentage } from "../src/score-utils.js";

const palette = {
  "no-data": "#EAE2DE",
  "score-6": "#B10064",
  "institution-present-no-score": "#F1CE63",
};

beforeEach(() => setLanguage("nl"));

describe("score utilities", () => {
  it("preserves fractional source precision in Dutch formatting", () => {
    expect(formatScore(3.75)).toBe("3,75");
    expect(formatScore(6)).toBe("6");
    expect(formatScore(9999)).toBe("Geen score");
    expect(formatScore(null)).toBe("n.v.t.");
  });

  it("uses English score formatting and interpretations after switching", () => {
    setLanguage("en");
    expect(formatScore(3.75)).toBe("3.75");
    expect(formatScore(9999)).toBe("No score");
    expect(interpretationFor({ status: "scored", scores: { final: 8 } })).toContain("High heat vulnerability");
  });

  it("maps score and source states to exact rendering classes", () => {
    expect(scoreClass(6)).toBe("score-6");
    expect(scoreClass(3.75)).toBe("score-4");
    expect(scoreClass(9999)).toBe("institution-present-no-score");
    expect(scoreClass(null, "insufficient-data")).toBe("no-data");
    expect(scoreClass(null, "institution-present-no-score")).toBe("institution-present-no-score");
    expect(scoreColor(6, palette)).toBe("#B10064");
    expect(scoreColor(null, palette, "insufficient-data")).toBe("#EAE2DE");
  });

  it("keeps score bars inside the 0–100 percent range", () => {
    expect(scorePercentage(3.75)).toBe(37.5);
    expect(scorePercentage(12)).toBe(100);
    expect(scorePercentage(-1)).toBe(0);
  });

  it("provides cautious relative interpretations", () => {
    expect(interpretationFor({ status: "scored", scores: { final: 8 } })).toContain("Hoge");
    expect(interpretationFor({ status: "insufficient-data", scores: { final: null } })).toContain("onvoldoende");
    expect(interpretationFor({ status: "institution-present-no-score", scores: { final: null } })).toContain("kwetsbare instelling");
  });

  it("escapes source text before injecting panel markup", () => {
    expect(escapeHtml('<script>"x"</script>')).toBe("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });
});
