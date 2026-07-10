import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanPackageRoots } from "../src/scan.ts";

async function snapshot(root: string): Promise<readonly string[]> {
  return (await readdir(root)).sort();
}

describe("capability boundary", () => {
  it("does not execute inspected source or mutate the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-capability-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-capability",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(
      join(root, "index.ts"),
      'throw new Error("inspected source executed");\nawait import("node:fs/promises");\n',
    );
    const before = await snapshot(root);

    const report = await scanPackageRoots([root]);

    expect(report.scannedFiles).toBe(2);
    expect(await snapshot(root)).toEqual(before);
    expect(await readFile(join(root, "index.ts"), "utf8")).toContain(
      "inspected source executed",
    );
  });
});
