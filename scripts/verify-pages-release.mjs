import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export class ReleaseVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseVerificationError";
    this.code = code;
    this.details = details;
  }
}

function validateSiteUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The Pages URL must be an HTTP(S) URL without embedded credentials.");
  }
  return url;
}

function validateManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !SHA_PATTERN.test(value.commitSha) ||
    !/^\d+$/.test(String(value.workflowRunId)) ||
    Number.isNaN(Date.parse(value.builtAt))
  ) {
    throw new Error("The public release manifest is malformed or uses an unsupported schema.");
  }
  return value;
}

export async function verifyPublishedRelease({
  siteUrl,
  expectedSha,
  timeoutMs = 300_000,
  intervalMs = 5_000,
  fetchImpl = globalThis.fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  const baseUrl = validateSiteUrl(siteUrl);
  if (!SHA_PATTERN.test(expectedSha)) {
    throw new Error("The expected commit SHA must contain exactly 40 lowercase hexadecimal characters.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || !Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Polling durations must be non-negative integers and the interval must be positive.");
  }

  let elapsedMs = 0;
  let attempts = 0;
  let lastFailure = { code: "unavailable", message: "The live release marker was not requested." };

  while (true) {
    attempts += 1;
    const releaseUrl = new URL("release.json", baseUrl);
    releaseUrl.searchParams.set("release-check", `${expectedSha}-${attempts}`);

    try {
      const response = await fetchImpl(releaseUrl, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      if (!response.ok) {
        lastFailure = {
          code: "http",
          message: `The live release marker returned HTTP ${response.status}.`,
        };
      } else {
        let manifest;
        try {
          manifest = validateManifest(await response.json());
        } catch (error) {
          lastFailure = { code: "invalid", message: error.message };
          manifest = null;
        }

        if (manifest?.commitSha === expectedSha) {
          return {
            attempts,
            manifest,
            publishedSha: manifest.commitSha,
            url: releaseUrl.href,
          };
        }
        if (manifest) {
          lastFailure = {
            code: "stale",
            message: `The live site still serves commit ${manifest.commitSha}.`,
            publishedSha: manifest.commitSha,
          };
        }
      }
    } catch (error) {
      lastFailure = {
        code: "network",
        message: `The live release marker could not be reached: ${error.message}`,
      };
    }

    if (elapsedMs >= timeoutMs) {
      throw new ReleaseVerificationError(
        lastFailure.code,
        `${lastFailure.message} Requested commit ${expectedSha} was not verified after ${attempts} attempt(s).`,
        { ...lastFailure, attempts, expectedSha },
      );
    }

    const waitMs = Math.min(intervalMs, timeoutMs - elapsedMs);
    await sleep(waitMs);
    elapsedMs += waitMs;
  }
}

function requireOption(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Missing required option ${name}.`);
  return value;
}

async function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const siteUrl = requireOption(args, "--url");
  const expectedSha = requireOption(args, "--sha");
  const timeoutMs = Number(requireOption(args, "--timeout-ms"));
  const intervalMs = Number(requireOption(args, "--interval-ms"));
  const result = await verifyPublishedRelease({ siteUrl, expectedSha, timeoutMs, intervalMs });
  await writeOutput("published_sha", result.publishedSha);
  console.log(`Published commit verified: ${result.publishedSha}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const prefix = error.code ? `[${error.code}] ` : "";
    await writeOutput("failure_code", error.code || "unknown");
    console.error(`${prefix}${error.message}`);
    process.exitCode = 1;
  });
}
