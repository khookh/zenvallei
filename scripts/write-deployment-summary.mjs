import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STATUS_URL = "https://www.githubstatus.com/";

function outcome(value) {
  return value || "not run";
}

export function buildDeploymentSummary(environment = process.env) {
  const requestedSha = environment.REQUESTED_SHA || "unknown";
  const publishedSha = environment.PUBLISHED_SHA || "not verified";
  const pageUrl = environment.PAGES_URL || "https://khookh.github.io/zenvallei/";
  const liveSucceeded = environment.LIVE_OUTCOME === "success" && publishedSha === requestedSha;
  const deploySucceeded = environment.DEPLOY_OUTCOME === "success";
  const runUrl = environment.GITHUB_SERVER_URL && environment.GITHUB_REPOSITORY && environment.GITHUB_RUN_ID
    ? `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`
    : null;

  const lines = [
    "# GitHub Pages deployment",
    "",
    liveSucceeded
      ? `✅ Published commit \`${requestedSha}\` is live.`
      : `❌ Requested commit \`${requestedSha}\` could not be verified on the live site.`,
    "",
    "| Stage | Outcome |",
    "| --- | --- |",
    `| NDVI playground tests | ${outcome(environment.PYTHON_OUTCOME)} |`,
    `| Application verification | ${outcome(environment.APPLICATION_OUTCOME)} |`,
    `| Pages build | ${outcome(environment.BUILD_OUTCOME)} |`,
    `| Release manifest | ${outcome(environment.MANIFEST_OUTCOME)} |`,
    `| Artifact upload | ${outcome(environment.UPLOAD_OUTCOME)} |`,
    `| Pages deployment action | ${outcome(environment.DEPLOY_OUTCOME)} |`,
    `| Live commit verification | ${outcome(environment.LIVE_OUTCOME)} |`,
    `| Live application smoke test | ${outcome(environment.LIVE_APPLICATION_OUTCOME)} |`,
    "",
    `- Requested SHA: \`${requestedSha}\``,
    `- Published SHA: \`${publishedSha}\``,
    `- Live site: ${pageUrl}`,
  ];

  if (runUrl) lines.push(`- Workflow run: ${runUrl}`);

  lines.push("", "## What to do next", "");
  if (liveSucceeded && !deploySucceeded) {
    lines.push(
      `The Pages action reported \`${outcome(environment.DEPLOY_OUTCOME)}\`, but the exact requested commit is live. Publication succeeded; this was a Pages status API error. Check [GitHub Status](${STATUS_URL}) before retrying anything.`,
    );
  } else if (liveSucceeded && environment.LIVE_APPLICATION_OUTCOME === "failure") {
    lines.push("The requested commit is live, but the application smoke test failed. Inspect the named browser assertion before sharing the release.");
  } else if (liveSucceeded) {
    lines.push("No action is required. The live eight-layer product contract and both Landsat comparisons passed their browser smoke test.");
  } else if (environment.PYTHON_OUTCOME === "failure") {
    lines.push("Reproduce the failure with `python -m pytest playground/ndvi/tests -q`.");
  } else if (environment.APPLICATION_OUTCOME === "failure") {
    lines.push("Reproduce the failure with `pnpm verify:ci`.");
  } else if (environment.BUILD_OUTCOME === "failure" || environment.MANIFEST_OUTCOME === "failure") {
    lines.push("Reproduce the Pages package with `pnpm build:pages`, then inspect the named failed step.");
  } else if (environment.UPLOAD_OUTCOME === "failure") {
    lines.push(`The verified artifact could not be uploaded. Check the step log and [GitHub Status](${STATUS_URL}).`);
  } else if (environment.LIVE_FAILURE_CODE === "network") {
    lines.push(`The live site could not be reached because of a network or DNS error. Check [GitHub Status](${STATUS_URL}) and the live-verification log.`);
  } else if (environment.LIVE_FAILURE_CODE === "http") {
    lines.push(`The public release marker returned an HTTP error. Check [GitHub Status](${STATUS_URL}) and the live URL before retrying once.`);
  } else if (environment.LIVE_FAILURE_CODE === "invalid") {
    lines.push("The public `release.json` is malformed or incompatible. Inspect the live response and the release-manifest step.");
  } else if (environment.LIVE_FAILURE_CODE === "stale") {
    lines.push(`The public site still serves an older commit. Check [GitHub Status](${STATUS_URL}), then retry once after Pages has recovered.`);
  } else {
    lines.push(
      `The artifact was not confirmed live. Check the deployment and live-verification errors, then check [GitHub Status](${STATUS_URL}). Do not start duplicate runs while GitHub is degraded.`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const summary = buildDeploymentSummary();
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  } else {
    process.stdout.write(summary);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Could not write the deployment summary: ${error.message}`);
    process.exitCode = 1;
  });
}
