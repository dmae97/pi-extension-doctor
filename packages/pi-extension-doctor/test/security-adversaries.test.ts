import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanPackageRoots } from "../src/scan.ts";

describe("scanner security adversaries", () => {
  it("returns unknown for NUL-bearing binary-like input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-nul-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-nul",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(join(root, "index.ts"), "export\0default 1");

    const report = await scanPackageRoots([root]);

    expect(report.status).toBe("unknown");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        rule: "unsupported-encoding",
        confidence: "unknown",
        location: "index.ts",
      }),
    );
  });
});
