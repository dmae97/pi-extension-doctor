import { describe, expect, it } from "vitest";
import { escapeUntrusted, renderJson, renderText } from "../src/render.ts";
import type { DoctorReport } from "../src/types.ts";

const report: DoctorReport = {
  status: "findings",
  truncated: false,
  scannedFiles: 1,
  openedPaths: ["package.json"],
  findings: [
    {
      rule: "stale-mariozechner-import",
      confidence: "inferred",
      packageId: "fixture\\n\u001b]8;;https://evil.invalid\u0007bad\u202e",
      location: "src/index.ts",
      message: "token sk-test-secret /home/alice/project",
    },
  ],
};

describe("privacy rendering", () => {
  it("visibly escapes terminal and bidi controls", () => {
    const escaped = escapeUntrusted("a\n\u001b]0;owned\u0007\u202eb");
    expect(escaped).toBe("a\\u{a}\\u{1b}]0;owned\\u{7}\\u{202e}b");
  });

  it("does not render raw messages, source snippets, tokens, or absolute paths", () => {
    const text = renderText(report, 80);
    const json = renderJson(report);

    for (const output of [text, json]) {
      expect(output).not.toContain("sk-test-secret");
      expect(output).not.toContain("/home/alice");
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("\u202e");
      expect(output).toContain("stale-mariozechner-import");
      expect(output).toContain("inferred");
    }
  });

  it("keeps output bounded at 80 and 120 columns", () => {
    for (const width of [80, 120]) {
      const lines = renderText(report, width).split("\n");
      expect(lines.every((line) => line.length <= width)).toBe(true);
    }
  });
});
