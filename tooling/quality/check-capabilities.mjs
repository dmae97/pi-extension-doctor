#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { computeFingerprint } from "./fingerprint-source.mjs";

const FORBIDDEN = [
  ["network", /(?:node:(?:http|https|net|tls)|\bfetch\s*\(|\bundici\b)/],
  ["process", /(?:node:child_process|(?<![.\w])(?:spawn|exec|fork)\s*\()/],
  [
    "credentials",
    /(?:process\.env|\.env\b|auth\.json|api[_-]?key|password|credential)/i,
  ],
  ["execution", /(?:\beval\s*\(|new\s+Function\s*\(|\bimport\s*\()/],
  [
    "filesystem-write",
    /\b(?:writeFile|appendFile|mkdir|rm|rename|unlink|chmod|chown)\s*\(/,
  ],
  ["telemetry", /(?:telemetry|opentelemetry|analytics)/i],
];

function collectTsFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectTsFiles(root, path, files);
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function corpusHash() {
  const path = resolve(
    "packages/pi-extension-doctor/test/fixtures/corpus.json",
  );
  const corpus = JSON.parse(readFileSync(path, "utf8"));
  const normalized = corpus.packages
    .map(({ id, manifest, files, expected }) => ({
      id,
      manifest,
      files,
      expected,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function main() {
  const packageRoot = resolve(
    process.argv[2] ?? "packages/pi-extension-doctor",
  );
  const sourceRoot = join(packageRoot, "src");
  const violations = [];
  for (const path of collectTsFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    for (const [rule, pattern] of FORBIDDEN) {
      if (pattern.test(source))
        violations.push({
          rule,
          file: relative(packageRoot, path).replaceAll("\\", "/"),
        });
    }
  }
  const result = {
    verdict: violations.length === 0 ? "PASS" : "BLOCKED",
    sourceHash: computeFingerprint(packageRoot).hash,
    corpusHash: corpusHash(),
    violations,
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/capability-verdict.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(`CAPABILITIES=${result.verdict}`);
  if (violations.length > 0) process.exitCode = 1;
}

main();
