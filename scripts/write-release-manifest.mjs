import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^\d+$/;

function requireOption(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required option ${name}.`);
  }
  return value;
}

export function createReleaseManifest({ commitSha, workflowRunId, builtAt = new Date().toISOString() }) {
  if (!SHA_PATTERN.test(commitSha)) {
    throw new Error("The release commit SHA must contain exactly 40 lowercase hexadecimal characters.");
  }
  if (!RUN_ID_PATTERN.test(String(workflowRunId))) {
    throw new Error("The workflow run ID must contain digits only.");
  }
  if (Number.isNaN(Date.parse(builtAt)) || !builtAt.endsWith("Z")) {
    throw new Error("The build time must be a valid UTC ISO timestamp.");
  }

  return {
    schemaVersion: 1,
    commitSha,
    workflowRunId: String(workflowRunId),
    builtAt,
  };
}

export async function writeReleaseManifest({ root, commitSha, workflowRunId, builtAt }) {
  const manifest = createReleaseManifest({ commitSha, workflowRunId, builtAt });
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, "release.json");
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, target };
}

async function main() {
  const args = process.argv.slice(2);
  const root = requireOption(args, "--root");
  const commitSha = requireOption(args, "--sha");
  const workflowRunId = requireOption(args, "--run-id");
  const builtAtIndex = args.indexOf("--built-at");
  const builtAt = builtAtIndex >= 0 ? args[builtAtIndex + 1] : undefined;

  const { target } = await writeReleaseManifest({ root, commitSha, workflowRunId, builtAt });
  console.log(`Release identity written to ${path.basename(target)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
