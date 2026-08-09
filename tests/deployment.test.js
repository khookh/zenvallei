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

  it("keeps verification automatic, read-only and cancellable", async () => {
    const workflow = await fs.readFile(path.join(root, ".github", "workflows", "verify.yml"), "utf8");
    expect(workflow).toMatch(/pull_request:\s*\n\s+branches: \[main\]/);
    expect(workflow).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("pages: write");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("python -m pytest playground/ndvi/tests -q");
    expect(workflow).toContain("pnpm verify:ci");
  });

  it("publishes only through one manual, non-cancelling deployment job", async () => {
    const workflow = await fs.readFile(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
    expect(workflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toMatch(/^ {2}deploy:\s*$/m);
    expect(workflow.match(/^\s+runs-on:/gm)).toHaveLength(1);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("timeout-minutes: 40");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("python -m pytest playground/ndvi/tests -q");
    expect(workflow).toContain("pnpm verify:ci");
    expect(workflow).toContain("pnpm build:pages");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("write-release-manifest.mjs");
    expect(workflow).toContain("verify-pages-release.mjs");
    expect(workflow).toContain("pnpm test:live-pages");
    expect(workflow).toContain("write-deployment-summary.mjs");
    expect(workflow).not.toContain("configure-pages");
    expect(workflow).not.toContain("enablement: true");
  });

  it("pins every GitHub Action in both workflows to a complete commit SHA", async () => {
    for (const [filename, expectedCount] of [["verify.yml", 4], ["pages.yml", 6]]) {
      const workflow = await fs.readFile(path.join(root, ".github", "workflows", filename), "utf8");
      const references = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gm)].map((match) => match[1]);
      expect(references, filename).toHaveLength(expectedCount);
      expect(references.every((reference) => /^[a-f0-9]{40}$/.test(reference)), filename).toBe(true);
      expect(workflow).toContain("pnpm install --frozen-lockfile");
    }
  });

  it("keeps the local Git passphrase file outside version control", async () => {
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("/git_passphrase.txt");
  });
});
