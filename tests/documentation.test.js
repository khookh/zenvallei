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
});
