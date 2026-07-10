#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

async function verifyAttestation(url, commit) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Attestation fetch failed: HTTP ${response.status}`);
  const body = await response.text();
  if (!body.includes(commit))
    throw new Error("Attestation is not bound to approved source commit");
  return createHash("sha256").update(body).digest("hex");
}

export async function verifyPublished({
  sourceRefPath,
  dispatchPath,
  outputPath,
  execute,
}) {
  const source = JSON.parse(readFileSync(resolve(sourceRefPath), "utf8"));
  const dispatch = JSON.parse(readFileSync(resolve(dispatchPath), "utf8"));
  if (
    source.status !== "PUSHED" ||
    dispatch.status !== "DISPATCHED" ||
    dispatch.headSha !== source.commit
  )
    throw new Error("Publish evidence is not bound to approved source");
  const result = {
    verdict: execute ? "BLOCKED" : "READY",
    package: source.packageName,
    version: source.version,
    commit: source.commit,
    tarballSha256: source.tarballSha256,
  };
  if (execute) {
    const workflowRun = JSON.parse(
      runCommand(
        "gh",
        [
          "run",
          "view",
          String(dispatch.runId),
          "--repo",
          source.repository,
          "--json",
          "conclusion,headSha,status,url",
        ],
        process.cwd(),
      ),
    );
    if (
      workflowRun.status !== "completed" ||
      workflowRun.conclusion !== "success" ||
      workflowRun.headSha !== source.commit
    )
      throw new Error("Approved publish workflow did not succeed");
    const work = mkdtempSync(join(tmpdir(), "pi-doctor-published-"));
    try {
      const metadata = JSON.parse(
        runCommand(
          "npm",
          [
            "view",
            `${source.packageName}@${source.version}`,
            "dist",
            "--json",
            "--registry=https://registry.npmjs.org/",
          ],
          work,
        ),
      );
      const pack = JSON.parse(
        runCommand(
          "npm",
          [
            "pack",
            `${source.packageName}@${source.version}`,
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            work,
            "--registry=https://registry.npmjs.org/",
          ],
          work,
        ),
      )[0];
      const tarballPath = join(work, basename(pack.filename));
      if (sha256(tarballPath) !== source.tarballSha256)
        throw new Error("Published tarball differs from approved tarball");
      const provenanceUrl = metadata.attestations?.provenance?.url;
      if (
        typeof provenanceUrl !== "string" ||
        !provenanceUrl.startsWith("https://")
      )
        throw new Error("Published provenance attestation missing");
      const attestationSha256 = await verifyAttestation(
        provenanceUrl,
        source.commit,
      );
      Object.assign(result, {
        verdict: "PASS",
        registryIntegrity: metadata.integrity,
        attestationSha256,
        runId: dispatch.runId,
        runHeadSha: workflowRun.headSha,
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const sourceIndex = process.argv.indexOf("--source-ref-verdict");
  const dispatchIndex = process.argv.indexOf("--dispatch");
  const outputIndex = process.argv.indexOf("--output");
  if ([sourceIndex, dispatchIndex, outputIndex].some((index) => index < 0))
    throw new Error("Required source-ref, dispatch, and output paths");
  const result = await verifyPublished({
    sourceRefPath: process.argv[sourceIndex + 1],
    dispatchPath: process.argv[dispatchIndex + 1],
    outputPath: process.argv[outputIndex + 1],
    execute: process.argv.includes("--execute"),
  });
  console.log(`PUBLISHED=${result.verdict}`);
  if (
    process.argv.includes("--require") &&
    result.verdict !== process.argv[process.argv.indexOf("--require") + 1]
  )
    process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown published verification failure",
    );
    process.exitCode = 1;
  });
}
