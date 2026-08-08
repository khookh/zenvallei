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

export function parseSingleByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function localDataPlugin(root) {
  const allowedExtensions = new Set([".json", ".geojson", ".pmtiles", ".png", ".tif"]);
  const landsatCache = new Map();
  let geospatialLibraries;
  const loadGeospatialLibraries = () => {
    geospatialLibraries ??= Promise.all([import("geotiff"), import("proj4")]).then(([geotiff, proj4Module]) => {
      const project = proj4Module.default;
      project.defs("EPSG:32631", "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs +type=crs");
      return { fromFile: geotiff.fromFile, project };
    });
    return geospatialLibraries;
  };

  const loadLandsatObservation = async (observationId) => {
    if (landsatCache.has(observationId)) {
      const cached = landsatCache.get(observationId);
      landsatCache.delete(observationId);
      landsatCache.set(observationId, cached);
      return cached;
    }
    if (!/^landsat-\d{4}-\d{2}-\d{2}$/.test(observationId)) throw new Error("Invalid observation.");
    const manifestPath = path.join(root, "landsat-temperature", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.observations?.[observationId]) throw new Error("Unknown observation.");
    const rasterPath = path.join(root, "landsat-temperature", "analysis", `${observationId}.tif`);
    const resolvedRaster = path.resolve(rasterPath);
    if (!resolvedRaster.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(resolvedRaster)) {
      throw new Error("Analytical raster is unavailable.");
    }
    const { fromFile } = await loadGeospatialLibraries();
    const tiff = await fromFile(resolvedRaster);
    const image = await tiff.getImage();
    const rasters = await image.readRasters({ samples: [0, 1, 2] });
    await tiff.close?.();
    const loaded = {
      width: image.getWidth(), height: image.getHeight(), bounds: image.getBoundingBox(),
      temperature: rasters[0], status: rasters[1], uncertainty: rasters[2],
    };
    landsatCache.set(observationId, loaded);
    while (landsatCache.size > 2) landsatCache.delete(landsatCache.keys().next().value);
    return loaded;
  };

  const queryLandsat = async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const observation = url.searchParams.get("observation") ?? "";
      const longitude = Number(url.searchParams.get("lng"));
      const latitude = Number(url.searchParams.get("lat"));
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
        || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        response.statusCode = 400;
        return response.end(JSON.stringify({ error: "Invalid coordinates." }));
      }
      const [raster, { project }] = await Promise.all([
        loadLandsatObservation(observation),
        loadGeospatialLibraries(),
      ]);
      const [easting, northing] = project("EPSG:4326", "EPSG:32631", [longitude, latitude]);
      const [minx, miny, maxx, maxy] = raster.bounds;
      if (easting < minx || easting >= maxx || northing < miny || northing >= maxy) {
        return response.end(JSON.stringify({ status: "outside" }));
      }
      const column = Math.floor((easting - minx) / ((maxx - minx) / raster.width));
      const row = Math.floor((maxy - northing) / ((maxy - miny) / raster.height));
      const index = row * raster.width + column;
      const statusValue = Math.round(raster.status[index]);
      const result = statusValue === 1
        ? { status: "clear", temperatureC: raster.temperature[index], uncertaintyK: raster.uncertainty[index] }
        : { status: statusValue === 2 ? "cloud" : "missing" };
      return response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = /Invalid|Unknown/.test(error.message) ? 400 : 404;
      return response.end(JSON.stringify({ error: error.message }));
    }
  };
  const middleware = (request, response) => {
    let relative;
    try {
      relative = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\/+/, "");
    } catch {
      response.statusCode = 400;
      return response.end("Invalid path.");
    }
    const target = path.resolve(root, relative);
    const insideRoot = target === root || target.startsWith(`${root}${path.sep}`);
    if (!insideRoot || !allowedExtensions.has(path.extname(target).toLowerCase()) || !fs.existsSync(target)) {
      response.statusCode = 404;
      return response.end("Local data file not found.");
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      response.statusCode = 404;
      return response.end("Local data file not found.");
    }
    const isJson = target.endsWith(".json") || target.endsWith(".geojson");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", isJson ? "no-store" : "private, max-age=3600");
    response.setHeader("Content-Type", isJson
      ? "application/json; charset=utf-8"
      : target.endsWith(".png") ? "image/png"
        : target.endsWith(".tif") ? "image/tiff" : "application/vnd.pmtiles");
    if (!request.headers.range) {
      response.setHeader("Content-Length", stat.size);
      return fs.createReadStream(target).pipe(response);
    }
    const range = parseSingleByteRange(request.headers.range, stat.size);
    if (!range) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      return response.end();
    }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    response.setHeader("Content-Length", range.end - range.start + 1);
    return fs.createReadStream(target, range).pipe(response);
  };
  return {
    name: "greenwave-local-official-data",
    configureServer(server) {
      server.middlewares.use("/__local-data__", middleware);
      server.middlewares.use("/__local-data-query__/landsat-temperature", queryLandsat);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__local-data__", middleware);
      server.middlewares.use("/__local-data-query__/landsat-temperature", queryLandsat);
    },
  };
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
  if (mode === "local-data") {
    const localDataRoot = path.resolve(process.env.GREENWAVE_LOCAL_DATA_ROOT || path.join(".cache", "local-layers"));
    plugins.push(localDataPlugin(localDataRoot));
  }
  return {
    plugins,
    optimizeDeps: {
      exclude: ["maplibre-gl"],
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
      headers: buildSecurityHeaders(tileUrl),
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      headers: buildSecurityHeaders(tileUrl),
    },
  };
});
