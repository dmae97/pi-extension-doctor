import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "pi-doctor-package-tests-"));

function run(script: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("release package checks", () => {
  beforeAll(() => writeFileSync(join(work, "empty-npmrc"), ""));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("passes deterministic local supply-chain checks without registry credentials", () => {
    // Nested path regression: a fresh checkout has no artifacts/ directory.
    const output = join(work, "fresh-checkout/artifacts/supply.json");
    const result = run("tooling/package-checks/check-supply-chain.mjs", [
      "--offline",
      "--output",
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      verdict: "ADVISORY",
      onlineRegistryChecks: false,
      violations: [],
    });
  });

  it("accepts the immutable OIDC workflow and rejects a secret-token variant", () => {
    const good = run("tooling/package-checks/check-publish-workflow.mjs", [
      ".github/workflows/publish.yml",
    ]);
    expect(good.status, good.stderr).toBe(0);

    const unsafe = join(work, "unsafe.yml");
    const workflow = readFileSync(
      resolve(ROOT, ".github/workflows/publish.yml"),
      "utf8",
    );
    writeFileSync(
      unsafe,
      `${workflow}\nenv:\n  NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
    );
    const bad = run("tooling/package-checks/check-publish-workflow.mjs", [
      unsafe,
    ]);
    expect(bad.status).toBe(1);

    const injected = join(work, "input-interpolation.yml");
    writeFileSync(
      injected,
      workflow.replace(
        'test "$GITHUB_SHA" = "$EXPECTED_COMMIT"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional unsafe workflow fixture.
        'test "$GITHUB_SHA" = "${{ inputs.expected_commit }}"',
      ),
    );
    const interpolated = run(
      "tooling/package-checks/check-publish-workflow.mjs",
      [injected],
    );
    expect(interpolated.status).toBe(1);
  });

  it("accepts the bootstrap workflow only in explicit token-bootstrap mode", () => {
    const withoutFlag = run(
      "tooling/package-checks/check-publish-workflow.mjs",
      [".github/workflows/bootstrap-publish.yml"],
    );
    expect(withoutFlag.status).toBe(1);
    expect(withoutFlag.stdout).toContain("BLOCKED");

    const withFlag = run("tooling/package-checks/check-publish-workflow.mjs", [
      ".github/workflows/bootstrap-publish.yml",
      "--allow-token-publish",
    ]);
    expect(withFlag.status, withFlag.stderr).toBe(0);
    expect(withFlag.stdout).toContain("PUBLISH_WORKFLOW=PASS");

    const foreignSecret = join(work, "foreign-secret.yml");
    const bootstrap = readFileSync(
      resolve(ROOT, ".github/workflows/bootstrap-publish.yml"),
      "utf8",
    );
    writeFileSync(
      foreignSecret,
      bootstrap.replace("secrets.NPM_TOKEN", "secrets.OTHER_TOKEN"),
    );
    const foreign = run("tooling/package-checks/check-publish-workflow.mjs", [
      foreignSecret,
      "--allow-token-publish",
    ]);
    expect(foreign.status).toBe(1);
  });

  it("packs a path-safe actual tarball and records source-bound evidence", () => {
    const output = join(work, "pack.json");
    const result = run("tooling/package-checks/pack-and-smoke.mjs", [
      "--pack-only",
      "--output",
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      verdict: "PASS",
      package: "pi-extension-doctor",
      installed: false,
    });
    expect(artifact.tarballSha256).toMatch(/^[a-f\d]{64}$/);
    expect(artifact.files).toContain("src/index.ts");
  });

  it("installs and registers the actual tarball without extension writes", () => {
    const output = join(work, "smoke.json");
    const result = run("tooling/package-checks/pack-and-smoke.mjs", [
      "--output",
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      verdict: "PASS",
      installed: true,
      registeredCommands: ["extension-doctor"],
      extensionZeroWrite: true,
    });
  });
});
