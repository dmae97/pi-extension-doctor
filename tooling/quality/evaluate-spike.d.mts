export type RuleStats = {
  readonly tp: number;
  readonly fp: number;
  readonly tn: number;
  readonly fn: number;
  readonly unknown: number;
  readonly fpr: number;
  readonly precision: number;
  readonly recall: number;
};

export type EvidenceBundle = {
  readonly sourceHash: string;
  readonly corpusHash: string;
  readonly perRule: Readonly<Record<string, RuleStats>>;
  readonly aggregate: RuleStats;
  readonly benchmark: {
    readonly sourceHash: string;
    readonly corpusHash: string;
    readonly medianMs: number;
    readonly p95Ms: number;
    readonly startupMs: number;
    readonly pass: boolean;
  };
  readonly capabilities: {
    readonly sourceHash: string;
    readonly corpusHash: string;
    readonly verdict: string;
  };
};

export type Evaluation = {
  readonly verdict: "PROCEED" | "BLOCKED";
  readonly reasons: readonly string[];
};

export function evaluateEvidence(
  evidence: EvidenceBundle,
  currentSourceHash: string,
  currentCorpusHash: string,
): Evaluation;
