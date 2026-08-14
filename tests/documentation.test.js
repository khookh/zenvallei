/* @vitest-environment node */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMPARISON_PAIRS } from "../src/comparison-pairs.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const protectedNotebook = "playground/xgboost_2026_heatwave_regression_zennevallei.ipynb";
const protectedSha256 = "6c12819609d28ae4fdaf97edd086b567c3f697d7d1b505b0b4ac7c6d162f6174";

async function filesBelow(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(target, extension);
    return entry.name.endsWith(extension) ? [target] : [];
  }));
  return files.flat();
}

async function documentationFiles() {
  return [
    "README.md", "CONTRIBUTING.md", "THIRD_PARTY_DATA.md",
    "processing/local-layers/README.md", "src/README.md", "playground/README.md",
    ...await filesBelow(path.join(projectRoot, "docs"), ".md")
      .then((files) => files.map((file) => path.relative(projectRoot, file))),
  ].map((file) => path.join(projectRoot, file));
}

describe("active documentation", () => {
  it("keeps exactly the three approved notebooks and protects the production evidence", async () => {
    const notebooks = (await filesBelow(path.join(projectRoot, "playground"), ".ipynb"))
      .map((file) => path.relative(projectRoot, file).replaceAll("\\", "/"))
      .sort();
    expect(notebooks).toEqual([
      "playground/ecostress_zennevallei_2026.ipynb",
      "playground/ndvi/01_halle_ndvi_2020_2021.ipynb",
      protectedNotebook,
    ].sort());
    const bytes = await fs.readFile(path.join(projectRoot, protectedNotebook));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(protectedSha256);
  });

  it("contains only resolving relative Markdown links", async () => {
    for (const file of await documentationFiles()) {
      const content = await fs.readFile(file, "utf8");
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
        if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
        await expect(fs.stat(resolved), `${path.relative(projectRoot, file)} -> ${target}`)
          .resolves.toBeTruthy();
      }
    }
  });

  it("documents only package commands that exist", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const commands = new Set(Object.keys(packageJson.scripts));
    for (const file of await documentationFiles()) {
      const content = await fs.readFile(file, "utf8");
      for (const match of content.matchAll(/\bpnpm ([a-z][\w:-]*)/g)) {
        if (["install", "exec"].includes(match[1])) continue;
        expect(commands.has(match[1]), `${path.relative(projectRoot, file)} uses missing ${match[1]}`).toBe(true);
      }
    }
  });

  it("covers every live layer and comparison in the authoritative data reference", async () => {
    const reference = await fs.readFile(path.join(projectRoot, "docs/data-reference.md"), "utf8");
    const index = JSON.parse(await fs.readFile(
      path.join(projectRoot, "public/data/official-layers/index.json"), "utf8",
    ));
    const layerIds = [
      "heat", "urban-atlas", "income", "population", "land-cover-scenario",
      ...Object.keys(index.datasets),
    ];
    for (const id of new Set(layerIds)) expect(reference).toContain(`\`${id}\``);
    for (const { id } of COMPARISON_PAIRS) expect(reference).toContain(`\`${id}\``);
  });

  it("does not advertise removed experiments or retired live methods", async () => {
    const forbidden = [
      "landsat_image_regression_cnn", "landsat_image_regression_xgboost_heatwave_mean",
      "landsat_image_regression_xgboost_optuna", "xgboost-radius-benchmark",
      "xgboost-smoothing-benchmark", "heatwave-mean XGBoost",
    ];
    for (const file of await documentationFiles()) {
      const content = await fs.readFile(file, "utf8");
      for (const value of forbidden) {
        expect(content, `${path.relative(projectRoot, file)} contains ${value}`).not.toContain(value);
      }
    }
  });

  it("uses canonical public-authority names", async () => {
    const obsoleteNames = [
      "Flemish Government", "Flemish Department", "Government of Flanders, Department",
      "ANB and Digital Flanders", "Green Map Flanders", "Land use Flanders",
    ];
    for (const file of await documentationFiles()) {
      const content = await fs.readFile(file, "utf8");
      for (const value of obsoleteNames) expect(content).not.toContain(value);
    }
  });
});
