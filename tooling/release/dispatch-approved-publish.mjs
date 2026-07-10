#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f\d]{64}$/;
const COMMIT = /^[a-f\d]{40,64}$/;
const REPOSITORY = /^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/;
const REF = /^[A-Za-z\d][A-Za-z\d._/-]{0,127}$/;
const WORKFLOW_FILE = /^[A-Za-z\d][A-Za-z\d._-]*\.ya?ml$/;

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0)
    throw new Error(`gh failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function buildDispatch(verdict) {
  if (verdict.status !== "PUSHED" || !COMMIT.test(verdict.commit ?? ""))
    throw new Error("Source ref is not an immutable pushed commit");
  if (
    !REPOSITORY.test(verdict.repository ?? "") ||
    !REF.test(verdict.workflowRef ?? "")
  )
    throw new Error("Invalid approved repository or workflow ref");
  for (const key of ["workflowSha256", "sourceTreeSha256", "tarballSha256"])
    if (!SHA256.test(verdict[key] ?? "")) throw new Error(`Invalid ${key}`);
  const workflow = verdict.workflow ?? "publish.yml";
  if (!WORKFLOW_FILE.test(workflow))
    throw new Error("Invalid approved workflow filename");
  const fields = [
    `expected_commit=${verdict.commit}`,
    `expected_workflow_sha256=${verdict.workflowSha256}`,
    `expected_source_sha256=${verdict.sourceTreeSha256}`,
    `expected_tarball_sha256=${verdict.tarballSha256}`,
    `dry_run=${verdict.dryRun === true ? "true" : "false"}`,
  ];
  return {
    repository: verdict.repository,
    workflow,
    workflowRef: verdict.workflowRef,
    commit: verdict.commit,
    fields,
    args: [
      "workflow",
      "run",
      workflow,
      "--repo",
      verdict.repository,
      "--ref",
      verdict.workflowRef,
      ...fields.flatMap((field) => ["-f", field]),
    ],
  };
}

export function dispatchApprovedPublish({ verdictPath, outputPath, execute }) {
  const verdict = JSON.parse(readFileSync(resolve(verdictPath), "utf8"));
  const dispatch = buildDispatch(verdict);
  const result = { status: execute ? "DISPATCHED" : "READY", ...dispatch };
  if (execute) {
    runGh(dispatch.args);
    const runs = JSON.parse(
      runGh([
        "run",
        "list",
        "--repo",
        dispatch.repository,
        "--workflow",
        dispatch.workflow,
        "--commit",
        dispatch.commit,
        "--limit",
        "1",
        "--json",
        "databaseId,headSha,status,url",
      ]),
    );
    const run = runs[0];
    if (!run || run.headSha !== dispatch.commit)
      throw new Error("Unable to bind dispatch to approved run head");
    result.runId = run.databaseId;
    result.headSha = run.headSha;
    result.runUrl = run.url;
    result.runStatus = run.status;
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function main() {
  const verdictIndex = process.argv.indexOf("--source-ref-verdict");
  const outputIndex = process.argv.indexOf("--output");
  if (verdictIndex < 0 || outputIndex < 0)
    throw new Error("Required: --source-ref-verdict FILE --output FILE");
  const result = dispatchApprovedPublish({
    verdictPath: process.argv[verdictIndex + 1],
    outputPath: process.argv[outputIndex + 1],
    execute: process.argv.includes("--execute"),
  });
  console.log(`PUBLISH_DISPATCH=${result.status}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unknown dispatch failure",
    );
    process.exitCode = 1;
  }
}
