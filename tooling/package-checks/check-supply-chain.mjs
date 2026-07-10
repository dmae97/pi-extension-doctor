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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = "https://registry.npmjs.org/";
const LIFECYCLE = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);
const SHA256 = /^[a-f\d]{64}$/;

function parseArgs(argv) {
  const options = {
    root: ROOT,
    output: "artifacts/supply-chain-verdict.json",
    online: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--offline") options.online = false;
    else if (value === "--root") options.root = resolve(argv[++index]);
    else if (value === "--output") options.output = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExactVersion(version) {
  return (
    typeof version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  );
}

function previousVersion(versions, current) {
  const stable = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const currentIndex = stable.indexOf(current);
  return currentIndex > 0 ? stable[currentIndex - 1] : undefined;
}

function normalizedMaintainers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "string" ? entry : (entry?.name ?? entry?.email ?? ""),
    )
    .filter(Boolean)
    .sort();
}

function safeNpmEnv(home) {
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_userconfig: join(home, "empty-npmrc"),
    npm_config_registry: REGISTRY,
    npm_config_ignore_scripts: "true",
    NO_COLOR: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  writeFileSync(env.npm_config_userconfig, "");
  return env;
}

function npmView(name, version, home) {
  const target = version ? `${name}@${version}` : name;
  const result = spawnSync(
    "npm",
    ["view", target, "time", "maintainers", "versions", "license", "--json"],
    {
      encoding: "utf8",
      env: safeNpmEnv(home),
      timeout: 30_000,
    },
  );
  if (result.status !== 0)
    throw new Error(`Registry metadata unavailable for ${target}`);
  return JSON.parse(result.stdout);
}

function inspectLocal(root, violations) {
  const rootManifestPath = join(root, "package.json");
  const packageManifestPath = join(
    root,
    "packages/pi-extension-doctor/package.json",
  );
  const lockPath = join(root, "package-lock.json");
  const rootManifest = readJson(rootManifestPath);
  const packageManifest = readJson(packageManifestPath);
  const lock = readJson(lockPath);

  if (Object.keys(packageManifest.dependencies ?? {}).length > 0)
    violations.push("runtime-dependencies-present");
  for (const script of Object.keys(packageManifest.scripts ?? {}))
    if (LIFECYCLE.has(script)) violations.push(`lifecycle-script:${script}`);
  if (packageManifest.license !== "MIT")
    violations.push("package-license-not-mit");
  if (!packageManifest.repository?.url?.startsWith("git+https://github.com/"))
    violations.push("repository-not-canonical-https");
  if (packageManifest.engines?.node !== ">=22.19.0")
    violations.push("node-engine-mismatch");
  if (!packageManifest.keywords?.includes("pi-package"))
    violations.push("missing-pi-package-keyword");
  if (
    JSON.stringify(packageManifest.pi?.extensions) !==
    JSON.stringify(["./src/index.ts"])
  )
    violations.push("pi-extension-entry-mismatch");
  if (
    packageManifest.peerDependencies?.["@earendil-works/pi-coding-agent"] !==
    "*"
  )
    violations.push("pi-peer-contract-mismatch");

  const direct = rootManifest.devDependencies ?? {};
  for (const [name, version] of Object.entries(direct)) {
    if (!isExactVersion(version))
      violations.push(`dev-dependency-not-exact:${name}`);
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked || locked.version !== version)
      violations.push(`lock-version-mismatch:${name}`);
    if (!locked?.integrity?.startsWith("sha512-"))
      violations.push(`lock-integrity-missing:${name}`);
    if (!locked?.license) violations.push(`lock-license-missing:${name}`);
    if (locked?.hasInstallScript)
      violations.push(`direct-dev-lifecycle-script:${name}`);
  }

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || entry.link) continue;
    if (
      typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith(REGISTRY)
    )
      violations.push(`non-registry-lock-url:${path}`);
    if (
      typeof entry.integrity !== "string" ||
      !entry.integrity.startsWith("sha512-")
    )
      violations.push(`missing-lock-integrity:${path}`);
  }

  return {
    direct,
    hashes: {
      rootManifest: hashFile(rootManifestPath),
      packageManifest: hashFile(packageManifestPath),
      lockfile: hashFile(lockPath),
    },
  };
}

function applyReviewedExceptions(root, direct, violations) {
  const reviewPath = join(
    root,
    "tooling/package-checks/dev-dependency-review.json",
  );
  const review = readJson(reviewPath);
  const expiresAt = Date.parse(`${review.expiresAt}T23:59:59Z`);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    violations.push("dependency-review-expired");
    return { applied: [], hash: hashFile(reviewPath) };
  }
  const applied = [];
  for (const exception of review.exceptions ?? []) {
    const index = violations.indexOf(exception.violation);
    const name = exception.violation?.split(":").slice(1).join(":");
    if (
      index < 0 ||
      direct[name] !== exception.version ||
      typeof exception.reason !== "string" ||
      exception.reason.length < 40
    ) {
      violations.push(
        `invalid-or-stale-review-exception:${exception.violation}`,
      );
      continue;
    }
    violations.splice(index, 1);
    applied.push(exception.violation);
  }
  return { applied, hash: hashFile(reviewPath) };
}

function inspectRegistry(root, direct, violations) {
  const home = mkdtempSync(join(tmpdir(), "pi-doctor-npm-view-"));
  const dependencies = [];
  try {
    for (const [name, version] of Object.entries(direct)) {
      const metadata = npmView(name, undefined, home);
      const versions = Array.isArray(metadata.versions)
        ? metadata.versions
        : [];
      const publishedAt = metadata.time?.[version];
      const ageMs =
        typeof publishedAt === "string"
          ? Date.now() - Date.parse(publishedAt)
          : Number.NaN;
      if (!Number.isFinite(ageMs) || ageMs < 2 * 24 * 60 * 60 * 1000)
        violations.push(`release-age-gate:${name}`);
      const currentMaintainers = normalizedMaintainers(metadata.maintainers);
      const previous = previousVersion(versions, version);
      let maintainerChanged = false;
      if (previous) {
        const previousMetadata = npmView(name, previous, home);
        maintainerChanged =
          JSON.stringify(currentMaintainers) !==
          JSON.stringify(normalizedMaintainers(previousMetadata.maintainers));
        if (maintainerChanged) violations.push(`maintainer-change:${name}`);
      }
      const installed = readJson(
        join(root, "node_modules", name, "package.json"),
      );
      if (!installed.license)
        violations.push(`installed-license-missing:${name}`);
      dependencies.push({
        name,
        version,
        previous,
        publishedAt,
        maintainers: currentMaintainers,
        maintainerChanged,
        license: installed.license,
      });
    }
    return dependencies;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function runSupplyChainCheck(options) {
  const violations = [];
  const local = inspectLocal(options.root, violations);
  const dependencies = options.online
    ? inspectRegistry(options.root, local.direct, violations)
    : [];
  const review = options.online
    ? applyReviewedExceptions(options.root, local.direct, violations)
    : {
        applied: [],
        hash: hashFile(
          join(
            options.root,
            "tooling/package-checks/dev-dependency-review.json",
          ),
        ),
      };
  const result = {
    verdict:
      violations.length === 0
        ? options.online
          ? "PASS"
          : "ADVISORY"
        : "BLOCKED",
    checkedAt: new Date().toISOString(),
    onlineRegistryChecks: options.online,
    hashes: local.hashes,
    dependencies,
    reviewedExceptions: review.applied,
    reviewSha256: review.hash,
    violations,
  };
  if (!Object.values(result.hashes).every((hash) => SHA256.test(hash)))
    throw new Error("Invalid evidence hash");
  const output = resolve(options.root, options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = runSupplyChainCheck(parseArgs(process.argv));
    console.log(`SUPPLY_CHAIN=${result.verdict}`);
    if (result.verdict === "BLOCKED") process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unknown supply-chain failure",
    );
    process.exitCode = 1;
  }
}
