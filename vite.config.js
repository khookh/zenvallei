import { defineConfig, loadEnv } from "vite";

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
  return {
    plugins: [{
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
    }],
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
