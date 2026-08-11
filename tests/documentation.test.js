/* @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const retiredNames = ["Land Cover 2020", "NDVI vegetation 2020", "Tree Cover Density", "LCM-10"];

async function markdownBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownBelow(target);
    return entry.name.endsWith(".md") ? [target] : [];
  }));
  return files.flat();
}

describe("active documentation", () => {
  it("does not advertise retired map layers", async () => {
    const files = [
      path.join(projectRoot, "README.md"),
      path.join(projectRoot, "THIRD_PARTY_DATA.md"),
      ...await markdownBelow(path.join(projectRoot, "docs")),
    ];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      for (const name of retiredNames) expect(content, `${path.relative(projectRoot, file)} contains ${name}`).not.toContain(name);
    }
  });

  it("uses canonical English public-authority names", async () => {
    const files = [
      path.join(projectRoot, "README.md"),
      path.join(projectRoot, "THIRD_PARTY_DATA.md"),
      ...await markdownBelow(path.join(projectRoot, "docs")),
    ];
    const obsoleteNames = ["Flemish Government", "Flemish Department", "Government of Flanders, Department", "ANB and Digital Flanders", "Green Map Flanders", "Land use Flanders"];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      for (const name of obsoleteNames) expect(content, `${path.relative(projectRoot, file)} contains ${name}`).not.toContain(name);
    }
  });

  it("documents Landsat comparisons as public lazy-loaded features", async () => {
    const landsat = await fs.readFile(path.join(projectRoot, "docs", "landsat-surface-temperature.md"), "utf8");
    expect(landsat).toContain("used by local and GitHub Pages builds");
    expect(landsat).not.toMatch(/comparisons?.{0,80}(?:local-only|available only through)/i);
    expect(landsat).toContain("Urban Atlas 2021");
    expect(landsat).toContain("Soil sealing (official product: JaarBAK)");
  });

  it("documents population sources without presenting partial language indicators as residents", async () => {
    const guide = await fs.readFile(path.join(projectRoot, "docs", "demography-data.md"), "utf8");
    expect(guide).toContain("Current grid · 2025");
    expect(guide).toContain("100 m model · 2019");
    expect(guide).toContain("last language census was in 1947");
    expect(guide).toContain("cannot represent the Dutch, French or other-language distribution of all residents");
  });

  it("keeps one factual contract and one priority for all seventeen active views", async () => {
    const audit = await fs.readFile(path.join(projectRoot, "docs", "layer-and-comparison-audit.md"), "utf8");
    const numberedViews = audit.match(/^### \d+\. /gm) ?? [];
    const priorities = audit.match(/^- \*\*Prioritised improvement:\*\*/gm) ?? [];
    expect(numberedViews).toHaveLength(17);
    expect(priorities).toHaveLength(17);
    expect(audit).toContain("exact 1 m display masks");
    expect(audit).toContain("10 m focal-density calculations");
    expect(audit).toContain("30 m Landsat");
    expect(audit).not.toMatch(/pixel green density/i);
  });

  it("documents privacy-preserving analytics options without claiming that tracking is enabled", async () => {
    const guide = await fs.readFile(path.join(projectRoot, "docs", "analytics-monitoring.md"), "utf8");
    expect(guide).toContain("does not provide a documented visitor analytics dashboard");
    expect(guide).toContain("daily rotating HMAC");
    expect(guide).toContain("never store the raw IP");
    expect(guide).toContain("at most 48 hours");
    expect(guide).toContain("IP address is personal data");
    expect(guide).toContain("No analytics code is enabled");
  });
});
