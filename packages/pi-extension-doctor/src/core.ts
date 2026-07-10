import type {
  Confidence,
  Corpus,
  ExpectedFinding,
  Finding,
  PackageAnalysis,
  PackageFixture,
  PackageManifest,
  RuleId,
} from "./types.ts";

const RULES: readonly RuleId[] = [
  "duplicate-command",
  "suffixed-command-id",
  "stale-mariozechner-import",
  "duplicate-manifest-entry",
  "tool-override-candidate",
  "ui-owner-registration",
  "missing-cleanup",
  "invalid-extension-path",
  "unsafe-file",
  "unsupported-encoding",
  "scan-budget-exceeded",
  "scan-deadline-exceeded",
  "manifest-invalid",
];
const CONFIDENCE: readonly Confidence[] = ["confirmed", "inferred", "unknown"];

function isRuleId(value: string): value is RuleId {
  return RULES.some((rule) => rule === value);
}

function isConfidence(value: string): value is Confidence {
  return CONFIDENCE.some((confidence) => confidence === value);
}
const IMPORT_PATTERN =
  /(?:import\s+(?:[^"']+\s+from\s+)?|export\s+[^"']+\s+from\s+|require\s*\()\s*["']@mariozechner\/pi-[^"']+["']/;
const COMMAND_PATTERN = /\.registerCommand\s*\(\s*["']([^"']+)["']/g;
const SUFFIX_PATTERN = /([._-](?:copy|\d+))$/i;
const UI_OWNER_PATTERN =
  /\.ui\.set(?:Footer|Header|EditorComponent|Widget)\s*\(/;
const TOOL_PATTERN = /\.registerTool\s*\(/;

type CommandRegistration = {
  readonly name: string;
  readonly location: string;
  readonly line: number;
};

type JsonRecord = {
  readonly [key: string]: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly pi?: unknown;
  readonly extensions?: unknown;
  readonly rule?: unknown;
  readonly confidence?: unknown;
  readonly location?: unknown;
  readonly id?: unknown;
  readonly files?: unknown;
  readonly manifest?: unknown;
  readonly expected?: unknown;
  readonly packages?: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCorpus(): never {
  throw new Error("Invalid corpus");
}

function parseStringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  )
    invalidCorpus();
  return value;
}

function parseManifest(value: unknown): PackageManifest {
  if (!isRecord(value) || typeof value.name !== "string") invalidCorpus();
  const version = value.version;
  if (version !== undefined && typeof version !== "string") invalidCorpus();
  const piValue = value.pi;
  let pi: PackageManifest["pi"];
  if (piValue !== undefined) {
    if (!isRecord(piValue)) invalidCorpus();
    const extensionValue = piValue.extensions;
    pi =
      extensionValue === undefined
        ? {}
        : { extensions: parseStringArray(extensionValue) };
  }
  return {
    name: value.name,
    ...(version === undefined ? {} : { version }),
    ...(pi === undefined ? {} : { pi }),
  };
}

function parseExpected(value: unknown): readonly ExpectedFinding[] {
  if (!Array.isArray(value)) invalidCorpus();
  return value.map((entry) => {
    if (!isRecord(entry)) invalidCorpus();
    const rule = entry.rule;
    const confidence = entry.confidence;
    const location = entry.location;
    if (
      typeof rule !== "string" ||
      !isRuleId(rule) ||
      typeof confidence !== "string" ||
      !isConfidence(confidence) ||
      typeof location !== "string"
    ) {
      invalidCorpus();
    }
    return { rule, confidence, location };
  });
}

function parseFixture(value: unknown): PackageFixture {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isRecord(value.files)
  )
    invalidCorpus();
  const files: Record<string, string> = {};
  for (const [path, source] of Object.entries(value.files)) {
    if (typeof source !== "string") invalidCorpus();
    files[path] = source;
  }
  return {
    id: value.id,
    manifest: parseManifest(value.manifest),
    files,
    expected: parseExpected(value.expected),
  };
}

export function parseCorpus(input: unknown): Corpus {
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.packages))
    invalidCorpus();
  return { version: 1, packages: input.packages.map(parseFixture) };
}

function validEntryPath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > 512 || path.includes("\0"))
    return false;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(path)
  )
    return false;
  return !path.replaceAll("\\", "/").split("/").includes("..");
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function finding(
  packageId: string,
  rule: RuleId,
  confidence: Confidence,
  location: string,
  line?: number,
): Finding {
  return {
    rule,
    confidence,
    packageId,
    location,
    ...(line === undefined ? {} : { line }),
  };
}

function analyzeFixture(fixture: PackageFixture): {
  readonly findings: Finding[];
  readonly commands: readonly CommandRegistration[];
} {
  const findings: Finding[] = [];
  const entries = fixture.manifest.pi?.extensions ?? [];
  const seenEntries = new Set<string>();
  for (const entry of entries) {
    if (!validEntryPath(entry)) {
      findings.push(
        finding(
          fixture.id,
          "invalid-extension-path",
          "unknown",
          "package.json",
        ),
      );
      continue;
    }
    if (seenEntries.has(entry)) {
      findings.push(
        finding(
          fixture.id,
          "duplicate-manifest-entry",
          "inferred",
          "package.json",
        ),
      );
    }
    seenEntries.add(entry);
  }

  const commands: CommandRegistration[] = [];
  for (const entry of entries) {
    const source = fixture.files[entry];
    if (source === undefined) continue;
    const importIndex = source.search(IMPORT_PATTERN);
    if (importIndex >= 0) {
      findings.push(
        finding(
          fixture.id,
          "stale-mariozechner-import",
          "inferred",
          entry,
          lineAt(source, importIndex),
        ),
      );
    }
    for (const match of source.matchAll(COMMAND_PATTERN)) {
      const command = match[1];
      if (command === undefined || match.index === undefined) continue;
      commands.push({
        name: command,
        location: entry,
        line: lineAt(source, match.index),
      });
    }
    const uiIndex = source.search(UI_OWNER_PATTERN);
    if (uiIndex >= 0)
      findings.push(
        finding(
          fixture.id,
          "ui-owner-registration",
          "inferred",
          entry,
          lineAt(source, uiIndex),
        ),
      );
    const toolIndex = source.search(TOOL_PATTERN);
    if (toolIndex >= 0)
      findings.push(
        finding(
          fixture.id,
          "tool-override-candidate",
          "inferred",
          entry,
          lineAt(source, toolIndex),
        ),
      );
    const setupIndex = source.search(/\bsetInterval\s*\(/);
    if (setupIndex >= 0 && !/session_shutdown|clearInterval/.test(source)) {
      findings.push(
        finding(
          fixture.id,
          "missing-cleanup",
          "inferred",
          entry,
          lineAt(source, setupIndex),
        ),
      );
    }
  }
  return { findings, commands };
}

export function analyzeCorpus(
  fixtures: readonly PackageFixture[],
): readonly PackageAnalysis[] {
  const analyses = fixtures.map((fixture) => analyzeFixture(fixture));
  const owners = new Map<string, number[]>();
  analyses.forEach((analysis, index) => {
    for (const command of new Set(analysis.commands.map(({ name }) => name))) {
      const current = owners.get(command) ?? [];
      current.push(index);
      owners.set(command, current);
    }
  });

  const duplicateCommands = new Map<number, string[]>();
  for (const [command, indexes] of owners) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const current = duplicateCommands.get(index) ?? [];
      current.push(command);
      duplicateCommands.set(index, current);
    }
  }
  const commandNames = new Set(owners.keys());

  return fixtures.map((fixture, index) => {
    const analysis = analyses[index];
    if (!analysis) invalidCorpus();
    const registrationFor = (command: string) =>
      analysis.commands.find(({ name }) => name === command);
    const duplicateFindings = (duplicateCommands.get(index) ?? []).map(
      (command) =>
        finding(
          fixture.id,
          "duplicate-command",
          "inferred",
          registrationFor(command)?.location ?? "package.json",
          registrationFor(command)?.line,
        ),
    );
    const suffixFindings = analysis.commands.flatMap((command) => {
      const suffix = SUFFIX_PATTERN.exec(command.name)?.[1];
      if (!suffix || !commandNames.has(command.name.slice(0, -suffix.length)))
        return [];
      return [
        finding(
          fixture.id,
          "suffixed-command-id",
          "inferred",
          command.location,
          command.line,
        ),
      ];
    });
    return {
      packageId: fixture.id,
      findings: [...analysis.findings, ...duplicateFindings, ...suffixFindings],
    };
  });
}
