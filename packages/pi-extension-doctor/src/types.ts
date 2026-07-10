export type Confidence = "confirmed" | "inferred" | "unknown";

export type RuleId =
  | "duplicate-command"
  | "suffixed-command-id"
  | "stale-mariozechner-import"
  | "duplicate-manifest-entry"
  | "tool-override-candidate"
  | "ui-owner-registration"
  | "missing-cleanup"
  | "invalid-extension-path"
  | "unsafe-file"
  | "unsupported-encoding"
  | "scan-budget-exceeded"
  | "scan-deadline-exceeded"
  | "manifest-invalid";

export type Finding = {
  readonly rule: RuleId;
  readonly confidence: Confidence;
  readonly packageId: string;
  readonly location: string;
  readonly line?: number;
  readonly message?: string;
};

export type ExpectedFinding = Pick<Finding, "rule" | "confidence" | "location">;

export type PackageManifest = {
  readonly name: string;
  readonly version?: string;
  readonly pi?: {
    readonly extensions?: readonly string[];
  };
};

export type PackageFixture = {
  readonly id: string;
  readonly manifest: PackageManifest;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: readonly ExpectedFinding[];
};

export type Corpus = {
  readonly version: 1;
  readonly packages: readonly PackageFixture[];
};

export type PackageAnalysis = {
  readonly packageId: string;
  readonly findings: readonly Finding[];
};

export type DoctorStatus = "clean" | "findings" | "unknown";

export type DoctorReport = {
  readonly status: DoctorStatus;
  readonly findings: readonly Finding[];
  readonly scannedFiles: number;
  readonly truncated: boolean;
  readonly openedPaths: readonly string[];
};

export type ScanBudget = {
  readonly maxRoots: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
  readonly deadlineMs: number;
};

export type ScanBudgetOverride = Partial<ScanBudget>;
