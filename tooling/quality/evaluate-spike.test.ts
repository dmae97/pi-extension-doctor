import { describe, expect, it } from "vitest";
import {
  type EvidenceBundle,
  evaluateEvidence,
  type RuleStats,
} from "./evaluate-spike.mjs";

const PASSING_STATS: RuleStats = {
  tp: 5,
  fp: 0,
  tn: 5,
  fn: 0,
  unknown: 0,
  fpr: 0,
  precision: 1,
  recall: 1,
};

type EvidenceOptions = {
  readonly sourceHash?: string;
  readonly corpusHash?: string;
  readonly duplicateStats?: RuleStats;
  readonly benchmarkPass?: boolean;
  readonly capabilityVerdict?: string;
};

function evidence(options: EvidenceOptions = {}): EvidenceBundle {
  const sourceHash = options.sourceHash ?? "a".repeat(64);
  const corpusHash = options.corpusHash ?? "b".repeat(64);
  return {
    sourceHash,
    corpusHash,
    perRule: {
      "duplicate-command": options.duplicateStats ?? PASSING_STATS,
      "stale-mariozechner-import": PASSING_STATS,
      "duplicate-manifest-entry": PASSING_STATS,
    },
    aggregate: { ...PASSING_STATS, tp: 15, tn: 15 },
    benchmark: {
      sourceHash,
      corpusHash,
      medianMs: 1,
      p95Ms: 2,
      startupMs: 1,
      pass: options.benchmarkPass ?? true,
    },
    capabilities: {
      sourceHash,
      corpusHash,
      verdict: options.capabilityVerdict ?? "PASS",
    },
  };
}

describe("evidence evaluator", () => {
  it("proceeds for matching evidence above every threshold", () => {
    expect(
      evaluateEvidence(evidence(), "a".repeat(64), "b".repeat(64)).verdict,
    ).toBe("PROCEED");
  });

  it("blocks a positive unknown as a false negative", () => {
    const duplicateStats = {
      ...PASSING_STATS,
      fn: 1,
      unknown: 1,
      recall: 5 / 6,
    };
    expect(
      evaluateEvidence(
        evidence({ duplicateStats }),
        "a".repeat(64),
        "b".repeat(64),
      ).verdict,
    ).toBe("BLOCKED");
  });

  it("blocks a per-rule false-positive rate at the threshold", () => {
    const duplicateStats = {
      ...PASSING_STATS,
      fp: 1,
      tn: 9,
      fpr: 0.1,
      precision: 5 / 6,
    };
    expect(
      evaluateEvidence(
        evidence({ duplicateStats }),
        "a".repeat(64),
        "b".repeat(64),
      ).verdict,
    ).toBe("BLOCKED");
  });

  it("blocks stale source or corpus hashes", () => {
    expect(
      evaluateEvidence(evidence(), "c".repeat(64), "b".repeat(64)).verdict,
    ).toBe("BLOCKED");
    expect(
      evaluateEvidence(evidence(), "a".repeat(64), "c".repeat(64)).verdict,
    ).toBe("BLOCKED");
  });

  it("blocks failed benchmark or capability evidence", () => {
    expect(
      evaluateEvidence(
        evidence({ benchmarkPass: false }),
        "a".repeat(64),
        "b".repeat(64),
      ).verdict,
    ).toBe("BLOCKED");
    expect(
      evaluateEvidence(
        evidence({ capabilityVerdict: "BLOCKED" }),
        "a".repeat(64),
        "b".repeat(64),
      ).verdict,
    ).toBe("BLOCKED");
  });
});
