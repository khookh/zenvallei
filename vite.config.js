import { defineConfig, loadEnv } from "vite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
  const allowedExtensions = new Set([".json", ".geojson", ".pmtiles", ".png", ".tif", ".gz"]);
  const landsatCache = new Map();
  let geospatialLibraries;
  let scenarioProcess = null;
  let scenarioBuffer = "";
  let scenarioRequestId = 0;
  const scenarioPending = new Map();
  const projectRoot = path.resolve(root, "..", "..");
  const localPython = process.platform === "win32"
    ? path.join(projectRoot, "processing", "local-layers", ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, "processing", "local-layers", ".venv", "bin", "python");

  const stopScenarioWorker = () => {
    scenarioProcess?.kill();
    scenarioProcess = null;
    scenarioPending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error("The scenario worker stopped."));
    });
    scenarioPending.clear();
    fs.rmSync(path.join(root, "land-cover-scenario", "runtime"), { recursive: true, force: true });
  };

  const scenarioWorker = () => {
    if (scenarioProcess && !scenarioProcess.killed) return scenarioProcess;
    const executable = process.env.GREENWAVE_LOCAL_PYTHON || (fs.existsSync(localPython) ? localPython : "python");
    scenarioBuffer = "";
    scenarioProcess = spawn(executable, ["-m", "greenwave_local_layers.lst_scenario", "--worker"], {
      cwd: projectRoot,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    scenarioProcess.stdout.setEncoding("utf8");
    scenarioProcess.stdout.on("data", (chunk) => {
      scenarioBuffer += chunk;
      for (;;) {
        const lineEnd = scenarioBuffer.indexOf("\n");
        if (lineEnd < 0) break;
        const line = scenarioBuffer.slice(0, lineEnd).trim();
        scenarioBuffer = scenarioBuffer.slice(lineEnd + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = scenarioPending.get(message.requestId);
          if (!pending) continue;
          scenarioPending.delete(message.requestId);
          clearTimeout(pending.timeout);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error || "Scenario calculation failed."));
        } catch (error) {
          console.error("Invalid scenario-worker response", error);
        }
      }
    });
    scenarioProcess.stderr.setEncoding("utf8");
    scenarioProcess.stderr.on("data", (message) => console.error(String(message).trim()));
    scenarioProcess.on("exit", () => {
      scenarioProcess = null;
      scenarioPending.forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(new Error("The scenario worker exited unexpectedly."));
      });
      scenarioPending.clear();
    });
    return scenarioProcess;
  };

  const callScenarioWorker = (command, payload) => new Promise((resolve, reject) => {
    const processHandle = scenarioWorker();
    const requestId = ++scenarioRequestId;
    const timeout = setTimeout(() => {
      scenarioPending.delete(requestId);
      reject(new Error("The scenario calculation timed out."));
    }, command === "simulate" ? 30_000 : 8_000);
    scenarioPending.set(requestId, { resolve, reject, timeout });
    processHandle.stdin.write(`${JSON.stringify({ requestId, command, payload })}\n`, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      scenarioPending.delete(requestId);
      reject(error);
    });
  });

  const readJsonBody = (request, maximumBytes = 2 * 1024 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maximumBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(new Error("Scenario payload is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Scenario payload is not valid JSON.")); }
    });
    request.on("error", reject);
  });

  const scenarioMiddleware = async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const scenarioManifest = path.join(root, "land-cover-scenario", "manifest.json");
    if (!fs.existsSync(scenarioManifest)) {
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: "Prepare the land-cover scenario first." }));
    }
    if (request.method !== "POST" || !/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
      response.statusCode = 405;
      return response.end(JSON.stringify({ error: "The scenario endpoint accepts JSON POST requests only." }));
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const requestProtocol = request.socket.encrypted ? "https:" : "http:";
        if (originUrl.host !== request.headers.host || originUrl.protocol !== requestProtocol) {
          response.statusCode = 403;
          return response.end(JSON.stringify({ error: "Cross-origin scenario requests are forbidden." }));
        }
      } catch {
        response.statusCode = 403;
        return response.end(JSON.stringify({ error: "Invalid request origin." }));
      }
    }
    try {
      const payload = await readJsonBody(request);
      const route = (request.url ?? "").split("?")[0].replace(/^\/+/, "");
      const command = route === "inspect" ? "inspect" : route === "simulate" ? "simulate" : null;
      if (!command) {
        response.statusCode = 404;
        return response.end(JSON.stringify({ error: "Unknown scenario endpoint." }));
      }
      const result = await callScenarioWorker(command, payload);
      return response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = /Invalid|unsupported|at most|exceeds|payload|polygon|revision/i.test(error.message) ? 400 : 503;
      return response.end(JSON.stringify({ error: error.message }));
    }
  };
  const startScenarioWorkerIfPrepared = () => {
    if (process.env.GREENWAVE_DISABLE_SCENARIO_WORKER !== "1"
      && fs.existsSync(path.join(root, "land-cover-scenario", "manifest.json"))) scenarioWorker();
  };
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
    const isJson = target.endsWith(".json") || target.endsWith(".geojson") || target.endsWith(".json.gz");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", isJson ? "no-store" : "private, max-age=3600");
    response.setHeader("Content-Type", isJson
      ? "application/json; charset=utf-8"
      : target.endsWith(".json.gz") ? "application/gzip"
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
      server.middlewares.use("/__local-data-scenario__", scenarioMiddleware);
      startScenarioWorkerIfPrepared();
      server.httpServer?.once("close", stopScenarioWorker);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__local-data__", middleware);
      server.middlewares.use("/__local-data-query__/landsat-temperature", queryLandsat);
      server.middlewares.use("/__local-data-scenario__", scenarioMiddleware);
      startScenarioWorkerIfPrepared();
      server.httpServer?.once("close", stopScenarioWorker);
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
    const mountPlaygroundAssets = (middlewares) => {
      middlewares.use("/__playground__", (request, response, next) => {
        const name = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\//, "");
        if (!allowedFiles.has(name)) return next();
        const target = path.join(exportRoot, name);
        if (!fs.existsSync(target)) return next();
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", name.endsWith(".json") ? "application/json; charset=utf-8" : "image/png");
        fs.createReadStream(target).pipe(response);
      });
    };
    plugins.push({
      name: "greenwave-local-notebook-layer",
      configureServer(server) {
        mountPlaygroundAssets(server.middlewares);
      },
      configurePreviewServer(server) {
        mountPlaygroundAssets(server.middlewares);
      },
    });
  }
  if (mode === "local-data") {
    const localDataRoot = path.resolve(process.env.GREENWAVE_LOCAL_DATA_ROOT || path.join(".cache", "local-layers"));
    plugins.push(localDataPlugin(localDataRoot));
  }
  return {
    plugins,
    // MapLibre, GeoTIFF and the comparison renderers intentionally ship as a
    // map-focused application bundle. scripts/check-dist.mjs enforces the
    // project-specific asset budgets, so suppress Vite's generic 500 kB hint.
    build: { chunkSizeWarningLimit: 1_500 },
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
