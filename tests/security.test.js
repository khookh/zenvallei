import { describe, expect, it } from "vitest";
import { escapeHtml, safeExternalUrl } from "../src/security.js";
import { buildSecurityHeaders } from "../vite.config.js";

describe("static-site security boundaries", () => {
  it("allows only HTTPS source links", () => {
    expect(safeExternalUrl("https://example.org/source")).toBe("https://example.org/source");
    expect(safeExternalUrl("javascript:alert(1)")).toBe("");
    expect(safeExternalUrl("http://example.org")).toBe("");
    expect(safeExternalUrl("not a URL")).toBe("");
  });

  it("escapes data-derived HTML", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("restricts runtime connections to self and the configured tile origin", () => {
    const headers = buildSecurityHeaders("https://tiles.example.org/{z}/{x}/{y}.png");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self' https://tiles.example.org");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});
