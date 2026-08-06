import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([".cmd", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".txt", ".yaml", ".yml"]);
const forbiddenSecretFile = /(?:^|\/)(?:git_passphrase\.txt|credentials?\.(?:json|txt)|passphrases?\.(?:json|txt)|secrets?\.env)$/i;
const patterns = [
  { label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "bearer token", pattern: /Bearer\s+eyJ[A-Za-z0-9_-]+\./i },
  { label: "client secret", pattern: /client_secret\s*[=:]\s*["'][^"']+/i },
  { label: "local Windows user path", pattern: /[A-Z]:\\Users\\[^<\\\s]+/i },
];

const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: projectRoot, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const relativePath of trackedFiles) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (forbiddenSecretFile.test(normalized)) throw new Error(`${relativePath} is a forbidden secret filename.`);
  const target = path.join(projectRoot, relativePath);
  const statistics = await fs.stat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (statistics && textExtensions.has(path.extname(relativePath)) && statistics.size < 30_000_000) {
    const contents = await fs.readFile(target, "utf8");
    patterns.forEach(({ label, pattern }) => {
      if (pattern.test(contents)) throw new Error(`${relativePath} contains a possible ${label}.`);
    });
  }
}

const unexpectedEnvFiles = (await fs.readdir(projectRoot)).filter((name) => name.startsWith(".env") && name !== ".env.example");
if (unexpectedEnvFiles.length) throw new Error(`Unexpected environment files: ${unexpectedEnvFiles.join(", ")}`);
console.log("Tracked-file secret, filename and local-path scan passed.");
