#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function safeEnv(home) {
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_userconfig: join(home, "empty-npmrc"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    NO_COLOR: "1",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  writeFileSync(env.npm_config_userconfig, "");
  return env;
}

function runAudit(args, root, env) {
  const result = spawnSync("npm", args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    pass: result.status === 0,
    status: result.status,
    outputSha256: createHash("sha256").update(output).digest("hex"),
  };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const outputIndex = process.argv.indexOf("--output");
  const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : ".");
  if (outputIndex < 0) throw new Error("Required: --output FILE");
  const home = mkdtempSync(join(tmpdir(), "pi-doctor-npm-security-"));
  try {
    const env = safeEnv(home);
    const full = runAudit(["audit", "--json", "--audit-level=high"], root, env);
    const runtime = runAudit(
      ["audit", "--omit=dev", "--json", "--audit-level=high"],
      root,
      env,
    );
    const signatures = runAudit(["audit", "signatures", "--json"], root, env);
    const result = {
      verdict:
        full.pass && runtime.pass && signatures.pass ? "PASS" : "BLOCKED",
      full,
      runtime,
      signatures,
    };
    const output = resolve(root, process.argv[outputIndex + 1]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`NPM_SECURITY=${result.verdict}`);
    if (result.verdict !== "PASS") process.exitCode = 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unknown npm security failure",
    );
    process.exitCode = 1;
  }
}
