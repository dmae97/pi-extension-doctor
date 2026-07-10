#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  platform as osPlatform,
  release as osRelease,
  tmpdir,
} from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  analyzeCorpus,
  parseCorpus,
} from "../../packages/pi-extension-doctor/src/core.ts";
import extension from "../../packages/pi-extension-doctor/src/index.ts";
import { scanPackageRoots } from "../../packages/pi-extension-doctor/src/scan.ts";
import { computeFingerprint } from "../quality/fingerprint-source.mjs";

const REQUIRED_RULES = [
  "duplicate-command",
  "stale-mariozechner-import",
  "duplicate-manifest-entry",
];

function loadCorpus() {
  return parseCorpus(
    JSON.parse(
      readFileSync(
        "packages/pi-extension-doctor/test/fixtures/corpus.json",
        "utf8",
      ),
    ),
  );
}

function corpusHash(corpus) {
  const normalized = [...corpus.packages]
    .map(({ id, manifest, files, expected }) => ({
      id,
      manifest,
      files,
      expected,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function statsFor(rule, corpus, results) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let unknown = 0;
  for (const fixture of corpus.packages) {
    const expected = fixture.expected.filter(
      (finding) => finding.rule === rule,
    );
    const actual = (
      results.find((result) => result.packageId === fixture.id)?.findings ?? []
    ).filter((finding) => finding.rule === rule);
    const expectedKeys = new Set(
      expected.map((finding) => `${finding.confidence}:${finding.location}`),
    );
    const actualKeys = new Set(
      actual.map((finding) => `${finding.confidence}:${finding.location}`),
    );
    for (const key of expectedKeys) {
      if (actualKeys.has(key)) tp += 1;
      else fn += 1;
    }
    for (const key of actualKeys) if (!expectedKeys.has(key)) fp += 1;
    if (expected.length === 0 && actual.length === 0) tn += 1;
    unknown += actual.filter(
      (finding) => finding.confidence === "unknown",
    ).length;
  }
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { tp, fp, tn, fn, unknown, fpr, precision, recall };
}

function detectionMetrics(corpus, results) {
  const allRules = new Set(REQUIRED_RULES);
  for (const fixture of corpus.packages)
    for (const finding of fixture.expected) allRules.add(finding.rule);
  for (const result of results)
    for (const finding of result.findings) allRules.add(finding.rule);
  const perRule = {};
  for (const rule of [...allRules].sort())
    perRule[rule] = statsFor(rule, corpus, results);
  const totals = Object.values(perRule).reduce(
    (sum, value) => ({
      tp: sum.tp + value.tp,
      fp: sum.fp + value.fp,
      tn: sum.tn + value.tn,
      fn: sum.fn + value.fn,
      unknown: sum.unknown + value.unknown,
    }),
    { tp: 0, fp: 0, tn: 0, fn: 0, unknown: 0 },
  );
  return {
    ...totals,
    fpr: totals.fp + totals.tn === 0 ? 0 : totals.fp / (totals.fp + totals.tn),
    precision:
      totals.tp + totals.fp === 0 ? 1 : totals.tp / (totals.tp + totals.fp),
    recall:
      totals.tp + totals.fn === 0 ? 1 : totals.tp / (totals.tp + totals.fn),
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function systemInfo() {
  return {
    node: process.version,
    platform: `${osPlatform()}-${osRelease()}`,
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
  };
}

function createFixtureRoot(tmpBase) {
  const root = mkdtempSync(join(tmpBase, "doctor-benchmark-"));
  const manifest = {
    name: "@benchmark/test-package",
    version: "1.0.0",
    pi: {
      extensions: Array.from({ length: 25 }, (_, i) => `src/ext-${i}.ts`),
    },
  };
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < 25; i++) {
    const content = `// Extension ${i}\nexport default function activate(pi) {\n  pi.registerCommand("test-${i}", {\n    description: "Test command ${i}",\n    handler: async () => {\n      console.log("Command ${i}");\n    },\n  });\n}\n`;
    writeFileSync(join(root, `src/ext-${i}.ts`), content);
  }
  return root;
}

function fixtureHash(root) {
  const manifestPath = join(root, "package.json");
  const manifest = readFileSync(manifestPath, "utf8");
  const files = [];
  const manifestObj = JSON.parse(manifest);
  for (const ext of manifestObj.pi?.extensions ?? []) {
    try {
      const content = readFileSync(join(root, ext), "utf8");
      files.push({ path: ext, content });
    } catch {}
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const data = JSON.stringify({ manifest, files });
  return createHash("sha256").update(data).digest("hex");
}

function fileDistribution(root) {
  const manifestPath = join(root, "package.json");
  const manifestBytes = readFileSync(manifestPath, "utf8").length;
  const manifestObj = JSON.parse(readFileSync(manifestPath, "utf8"));
  let totalFiles = 1;
  let totalBytes = manifestBytes;
  const fileSizes = [manifestBytes];

  for (const ext of manifestObj.pi?.extensions ?? []) {
    try {
      const content = readFileSync(join(root, ext), "utf8");
      totalFiles += 1;
      totalBytes += content.length;
      fileSizes.push(content.length);
    } catch {}
  }

  return {
    files: totalFiles,
    bytes: totalBytes,
    avgBytes: Math.round(totalBytes / totalFiles),
    minBytes: Math.min(...fileSizes),
    maxBytes: Math.max(...fileSizes),
  };
}

async function main() {
  const corpus = loadCorpus();
  const sourceHash = computeFingerprint(
    resolve("packages/pi-extension-doctor"),
  ).hash;
  const frozenCorpusHash = corpusHash(corpus);
  const firstResults = analyzeCorpus(corpus.packages);
  const registeredCommands = [];
  const startupStart = performance.now();
  extension({
    registerCommand: (name) => registeredCommands.push(name),
    getCommands: () => [],
    getAllTools: () => [],
    getActiveTools: () => [],
  });
  const startupMs = performance.now() - startupStart;
  if (
    JSON.stringify(registeredCommands) !== JSON.stringify(["extension-doctor"])
  )
    throw new Error(
      "Startup registration benchmark did not load the doctor command",
    );

  mkdirSync("artifacts", { recursive: true });
  if (process.argv.includes("--metrics-only")) {
    const perRule = {};
    const allRules = new Set(REQUIRED_RULES);
    for (const fixture of corpus.packages)
      for (const finding of fixture.expected) allRules.add(finding.rule);
    for (const result of firstResults)
      for (const finding of result.findings) allRules.add(finding.rule);
    for (const rule of [...allRules].sort())
      perRule[rule] = statsFor(rule, corpus, firstResults);
    const metrics = {
      sourceHash,
      corpusHash: frozenCorpusHash,
      perRule,
      aggregate: detectionMetrics(corpus, firstResults),
    };
    writeFileSync(
      "artifacts/detection-metrics.json",
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
    console.log(
      `METRICS tp=${metrics.aggregate.tp} fp=${metrics.aggregate.fp} fn=${metrics.aggregate.fn}`,
    );
    return;
  }

  // Real filesystem benchmark for scanPackageRoots
  const tmpBase = tmpdir();
  const sysInfo = systemInfo();

  // Create one fixture for distribution analysis and hash
  const analysisRoot = createFixtureRoot(tmpBase);
  const fixtureSha256 = fixtureHash(analysisRoot);
  const distribution = fileDistribution(analysisRoot);

  // Warm up (5 iterations with same root)
  for (let i = 0; i < 5; i++) {
    await scanPackageRoots([analysisRoot]);
  }

  // Cold iterations (30 fresh roots)
  const coldTimes = [];
  for (let i = 0; i < 30; i++) {
    const coldRoot = createFixtureRoot(tmpBase);
    const start = performance.now();
    await scanPackageRoots([coldRoot]);
    coldTimes.push(performance.now() - start);
    rmSync(coldRoot, { recursive: true, force: true });
  }

  // Warm iterations (30 with same root)
  const warmRoot = createFixtureRoot(tmpBase);
  const warmTimes = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await scanPackageRoots([warmRoot]);
    warmTimes.push(performance.now() - start);
  }

  // Cleanup
  rmSync(analysisRoot, { recursive: true, force: true });
  rmSync(warmRoot, { recursive: true, force: true });

  coldTimes.sort((a, b) => a - b);
  warmTimes.sort((a, b) => a - b);

  const allTimes = [...coldTimes, ...warmTimes].sort((a, b) => a - b);

  const coldMedian = percentile(coldTimes, 0.5);
  const coldP95 = percentile(coldTimes, 0.95);
  const warmMedian = percentile(warmTimes, 0.5);
  const warmP95 = percentile(warmTimes, 0.95);
  const aggregateMedian = percentile(allTimes, 0.5);
  const aggregateP95 = percentile(allTimes, 0.95);

  const result = {
    system: sysInfo,
    sourceHash,
    corpusHash: frozenCorpusHash,
    fixtureSha256,
    distribution,
    declaredExtensions: 25,
    warmupRuns: 5,
    coldIterations: 30,
    warmIterations: 30,
    startupMs,
    cold: {
      medianMs: coldMedian,
      p95Ms: coldP95,
    },
    warm: {
      medianMs: warmMedian,
      p95Ms: warmP95,
    },
    medianMs: aggregateMedian,
    p95Ms: aggregateP95,
    aggregate: {
      medianMs: aggregateMedian,
      p95Ms: aggregateP95,
    },
    thresholds: {
      medianMs: 200,
      p95Ms: 350,
      startupMs: 20,
    },
    pass: startupMs < 20 && aggregateMedian < 200 && aggregateP95 < 350,
  };

  writeFileSync(
    "artifacts/doctor-benchmark.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );

  console.log(
    `BENCHMARK startup=${result.startupMs.toFixed(3)}ms cold_median=${result.cold.medianMs.toFixed(3)}ms cold_p95=${result.cold.p95Ms.toFixed(3)}ms warm_median=${result.warm.medianMs.toFixed(3)}ms warm_p95=${result.warm.p95Ms.toFixed(3)}ms aggregate_median=${result.aggregate.medianMs.toFixed(3)}ms aggregate_p95=${result.aggregate.p95Ms.toFixed(3)}ms`,
  );

  if (!result.pass) {
    console.log(
      `FAIL: startup=${result.startupMs.toFixed(3)}ms (threshold: <${result.thresholds.startupMs}ms) aggregate_median=${result.aggregate.medianMs.toFixed(3)}ms (threshold: <${result.thresholds.medianMs}ms) aggregate_p95=${result.aggregate.p95Ms.toFixed(3)}ms (threshold: <${result.thresholds.p95Ms}ms)`,
    );
    process.exitCode = 1;
  }
}

main();
