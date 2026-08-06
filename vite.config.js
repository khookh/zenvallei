import { defineConfig, loadEnv } from "vite";

const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export function buildSecurityHeaders(tileUrl = DEFAULT_TILE_URL) {
  let tileOrigin = "";
  try {
    const parsed = new URL(tileUrl);
    if (parsed.protocol === "https:") tileOrigin = parsed.origin;
  } catch {
    // A relative tile URL is already covered by 'self'.
  }
  const externalSource = tileOrigin ? ` ${tileOrigin}` : "";
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob:${externalSource}`,
      `connect-src 'self'${externalSource}`,
      "font-src 'self'",
      "worker-src 'self' blob:",
    ].join("; "),
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
