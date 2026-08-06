import { defineConfig, loadEnv } from "vite";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function tileOriginForPolicy(tileUrl) {
  let tileOrigin = "";
  try {
    const parsed = new URL(tileUrl);
    if (parsed.protocol === "https:") tileOrigin = parsed.origin;
    if (parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)) tileOrigin = parsed.origin;
  } catch {
    // A relative tile URL is already covered by 'self'.
  }
  return tileOrigin;
}

export function buildContentSecurityPolicy(tileUrl = DEFAULT_TILE_URL, { forMeta = false } = {}) {
  const tileOrigin = tileOriginForPolicy(tileUrl);
  const externalSource = tileOrigin ? ` ${tileOrigin}` : "";
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${externalSource}`,
    `connect-src 'self'${externalSource}`,
    "font-src 'self'",
    "worker-src 'self' blob:",
  ];
  // Browsers ignore frame-ancestors in a meta-delivered CSP. Keep it in the
  // HTTP policy for preview and future hosts that support response headers.
  if (!forMeta) directives.splice(3, 0, "frame-ancestors 'none'");
  return directives.join("; ");
}

export function buildSecurityHeaders(tileUrl = DEFAULT_TILE_URL) {
  return {
    "Content-Security-Policy": buildContentSecurityPolicy(tileUrl),
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  // Programmatic builds, including the deterministic E2E server, configure the
  // tile origin through the process environment. Explicit process values must
  // take precedence over values loaded from local .env files.
  const tileUrl = process.env.VITE_TILE_URL || environment.VITE_TILE_URL || DEFAULT_TILE_URL;
  const plugins = [{
      name: "greenwave-security-meta",
      transformIndexHtml() {
        return [{
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: buildContentSecurityPolicy(tileUrl, { forMeta: true }),
          },
          injectTo: "head-prepend",
        }];
      },
    }];
  if (mode === "playground") {
    const exportRoot = path.resolve(process.env.GREENWAVE_PLAYGROUND_WEB_ROOT || path.join(".cache", "playground", "web"));
    const allowedFiles = new Set(["manifest.json", "test.png",
      "test-beersel.png", "test-drogenbos.png", "test-halle.png", "test-linkebeek.png",
      "test-pepingen.png", "test-sint-genesius-rode.png", "test-sint-pieters-leeuw.png"]);
    plugins.push({
      name: "greenwave-local-notebook-layer",
      configureServer(server) {
        server.middlewares.use("/__playground__", (request, response, next) => {
          const name = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\//, "");
          if (!allowedFiles.has(name)) return next();
          const target = path.join(exportRoot, name);
          if (!fs.existsSync(target)) return next();
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", name.endsWith(".json") ? "application/json; charset=utf-8" : "image/png");
          fs.createReadStream(target).pipe(response);
        });
      },
    });
  }
  return {
    plugins,
    optimizeDeps: {
      exclude: ["maplibre-gl"],
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      headers: buildSecurityHeaders(tileUrl),
    },
  };
});
