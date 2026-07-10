import { describe, expect, it } from "vitest";
import { analyzeCorpus, parseCorpus } from "../src/core.ts";

const input = {
  version: 1,
  packages: [
    {
      id: "fixture",
      manifest: { name: "fixture", pi: { extensions: ["src/index.ts"] } },
      files: { "src/index.ts": 'import "@mariozechner/pi-coding-agent";\n' },
      expected: [],
    },
  ],
};

describe("corpus boundary", () => {
  it("parses a valid corpus into analyzable packages", () => {
    const corpus = parseCorpus(input);
    expect(analyzeCorpus(corpus.packages)[0]?.findings[0]?.rule).toBe(
      "stale-mariozechner-import",
    );
  });

  it("rejects malformed corpus input", () => {
    expect(() => parseCorpus({ version: 1, packages: "wrong" })).toThrow(
      "Invalid corpus",
    );
  });
});
