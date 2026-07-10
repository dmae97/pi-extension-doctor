import { describe, expect, it } from "vitest";
import { renderJson, renderText } from "../src/render.ts";
import type { DoctorReport } from "../src/types.ts";

const report = (
  packageId = "fixture",
  location = "src/index.ts",
): DoctorReport => ({
  status: "findings",
  findings: [
    {
      rule: "duplicate-command",
      confidence: "confirmed",
      packageId,
      location,
    },
  ],
  scannedFiles: 2,
  truncated: false,
  openedPaths: ["package.json", "src/index.ts"],
});

describe("report rendering", () => {
  it.each([80, 120])("keeps every text line within %i columns", (width) => {
    const output = renderText(
      report("x".repeat(214), "src/very-long-file-name.ts"),
      width,
    );
    expect(output.split("\n").every((line) => line.length <= width)).toBe(true);
  });

  it("escapes control and bidi characters in text and JSON", () => {
    const unsafe = "pkg\u001b]8;;https://example.test\u0007\u202Esecret";
    const text = renderText(report(unsafe), 120);
    const json = renderJson(report(unsafe));

    for (const output of [text, json]) {
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("\u0007");
      expect(output).not.toContain("\u202E");
      expect(output).toContain("\\u{");
    }
  });

  it("redacts POSIX and Windows absolute paths", () => {
    expect(renderText(report("fixture", "/private/path.ts"), 120)).toContain(
      "redacted-path",
    );
    expect(renderJson(report("fixture", "C:\\private\\path.ts"))).toContain(
      "redacted-path",
    );
  });

  it("emits deterministic JSON without internal scan paths", () => {
    const output = renderJson(report());
    expect(output).toBe(renderJson(report()));
    expect(output).not.toContain("openedPaths");
    expect(JSON.parse(output)).toMatchObject({
      status: "findings",
      findings: [{ rule: "duplicate-command", location: "src/index.ts" }],
    });
  });
});
