import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("GitHub Pages deployment contract", () => {
  it("pins the real project-site path in build and smoke-test commands", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    expect(packageJson.scripts["build:pages"]).toContain("--base=/zenvallei/");
    expect(packageJson.scripts["test:pages"]).toContain("playwright.pages.config.js");
  });

  it("pins every GitHub Action to a complete commit SHA", async () => {
    const workflow = await fs.readFile(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
    expect(actionReferences.length).toBe(7);
    expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true);
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm verify:ci");
  });

  it("keeps the local Git passphrase file outside version control", async () => {
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("/git_passphrase.txt");
  });
});
