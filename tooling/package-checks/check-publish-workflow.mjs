#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const block = [match[2]];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        line.trim() !== "" &&
        line.length - line.trimStart().length <= indent
      ) {
        index -= 1;
        break;
      }
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

export function validateWorkflow(content, options = {}) {
  const commitSentinel = 'test "$GITHUB_SHA" = "$EXPECTED_COMMIT"';
  const required = [
    "permissions:\n  contents: read\n  id-token: write",
    "environment: npm-publish",
    "expected_commit:",
    "expected_workflow_sha256:",
    "expected_source_sha256:",
    "expected_tarball_sha256:",
    commitSentinel,
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm publish artifacts/tarballs/",
    "--provenance",
    "--access public",
  ];
  const violations = required
    .filter((sentinel) => !content.includes(sentinel))
    .map((sentinel) => `missing:${sentinel.split("\n")[0]}`);
  if (options.allowTokenPublish === true) {
    const secretReferences = content.match(/secrets\.[A-Za-z\d_]+/g) ?? [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions token binding sentinel.
    const tokenBinding = "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}";
    if (
      !content.includes(tokenBinding) ||
      secretReferences.some((reference) => reference !== "secrets.NPM_TOKEN")
    )
      violations.push("bootstrap-token-binding-invalid");
  } else if (/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN/.test(content))
    violations.push("secret-token-publishing-forbidden");
  if (/uses:\s+[^\s@]+@(?:v\d+|main|master)\b/.test(content))
    violations.push("mutable-action-reference");
  if (
    /npm (?:install|pack|publish)(?![^\n]*--ignore-scripts)/.test(
      content.replace(/npm publish[^\n]*/g, ""),
    )
  )
    violations.push("npm-lifecycle-scripts-not-disabled");
  if (/pull_request:|\bpush:/.test(content))
    violations.push("automatic-publish-trigger");
  if (runBlocks(content).some((block) => block.includes("${{ inputs.")))
    violations.push("workflow-input-direct-shell-interpolation");
  return {
    verdict: violations.length === 0 ? "PASS" : "BLOCKED",
    workflowSha256: sha256(content),
    violations,
  };
}

function main() {
  const path = resolve(process.argv[2] ?? ".github/workflows/publish.yml");
  const outputIndex = process.argv.indexOf("--output");
  const result = validateWorkflow(readFileSync(path, "utf8"), {
    allowTokenPublish: process.argv.includes("--allow-token-publish"),
  });
  if (outputIndex >= 0)
    writeFileSync(
      resolve(process.argv[outputIndex + 1]),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  console.log(
    `PUBLISH_WORKFLOW=${result.verdict} sha256=${result.workflowSha256}`,
  );
  if (result.verdict !== "PASS") process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown workflow validation failure",
    );
    process.exitCode = 1;
  }
}
