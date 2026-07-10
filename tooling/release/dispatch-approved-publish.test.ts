import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = resolve(ROOT, "tooling/release/dispatch-approved-publish.mjs");
const work = mkdtempSync(join(tmpdir(), "pi-doctor-dispatch-test-"));
const valid = {
  status: "PUSHED",
  repository: "owner/pi-extension-doctor",
  workflowRef: "v0.1.0",
  commit: "a".repeat(40),
  workflowSha256: "b".repeat(64),
  sourceTreeSha256: "c".repeat(64),
  tarballSha256: "d".repeat(64),
};

function run(input: object, name: string) {
  const source = join(work, `${name}-source.json`);
  const output = join(work, `${name}-output.json`);
  writeFileSync(source, JSON.stringify(input));
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--source-ref-verdict", source, "--output", output],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  return { result, output };
}

describe("approved publish dispatch", () => {
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("builds a dry-run command with an explicit workflow ref and every approved hash", () => {
    const { result, output } = run(valid, "valid");
    expect(result.status, result.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      status: "READY",
      workflow: "publish.yml",
      workflowRef: "v0.1.0",
    });
    expect(artifact.args).toEqual(
      expect.arrayContaining([
        "--repo",
        "owner/pi-extension-doctor",
        "--ref",
        "v0.1.0",
      ]),
    );
    expect(artifact.fields).toEqual(
      expect.arrayContaining([
        `expected_commit=${valid.commit}`,
        `expected_workflow_sha256=${valid.workflowSha256}`,
        `expected_source_sha256=${valid.sourceTreeSha256}`,
        `expected_tarball_sha256=${valid.tarballSha256}`,
      ]),
    );
  });

  it("fails closed instead of selecting a default-branch workflow", () => {
    const { result } = run({ ...valid, workflowRef: "" }, "invalid");
    expect(result.status).toBe(1);
  });

  it("dispatches an approved alternate workflow file with an explicit dry run", () => {
    const { result, output } = run(
      { ...valid, workflow: "bootstrap-publish.yml", dryRun: true },
      "bootstrap",
    );
    expect(result.status, result.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      status: "READY",
      workflow: "bootstrap-publish.yml",
    });
    expect(artifact.args).toEqual(
      expect.arrayContaining(["workflow", "run", "bootstrap-publish.yml"]),
    );
    expect(artifact.fields).toContain("dry_run=true");

    const { result: invalid } = run(
      { ...valid, workflow: "../evil.yml" },
      "bad-workflow",
    );
    expect(invalid.status).toBe(1);
  });
});
