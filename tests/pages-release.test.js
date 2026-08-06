import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeploymentSummary } from "../scripts/write-deployment-summary.mjs";
import {
  createReleaseManifest,
  writeReleaseManifest,
} from "../scripts/write-release-manifest.mjs";
import {
  ReleaseVerificationError,
  verifyPublishedRelease,
} from "../scripts/verify-pages-release.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const tempDirectories = [];

function releaseResponse(commitSha = SHA) {
  return new Response(JSON.stringify({
    schemaVersion: 1,
    commitSha,
    workflowRunId: "12345",
    builtAt: "2026-08-06T12:00:00.000Z",
  }));
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Pages release manifest", () => {
  it("contains only the exact public release identity", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "greenwave-release-"));
    tempDirectories.push(directory);
    const { manifest, target } = await writeReleaseManifest({
      root: directory,
      commitSha: SHA,
      workflowRunId: "12345",
      builtAt: "2026-08-06T12:00:00.000Z",
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      commitSha: SHA,
      workflowRunId: "12345",
      builtAt: "2026-08-06T12:00:00.000Z",
    });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(manifest);
    expect(await fs.readFile(target, "utf8")).not.toContain(directory);
  });

  it("rejects ambiguous release identifiers", () => {
    expect(() => createReleaseManifest({ commitSha: "short", workflowRunId: "1" })).toThrow(/40 lowercase/);
    expect(() => createReleaseManifest({ commitSha: SHA, workflowRunId: "run-1" })).toThrow(/digits only/);
    expect(() => createReleaseManifest({ commitSha: SHA, workflowRunId: "1", builtAt: "today" })).toThrow(/UTC/);
  });
});

describe("live Pages verification", () => {
  it("accepts the exact requested commit", async () => {
    const result = await verifyPublishedRelease({
      siteUrl: "https://example.test/zenvallei/",
      expectedSha: SHA,
      fetchImpl: async () => releaseResponse(),
      sleep: async () => {},
    });
    expect(result.publishedSha).toBe(SHA);
    expect(result.attempts).toBe(1);
  });

  it("waits through a stale marker and accepts a delayed publication", async () => {
    let request = 0;
    const result = await verifyPublishedRelease({
      siteUrl: "https://example.test/zenvallei/",
      expectedSha: SHA,
      timeoutMs: 20,
      intervalMs: 10,
      fetchImpl: async () => releaseResponse(request++ === 0 ? OLD_SHA : SHA),
      sleep: async () => {},
    });
    expect(result.attempts).toBe(2);
  });

  it.each([
    ["stale", async () => releaseResponse(OLD_SHA)],
    ["invalid", async () => new Response("not json")],
    ["http", async () => new Response("missing", { status: 404 })],
    ["network", async () => { throw new Error("DNS failure"); }],
  ])("reports a %s live-site failure", async (code, fetchImpl) => {
    await expect(verifyPublishedRelease({
      siteUrl: "https://example.test/zenvallei/",
      expectedSha: SHA,
      timeoutMs: 0,
      intervalMs: 1,
      fetchImpl,
      sleep: async () => {},
    })).rejects.toMatchObject({ name: "ReleaseVerificationError", code });
  });

  it("uses a typed error for callers and summaries", () => {
    expect(new ReleaseVerificationError("stale", "old")).toMatchObject({ code: "stale", message: "old" });
  });
});

describe("deployment summary", () => {
  it("treats a matching live SHA as authoritative after a Pages API error", () => {
    const summary = buildDeploymentSummary({
      REQUESTED_SHA: SHA,
      PUBLISHED_SHA: SHA,
      DEPLOY_OUTCOME: "failure",
      LIVE_OUTCOME: "success",
    });
    expect(summary).toContain("Published commit");
    expect(summary).toContain("Pages status API error");
  });

  it("provides a reproducible command for application verification failures", () => {
    const summary = buildDeploymentSummary({ REQUESTED_SHA: SHA, APPLICATION_OUTCOME: "failure" });
    expect(summary).toContain("pnpm verify:ci");
  });

  it("distinguishes a stale live release in the job summary", () => {
    const summary = buildDeploymentSummary({
      REQUESTED_SHA: SHA,
      DEPLOY_OUTCOME: "success",
      LIVE_OUTCOME: "failure",
      LIVE_FAILURE_CODE: "stale",
    });
    expect(summary).toContain("still serves an older commit");
  });
});
