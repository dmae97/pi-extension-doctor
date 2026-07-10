import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = resolve(ROOT, "tooling/release/push-approved-source.mjs");
const work = mkdtempSync(join(tmpdir(), "pi-doctor-source-ref-test-"));

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function approval(sourceTreeSha256: string) {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"));
  return {
    approved: true,
    sourceRoot: ROOT,
    targetDirectory: join(work, "standalone"),
    repository: "owner/pi-extension-doctor",
    visibility: "public",
    commitMessage: "Release pi-extension-doctor 0.1.0",
    tag: "v0.1.0",
    workflowRef: "v0.1.0",
    packageName: "pi-extension-doctor",
    version: "0.1.0",
    sourceTreeSha256,
    workflowSha256: createHash("sha256").update(workflow).digest("hex"),
    tarballSha256: "a".repeat(64),
  };
}

describe("approved standalone source preparation", () => {
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("produces a dry-run verdict bound to the approved tree", () => {
    const hash = run(["--hash-root", "."]).stdout.trim();
    const input = join(work, "approval.json");
    const output = join(work, "result.json");
    writeFileSync(input, JSON.stringify(approval(hash)));

    const result = run(["--approval", input, "--output", output]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      status: "READY",
      sourceTreeSha256: hash,
      repository: "owner/pi-extension-doctor",
      targetDirectory: "standalone",
    });
  });

  it("fails closed for a stale approved tree hash", () => {
    const input = join(work, "stale.json");
    writeFileSync(input, JSON.stringify(approval("b".repeat(64))));
    expect(
      run(["--approval", input, "--output", join(work, "stale-result.json")])
        .status,
    ).toBe(1);
  });
});
