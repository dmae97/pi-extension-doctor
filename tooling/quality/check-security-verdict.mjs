#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint } from "./fingerprint-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = {
  supplyChain: "artifacts/supply-chain-verdict.json",
  packageSmoke: "artifacts/package-smoke.json",
  npmSecurity: "artifacts/npm-security-verdict.json",
  capabilities: "artifacts/capability-verdict.json",
  workflow: "artifacts/publish-workflow-verdict.json",
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentEvidence() {
  const values = {};
  const hashes = {};
  for (const [name, relativePath] of Object.entries(EVIDENCE)) {
    const path = resolve(ROOT, relativePath);
    values[name] = readJson(path);
    hashes[name] = sha256(path);
  }
  return { values, hashes };
}

export function generateSecurityVerdict(outputPath) {
  const { values, hashes } = currentEvidence();
  const sourceHash = computeFingerprint(
    resolve(ROOT, "packages/pi-extension-doctor"),
  ).hash;
  const violations = [];
  if (
    values.supplyChain.verdict !== "PASS" ||
    values.supplyChain.onlineRegistryChecks !== true
  )
    violations.push("supply-chain-not-pass");
  if (
    values.packageSmoke.verdict !== "PASS" ||
    !values.packageSmoke.installed ||
    !values.packageSmoke.extensionZeroWrite
  )
    violations.push("package-smoke-not-pass");
  if (
    values.packageSmoke.sourceHash !== sourceHash ||
    values.capabilities.sourceHash !== sourceHash
  )
    violations.push("stale-package-source-evidence");
  if (values.npmSecurity.verdict !== "PASS")
    violations.push("npm-security-not-pass");
  if (values.capabilities.verdict !== "PASS")
    violations.push("capabilities-not-pass");
  if (values.workflow.verdict !== "PASS")
    violations.push("publish-workflow-not-pass");
  const result = {
    verdict: violations.length === 0 ? "PASS" : "BLOCKED",
    packageSourceSha256: sourceHash,
    evidenceSha256: hashes,
    violations,
  };
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function checkSecurityVerdict(path) {
  const artifact = readJson(resolve(path));
  const { hashes } = currentEvidence();
  const sourceHash = computeFingerprint(
    resolve(ROOT, "packages/pi-extension-doctor"),
  ).hash;
  const fresh =
    artifact.packageSourceSha256 === sourceHash &&
    JSON.stringify(artifact.evidenceSha256) === JSON.stringify(hashes);
  return {
    verdict: artifact.verdict === "PASS" && fresh ? "PASS" : "BLOCKED",
    fresh,
  };
}

function main() {
  const generateIndex = process.argv.indexOf("--generate");
  const requireIndex = process.argv.indexOf("--require");
  let result;
  if (generateIndex >= 0)
    result = generateSecurityVerdict(process.argv[generateIndex + 1]);
  else {
    const path = process.argv[requireIndex + 2];
    if (requireIndex < 0 || !path)
      throw new Error("Required: --generate FILE or --require PASS FILE");
    result = checkSecurityVerdict(path);
  }
  console.log(`SECURITY=${result.verdict}`);
  if (requireIndex >= 0 && result.verdict !== process.argv[requireIndex + 1])
    process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown security verdict failure",
    );
    process.exitCode = 1;
  }
}
