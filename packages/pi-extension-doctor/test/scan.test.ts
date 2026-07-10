import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeCorpus, parseCorpus } from "../src/core.ts";
import { scanPackageRoots } from "../src/scan.ts";

const corpusUrl = new URL("./fixtures/corpus.json", import.meta.url);

async function loadCorpus() {
  return parseCorpus(JSON.parse(await readFile(corpusUrl, "utf8")));
}

describe("static analysis", () => {
  it("matches the frozen required-rule corpus", async () => {
    const corpus = await loadCorpus();
    const results = analyzeCorpus(corpus.packages);

    for (const fixture of corpus.packages) {
      const actual =
        results.find((result) => result.packageId === fixture.id)?.findings ??
        [];
      expect(
        actual.map(({ rule, confidence, location }) => ({
          rule,
          confidence,
          location,
        })),
      ).toEqual(fixture.expected);
    }
  });

  it("keeps comment-only stale package names clean", async () => {
    const corpus = await loadCorpus();
    const results = analyzeCorpus(corpus.packages);
    expect(
      results.find((result) => result.packageId === "clean-1")?.findings,
    ).toEqual([]);
  });
});

describe("filesystem containment", () => {
  it("reads only declared regular extension files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-valid-"));
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-valid",
        pi: { extensions: ["src/index.ts"] },
      }),
    );
    await writeFile(
      join(root, "src/index.ts"),
      'import "@mariozechner/pi-coding-agent";\n',
    );

    const report = await scanPackageRoots([root]);

    expect(report.status).toBe("findings");
    expect(report.findings.map((finding) => finding.rule)).toContain(
      "stale-mariozechner-import",
    );
    expect(report.openedPaths.every((path) => !path.startsWith("/"))).toBe(
      true,
    );
  });

  it("returns unknown for an escaping manifest entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-escape-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-escape",
        pi: { extensions: ["../outside.ts"] },
      }),
    );

    const report = await scanPackageRoots([root]);

    expect(report.status).toBe("unknown");
    expect(report.findings.map((finding) => finding.rule)).toContain(
      "invalid-extension-path",
    );
  });

  it("returns unknown for symlinked entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-link-"));
    const outside = join(root, "outside.ts");
    await writeFile(outside, "export default 1;\n");
    await symlink(outside, join(root, "link.ts"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-link", pi: { extensions: ["link.ts"] } }),
    );

    const report = await scanPackageRoots([root]);

    expect(report.status).toBe("unknown");
    expect(report.findings.map((finding) => finding.rule)).toContain(
      "unsafe-file",
    );
  });

  it("returns unknown for malformed UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-binary-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-binary",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(
      join(root, "index.ts"),
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    );

    const report = await scanPackageRoots([root]);

    expect(report.status).toBe("unknown");
    expect(report.findings.map((finding) => finding.rule)).toContain(
      "unsupported-encoding",
    );
  });

  it("returns unknown when the byte budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-budget-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-budget",
        pi: { extensions: ["index.ts"] },
      }),
    );
    await writeFile(join(root, "index.ts"), "x".repeat(128));

    const report = await scanPackageRoots([root], {
      maxFileBytes: 64,
      maxTotalBytes: 128,
    });

    expect(report.status).toBe("unknown");
    expect(report.truncated).toBe(true);
  });
});
