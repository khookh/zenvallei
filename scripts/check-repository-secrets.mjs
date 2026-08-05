import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".cache", ".git", "dist", "node_modules", "playwright-report", "test-results"]);
const textExtensions = new Set([".cmd", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".txt", ".yaml", ".yml"]);
const patterns = [
  { label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "bearer token", pattern: /Bearer\s+eyJ[A-Za-z0-9_-]+\./i },
  { label: "client secret", pattern: /client_secret\s*[=:]\s*["'][^"']+/i },
  { label: "local Windows user path", pattern: /[A-Z]:\\Users\\[^<\\\s]+/i },
];

async function visit(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(target);
    } else if (textExtensions.has(path.extname(entry.name)) && (await fs.stat(target)).size < 30_000_000) {
      const contents = await fs.readFile(target, "utf8");
      patterns.forEach(({ label, pattern }) => {
        if (pattern.test(contents)) throw new Error(`${path.relative(projectRoot, target)} contains a possible ${label}.`);
      });
    }
  }
}

const unexpectedEnvFiles = (await fs.readdir(projectRoot)).filter((name) => name.startsWith(".env") && name !== ".env.example");
if (unexpectedEnvFiles.length) throw new Error(`Unexpected environment files: ${unexpectedEnvFiles.join(", ")}`);
await visit(projectRoot);
console.log("Repository secret and local-path scan passed.");
