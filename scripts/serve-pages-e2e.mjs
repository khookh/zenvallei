import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { build } from "vite";

const PAGE_BASE = "/zenvallei/";
const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4181;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Pages smoke-test port.");

process.env.VITE_TILE_URL = `http://127.0.0.1:${port}${PAGE_BASE}__test-tile.png`;
await build({ base: PAGE_BASE, logLevel: "warn", mode: "test" });

const distRoot = path.resolve("dist");
await fs.writeFile(
  path.join(distRoot, "__test-tile.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4S7Z1AAAAABJRU5ErkJggg==", "base64"),
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".geojson", "application/geo+json; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pmtiles", "application/vnd.pmtiles"],
  [".png", "image/png"],
  [".tif", "image/tiff"],
]);

http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname);
  if (!pathname.startsWith(PAGE_BASE)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const relative = pathname.slice(PAGE_BASE.length) || "index.html";
  const target = path.resolve(distRoot, relative);
  if (target !== distRoot && !target.startsWith(`${distRoot}${path.sep}`)) {
    response.writeHead(400).end("Invalid path");
    return;
  }
  try {
    const stat = await fs.stat(target);
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
        return;
      }
      const handle = await fs.open(target, "r");
      const body = Buffer.alloc(end - start + 1);
      await handle.read(body, 0, body.length, start);
      await handle.close();
      response.writeHead(206, {
        "Content-Type": contentTypes.get(path.extname(target)) ?? "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": body.length,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }
    const body = await fs.readFile(target);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(target)) ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Pages smoke server listening on http://127.0.0.1:${port}${PAGE_BASE}`);
});
