#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "artifacts",
  "coverage",
  "dist",
  ".git",
  ".omk",
]);

function collectFiles(root, directory = root, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const stats = lstatSync(path);
    if (stats.isSymbolicLink())
      throw new Error(`Source fingerprint rejects symlink: ${relativePath}`);
    if (stats.isDirectory()) collectFiles(root, path, files);
    else if (stats.isFile()) files.push(relativePath);
  }
  return files;
}

export function computeFingerprint(rootPath) {
  const root = resolve(rootPath);
  const files = collectFiles(root).sort();
  if (files.length === 0)
    throw new Error("No source files found to fingerprint");
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), fileCount: files.length, files };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const result = computeFingerprint(root);
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error("--output requires a path");
    writeFileSync(output, `${result.hash}\n`);
  }
  console.log(result.hash);
}
