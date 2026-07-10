import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderJson, renderText } from "./render.ts";
import { scanPackageRoots } from "./scan.ts";
import type { DoctorReport, Finding } from "./types.ts";

export type RuntimeSourceInfo = {
  readonly path: string;
  readonly source: string;
  readonly baseDir?: string;
};

export interface RuntimeInventory {
  getCommands(): readonly {
    readonly name: string;
    readonly sourceInfo: RuntimeSourceInfo;
  }[];
  getAllTools(): readonly {
    readonly name: string;
    readonly sourceInfo: RuntimeSourceInfo;
  }[];
  getActiveTools(): readonly string[];
}

export type DoctorCommandContext = {
  readonly cwd: string;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
};

export interface DoctorPiApi extends RuntimeInventory {
  registerCommand(
    name: string,
    options: {
      readonly description?: string;
      readonly handler: (
        args: string,
        context: DoctorCommandContext,
      ) => Promise<void>;
    },
  ): void;
}

function runtimeLocation(sourceInfo: RuntimeSourceInfo): string {
  if (!sourceInfo.baseDir) return "runtime";
  const path = relative(sourceInfo.baseDir, sourceInfo.path);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  )
    return "runtime";
  return path;
}

const PACKAGE_NAME =
  /^(?:@[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*|[a-z\d][a-z\d._-]*)$/i;

function runtimePackageId(source: string): string {
  return Buffer.byteLength(source) <= 214 && PACKAGE_NAME.test(source)
    ? source
    : "runtime-extension";
}

function runtimeFinding(
  sourceInfo: RuntimeSourceInfo,
  rule: Finding["rule"],
  confidence: Finding["confidence"] = "confirmed",
): Finding {
  return {
    rule,
    confidence,
    packageId: runtimePackageId(sourceInfo.source),
    location: runtimeLocation(sourceInfo),
  };
}

function normalizedDuplicateCommands<T extends { readonly name: string }>(
  commands: readonly T[],
): ReadonlySet<T> {
  const groups = new Map<
    string,
    { readonly command: T; readonly index: number }[]
  >();
  for (const command of commands) {
    const match = /^(.*):([1-9]\d*)$/.exec(command.name);
    if (!match?.[1] || !match[2]) continue;
    const group = groups.get(match[1]) ?? [];
    group.push({ command, index: Number.parseInt(match[2], 10) });
    groups.set(match[1], group);
  }
  const duplicates = new Set<T>();
  for (const group of groups.values()) {
    const indexes = new Set(group.map(({ index }) => index));
    if (!indexes.has(1) || !indexes.has(2)) continue;
    for (const { command } of group) duplicates.add(command);
  }
  return duplicates;
}

export function collectRuntimeFindings(
  pi: RuntimeInventory,
): readonly Finding[] {
  const commands = pi.getCommands();
  const counts = new Map<string, number>();
  for (const command of commands)
    counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const normalizedDuplicates = normalizedDuplicateCommands(commands);

  const findings: Finding[] = [];
  for (const command of commands) {
    if ((counts.get(command.name) ?? 0) > 1) {
      findings.push(runtimeFinding(command.sourceInfo, "duplicate-command"));
    } else if (normalizedDuplicates.has(command)) {
      findings.push(
        runtimeFinding(command.sourceInfo, "duplicate-command", "inferred"),
      );
    }
    const suffix = /([._:-](?:copy|\d+))$/i.exec(command.name)?.[1];
    if (suffix && counts.has(command.name.slice(0, -suffix.length))) {
      findings.push(runtimeFinding(command.sourceInfo, "suffixed-command-id"));
    }
  }
  return findings;
}

function packageRoots(pi: RuntimeInventory): readonly string[] {
  const roots = new Set<string>();
  for (const item of [...pi.getCommands(), ...pi.getAllTools()]) {
    if (item.sourceInfo.baseDir) roots.add(item.sourceInfo.baseDir);
  }
  return [...roots];
}

function mergeReport(
  runtime: readonly Finding[],
  staticReport: DoctorReport,
): DoctorReport {
  const findings = [...runtime, ...staticReport.findings];
  const status =
    staticReport.status === "unknown"
      ? "unknown"
      : findings.length > 0
        ? "findings"
        : "clean";
  return { ...staticReport, status, findings };
}

function createHandler(pi: RuntimeInventory) {
  return async (args: string, context: DoctorCommandContext): Promise<void> => {
    const runtime = collectRuntimeFindings(pi);
    const staticReport = await scanPackageRoots(packageRoots(pi));
    const report = mergeReport(runtime, staticReport);
    const output =
      args.trim() === "--json" ? renderJson(report) : renderText(report, 80);
    context.ui.notify(output, report.status === "clean" ? "info" : "warning");
  };
}

export function registerDoctor(pi: DoctorPiApi): void {
  pi.registerCommand("extension-doctor", {
    description:
      "Diagnose extension conflicts and stale Pi APIs without executing inspected source",
    handler: createHandler(pi),
  });
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("extension-doctor", {
    description:
      "Diagnose extension conflicts and stale Pi APIs without executing inspected source",
    handler: createHandler(pi),
  });
}
