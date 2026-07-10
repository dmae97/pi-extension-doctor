#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint } from "../quality/fingerprint-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_ROOT = join(ROOT, "packages/pi-extension-doctor");
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^src\/[a-z0-9._/-]+\.ts$/i,
];
const MAX_TARBALL_BYTES = 128 * 1024;

function parseArgs(argv) {
  const options = {
    root: PACKAGE_ROOT,
    output: join(ROOT, "artifacts/package-smoke.json"),
    packOnly: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--pack-only") options.packOnly = true;
    else if (value === "--source-root") options.root = resolve(argv[++index]);
    else if (value === "--output") options.output = resolve(argv[++index]);
    else if (value === "--tarball-dir")
      options.tarballDir = resolve(argv[++index]);
    else if (value === "--check-artifact")
      options.checkArtifact = resolve(argv[++index]);
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeEnv(home) {
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_userconfig: join(home, "empty-npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    NO_COLOR: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.platform === "win32" && process.env.SystemRoot)
    env.SystemRoot = process.env.SystemRoot;
  writeFileSync(env.npm_config_userconfig, "");
  return env;
}

function run(command, args, cwd, env, timeout = 60_000, input) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    input,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function safeFileList(files) {
  const paths = files.map((file) => file.path).sort();
  if (paths.length === 0) throw new Error("Tarball has no files");
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (
      isAbsolute(path) ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    )
      throw new Error(`Unsafe tarball path: ${path}`);
    if (!ALLOWED.some((pattern) => pattern.test(normalized)))
      throw new Error(`Unexpected tarball path: ${path}`);
  }
  return paths;
}

function snapshot(root, directory = root, output = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) snapshot(root, path, output);
    else if (stats.isFile())
      output.push({
        path: relative(root, path).replaceAll("\\", "/"),
        hash: sha256(path),
      });
  }
  return output;
}

function createTarball(packageRoot, destination, env) {
  mkdirSync(destination, { recursive: true });
  const output = run(
    "npm",
    [
      "pack",
      packageRoot,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    ROOT,
    env,
  );
  const entries = JSON.parse(output);
  if (!Array.isArray(entries) || entries.length !== 1)
    throw new Error("npm pack returned unexpected metadata");
  const entry = entries[0];
  const tarballPath = join(destination, basename(entry.filename));
  const size = statSync(tarballPath).size;
  if (size > MAX_TARBALL_BYTES)
    throw new Error(`Tarball exceeds ${MAX_TARBALL_BYTES} bytes`);
  return {
    tarballPath,
    size,
    files: safeFileList(entry.files),
    sha256: sha256(tarballPath),
  };
}

function smokeInstalledTarball(tarballPath, env, workRoot) {
  const installRoot = join(workRoot, "install");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(
    join(installRoot, "package.json"),
    '{"name":"pi-doctor-smoke","version":"0.0.0","private":true,"type":"module"}\n',
  );
  run(
    "npm",
    [
      "install",
      tarballPath,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
    ],
    installRoot,
    env,
    120_000,
  );
  const installedRoot = join(installRoot, "node_modules/pi-extension-doctor");
  const manifest = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  const entry = manifest.pi?.extensions?.[0];
  if (entry !== "./src/index.ts")
    throw new Error("Installed Pi entry mismatch");
  const before = snapshot(installRoot);
  const piCli = join(
    ROOT,
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
  const output = run(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--session-dir",
      join(workRoot, "session"),
      "-e",
      join(installedRoot, entry),
    ],
    installRoot,
    env,
    60_000,
    '{"type":"get_commands"}\n',
  );
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const commands = responses.find(
    (response) => response.command === "get_commands" && response.success,
  )?.data?.commands;
  if (
    !Array.isArray(commands) ||
    !commands.some(
      (command) =>
        command.name === "extension-doctor" && command.source === "extension",
    )
  )
    throw new Error("Packaged extension registration failed in Pi RPC mode");
  const after = snapshot(installRoot);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Extension registration mutated isolated install");
  return {
    installed: true,
    piRpcSmoke: true,
    registeredCommands: ["extension-doctor"],
    extensionZeroWrite: true,
  };
}

export function buildAndSmoke(options) {
  const workRoot = mkdtempSync(join(tmpdir(), "pi-doctor-pack-"));
  const home = join(workRoot, "home");
  mkdirSync(home, { recursive: true });
  const env = safeEnv(home);
  const destination = options.tarballDir ?? join(workRoot, "tarballs");
  try {
    const packed = createTarball(options.root, destination, env);
    const base = {
      verdict: "PASS",
      package: "pi-extension-doctor",
      version: JSON.parse(
        readFileSync(join(options.root, "package.json"), "utf8"),
      ).version,
      sourceHash: computeFingerprint(options.root).hash,
      tarballFile: basename(packed.tarballPath),
      tarballSha256: packed.sha256,
      tarballBytes: packed.size,
      files: packed.files,
    };
    const result = options.packOnly
      ? {
          ...base,
          installed: false,
          registeredCommands: [],
          extensionZeroWrite: false,
        }
      : {
          ...base,
          ...smokeInstalledTarball(packed.tarballPath, env, workRoot),
        };
    if (options.checkArtifact) {
      const previous = JSON.parse(readFileSync(options.checkArtifact, "utf8"));
      for (const key of ["sourceHash", "tarballSha256", "tarballBytes"])
        if (previous[key] !== result[key])
          throw new Error(`Stale package artifact: ${key}`);
      if (JSON.stringify(previous.files) !== JSON.stringify(result.files))
        throw new Error("Stale package artifact: files");
    } else {
      mkdirSync(dirname(options.output), { recursive: true });
      writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = buildAndSmoke(parseArgs(process.argv));
    console.log(
      `PACKAGE_SMOKE=${result.verdict} sha256=${result.tarballSha256}`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unknown pack failure",
    );
    process.exitCode = 1;
  }
}
