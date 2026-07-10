#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ALLOWLIST = [
  ".github/workflows/bootstrap-publish.yml",
  ".github/workflows/publish.yml",
  ".gitignore",
  ".npmrc",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "biome.json",
  "package-lock.json",
  "package.json",
  "packages",
  "tooling",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
  "demos",
];
const SHA256 = /^[a-f\d]{64}$/;
const REPOSITORY = /^[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+$/;
const REF = /^(?:v?\d+\.\d+\.\d+|[A-Za-z\d][A-Za-z\d._/-]{0,127})$/;

function collect(root, item, files) {
  const path = join(root, item);
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink())
    throw new Error(`Allowlist rejects symlink: ${item}`);
  if (stats.isDirectory()) {
    for (const name of readdirSync(path).sort())
      collect(root, join(item, name), files);
  } else if (stats.isFile()) files.push(item.replaceAll("\\", "/"));
}

export function hashApprovedTree(root, allowlist = DEFAULT_ALLOWLIST) {
  const files = [];
  for (const item of allowlist) collect(root, item, files);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), files };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

function validateApproval(approval, sourceRoot) {
  const requiredHashes = [
    approval.sourceTreeSha256,
    approval.workflowSha256,
    approval.tarballSha256,
  ];
  if (approval.approved !== true)
    throw new Error("Approval artifact is not approved");
  if (!REPOSITORY.test(approval.repository ?? ""))
    throw new Error("Invalid approved repository");
  if (!REF.test(approval.tag ?? "") || !REF.test(approval.workflowRef ?? ""))
    throw new Error("Invalid approved tag or workflow ref");
  if (!requiredHashes.every((hash) => SHA256.test(hash ?? "")))
    throw new Error("Invalid approved SHA-256");
  if (!approval.commitMessage || !approval.targetDirectory)
    throw new Error("Missing approved commit or target directory");
  if (
    approval.packageName !== "pi-extension-doctor" ||
    !/^\d+\.\d+\.\d+$/.test(approval.version ?? "")
  )
    throw new Error("Invalid approved package identity");
  if (!["public", "private"].includes(approval.visibility))
    throw new Error("Invalid approved repository visibility");
  const tree = hashApprovedTree(sourceRoot);
  if (tree.hash !== approval.sourceTreeSha256)
    throw new Error("Approved source tree hash mismatch");
  const workflowHash = createHash("sha256")
    .update(readFileSync(join(sourceRoot, ".github/workflows/publish.yml")))
    .digest("hex");
  if (workflowHash !== approval.workflowSha256)
    throw new Error("Approved workflow hash mismatch");
  return tree;
}

export function prepareApprovedSource({ approvalPath, outputPath, execute }) {
  const approval = JSON.parse(readFileSync(resolve(approvalPath), "utf8"));
  const sourceRoot = resolve(approval.sourceRoot ?? ".");
  const target = resolve(approval.targetDirectory);
  if (target === sourceRoot || target.startsWith(`${sourceRoot}/`))
    throw new Error("Target must be outside the source tree");
  const tree = validateApproval(approval, sourceRoot);
  const result = {
    status: execute ? "PUSHED" : "READY",
    repository: approval.repository,
    visibility: approval.visibility,
    workflowRef: approval.workflowRef,
    tag: approval.tag,
    workflowSha256: approval.workflowSha256,
    sourceTreeSha256: tree.hash,
    tarballSha256: approval.tarballSha256,
    packageName: approval.packageName,
    version: approval.version,
    files: tree.files,
    targetDirectory: basename(target),
  };
  if (execute) {
    if (existsSync(target))
      throw new Error("Approved target directory already exists");
    mkdirSync(target, { recursive: true });
    for (const item of DEFAULT_ALLOWLIST) {
      const source = join(sourceRoot, item);
      if (existsSync(source))
        cpSync(source, join(target, item), {
          recursive: true,
          errorOnExist: true,
        });
    }
    run("git", ["init", "--initial-branch=main"], target);
    run(
      "git",
      [
        "add",
        "--",
        ...DEFAULT_ALLOWLIST.filter((item) => existsSync(join(target, item))),
      ],
      target,
    );
    run("git", ["commit", "-m", approval.commitMessage], target);
    run("git", ["tag", approval.tag], target);
    run(
      "gh",
      [
        "repo",
        "create",
        approval.repository,
        `--${approval.visibility}`,
        "--source",
        target,
        "--remote",
        "origin",
      ],
      target,
    );
    run("git", ["push", "origin", "main", approval.tag], target);
    result.commit = run("git", ["rev-parse", "HEAD"], target);
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function main() {
  const hashIndex = process.argv.indexOf("--hash-root");
  if (hashIndex >= 0) {
    console.log(hashApprovedTree(resolve(process.argv[hashIndex + 1])).hash);
    return;
  }
  const approvalIndex = process.argv.indexOf("--approval");
  const outputIndex = process.argv.indexOf("--output");
  if (approvalIndex < 0 || outputIndex < 0)
    throw new Error("Required: --approval FILE --output FILE");
  const result = prepareApprovedSource({
    approvalPath: process.argv[approvalIndex + 1],
    outputPath: process.argv[outputIndex + 1],
    execute: process.argv.includes("--execute"),
  });
  console.log(`SOURCE_REF=${result.status}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown source preparation failure",
    );
    process.exitCode = 1;
  }
}
