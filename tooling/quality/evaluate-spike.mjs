#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint } from "./fingerprint-source.mjs";

const REQUIRED_RULES = [
  "duplicate-command",
  "stale-mariozechner-import",
  "duplicate-manifest-entry",
];
const CORPUS_PATH = resolve(
  "packages/pi-extension-doctor/test/fixtures/corpus.json",
);

function normalizedCorpus(corpus) {
  return corpus.packages
    .map(({ id, manifest, files, expected }) => ({
      id,
      manifest,
      files,
      expected,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function computeCorpusHash(path = CORPUS_PATH) {
  const corpus = JSON.parse(readFileSync(path, "utf8"));
  return createHash("sha256")
    .update(JSON.stringify(normalizedCorpus(corpus)))
    .digest("hex");
}

function validStats(stats) {
  return (
    stats &&
    ["tp", "fp", "tn", "fn", "unknown", "fpr", "precision", "recall"].every(
      (key) => Number.isFinite(stats[key]),
    )
  );
}

export function evaluateEvidence(
  evidence,
  currentSourceHash,
  currentCorpusHash,
) {
  const reasons = [];
  const expectedHashes = [
    ["metrics source", evidence.sourceHash, currentSourceHash],
    ["metrics corpus", evidence.corpusHash, currentCorpusHash],
    ["benchmark source", evidence.benchmark?.sourceHash, currentSourceHash],
    ["benchmark corpus", evidence.benchmark?.corpusHash, currentCorpusHash],
    [
      "capabilities source",
      evidence.capabilities?.sourceHash,
      currentSourceHash,
    ],
    [
      "capabilities corpus",
      evidence.capabilities?.corpusHash,
      currentCorpusHash,
    ],
  ];
  for (const [label, actual, expected] of expectedHashes) {
    if (actual !== expected) reasons.push(`${label} hash mismatch`);
  }

  for (const rule of REQUIRED_RULES) {
    const stats = evidence.perRule?.[rule];
    if (!validStats(stats)) {
      reasons.push(`${rule} metrics missing`);
      continue;
    }
    if (stats.unknown !== 0)
      reasons.push(`${rule} contains unknown observations`);
    if (stats.fpr >= 0.1) reasons.push(`${rule} FPR must be below 0.10`);
    if (stats.precision < 0.9)
      reasons.push(`${rule} precision must be at least 0.90`);
    if (stats.recall !== 1) reasons.push(`${rule} recall must equal 1.00`);
  }

  if (!validStats(evidence.aggregate))
    reasons.push("aggregate metrics missing");
  else {
    if (evidence.aggregate.unknown !== 0)
      reasons.push("aggregate contains unknown observations");
    if (evidence.aggregate.fpr >= 0.1)
      reasons.push("aggregate FPR must be below 0.10");
    if (evidence.aggregate.precision < 0.9)
      reasons.push("aggregate precision must be at least 0.90");
    if (evidence.aggregate.recall !== 1)
      reasons.push("aggregate recall must equal 1.00");
  }

  if (!evidence.benchmark?.pass) reasons.push("benchmark failed");
  if ((evidence.benchmark?.medianMs ?? Number.POSITIVE_INFINITY) >= 200)
    reasons.push("median must be below 200ms");
  if ((evidence.benchmark?.p95Ms ?? Number.POSITIVE_INFINITY) >= 350)
    reasons.push("p95 must be below 350ms");
  if ((evidence.benchmark?.startupMs ?? Number.POSITIVE_INFINITY) >= 20)
    reasons.push("startup must be below 20ms");
  if (evidence.capabilities?.verdict !== "PASS")
    reasons.push("capability verdict must be PASS");

  return { verdict: reasons.length === 0 ? "PROCEED" : "BLOCKED", reasons };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--self-test") options.selfTest = true;
    else {
      const value = argv[index + 1];
      if (!value) throw new Error(`${key} requires a value`);
      options[key.slice(2)] = value;
      index += 1;
    }
  }
  return options;
}

function selfTest(expectedHashPath) {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  if (!Array.isArray(corpus.packages) || corpus.packages.length < 30)
    throw new Error("Corpus requires at least 30 packages");
  for (const rule of REQUIRED_RULES) {
    const positives = corpus.packages.filter((fixture) =>
      fixture.expected.some((finding) => finding.rule === rule),
    ).length;
    const negatives = corpus.packages.length - positives;
    if (positives < 5 || negatives < 5)
      throw new Error(
        `${rule} requires at least 5 positive and 5 negative observations`,
      );
  }
  const actual = computeCorpusHash();
  if (expectedHashPath) {
    const expected = readFileSync(resolve(expectedHashPath), "utf8").trim();
    if (actual !== expected) throw new Error("Corpus hash mismatch");
  }
  console.log(
    `SELF_TEST=PASS packages=${corpus.packages.length} corpus=${actual}`,
  );
}

function loadJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const options = parseArgs(process.argv);
  if (options.selfTest) {
    selfTest(options["expected-corpus-hash"]);
    return;
  }

  if (options["check-artifact"]) {
    const artifact = loadJson(options["check-artifact"]);
    const sourceHash = computeFingerprint(resolve(artifact.sourceRoot)).hash;
    const corpusHash = computeCorpusHash();
    const evaluation = evaluateEvidence(
      artifact.evidence,
      sourceHash,
      corpusHash,
    );
    if (options.require && evaluation.verdict !== options.require)
      throw new Error(evaluation.reasons.join("; "));
    console.log(`ARTIFACT=${evaluation.verdict}`);
    return;
  }

  const required = [
    "source-root",
    "metrics",
    "benchmark",
    "capabilities",
    "output",
  ];
  if (required.some((key) => !options[key]))
    throw new Error(`Missing required options: ${required.join(", ")}`);
  const sourceRoot = resolve(options["source-root"]);
  const sourceHash = computeFingerprint(sourceRoot).hash;
  const corpusHash = computeCorpusHash();
  if (options["expected-corpus-hash"]) {
    const expected = readFileSync(
      resolve(options["expected-corpus-hash"]),
      "utf8",
    ).trim();
    if (corpusHash !== expected) throw new Error("Corpus hash mismatch");
  }
  const metrics = loadJson(options.metrics);
  const benchmark = loadJson(options.benchmark);
  const capabilities = loadJson(options.capabilities);
  const evidence = { ...metrics, benchmark, capabilities };
  const evaluation = evaluateEvidence(evidence, sourceHash, corpusHash);
  const artifact = {
    verdict: evaluation.verdict,
    reasons: evaluation.reasons,
    sourceRoot: options["source-root"],
    evidence,
  };
  writeJson(options.output, artifact);
  if (options.summary)
    writeFileSync(
      resolve(options.summary),
      `# Spike verdict\n\n**${evaluation.verdict}**\n\n${evaluation.reasons.join("\n")}\n`,
    );
  console.log(`VERDICT=${evaluation.verdict}`);
  if (
    (options.require && evaluation.verdict !== options.require) ||
    evaluation.verdict === "BLOCKED"
  ) {
    throw new Error(evaluation.reasons.join("; "));
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unknown evaluator failure",
    );
    process.exitCode = 1;
  }
}
