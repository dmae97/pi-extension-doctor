import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { analyzeCorpus, parseCorpus } from "./core.ts";
import type {
  DoctorReport,
  Finding,
  PackageFixture,
  PackageManifest,
  ScanBudget,
  ScanBudgetOverride,
} from "./types.ts";

const DEFAULT_BUDGET: ScanBudget = {
  maxRoots: 64,
  maxFiles: 128,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 4,
  deadlineMs: 2_000,
};
const PACKAGE_NAME =
  /^(?:@[a-z\d][a-z\d._-]*\/[a-z\d][a-z\d._-]*|[a-z\d][a-z\d._-]*)$/i;

type ReadState = {
  readonly startedAt: number;
  readonly budget: ScanBudget;
  files: number;
  bytes: number;
  truncated: boolean;
};

type SecureRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "budget" | "deadline" | "unsafe" | "encoding" };

function budgetWith(overrides: ScanBudgetOverride): ScanBudget {
  return { ...DEFAULT_BUDGET, ...overrides };
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function validRelativePath(path: string, maxDepth: number): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > 512 || path.includes("\0"))
    return false;
  if (isAbsolute(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return false;
  const segments = path.replaceAll("\\", "/").split("/");
  return (
    !segments.includes("..") &&
    segments.filter((segment) => segment !== ".").length <= maxDepth
  );
}

async function secureRead(
  root: string,
  path: string,
  state: ReadState,
): Promise<SecureRead> {
  if (Date.now() - state.startedAt >= state.budget.deadlineMs)
    return { kind: "deadline" };
  if (!validRelativePath(path, state.budget.maxDepth))
    return { kind: "unsafe" };
  if (
    state.files >= state.budget.maxFiles ||
    state.bytes >= state.budget.maxTotalBytes
  ) {
    state.truncated = true;
    return { kind: "budget" };
  }

  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, path);
  const beforeLink = await lstat(candidate);
  if (beforeLink.isSymbolicLink() || !beforeLink.isFile())
    return { kind: "unsafe" };
  const canonical = await realpath(candidate);
  if (!contained(rootPath, canonical)) return { kind: "unsafe" };
  if (
    beforeLink.size > state.budget.maxFileBytes ||
    state.bytes + beforeLink.size > state.budget.maxTotalBytes
  ) {
    state.truncated = true;
    return { kind: "budget" };
  }

  state.files += 1;
  state.bytes += beforeLink.size;
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "unsafe" };
    const buffer = Buffer.alloc(
      Math.min(state.budget.maxFileBytes, before.size) + 1,
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytesRead > state.budget.maxFileBytes
    ) {
      return { kind: "unsafe" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    } catch (error) {
      if (error instanceof TypeError) return { kind: "encoding" };
      throw error;
    }
    if (
      text.startsWith("\uFEFF") ||
      text.includes("\uFFFD") ||
      text.includes("\0")
    )
      return { kind: "encoding" };
    return { kind: "ok", text };
  } finally {
    await handle.close();
  }
}

function safePackageId(value: unknown): string {
  return typeof value === "string" &&
    Buffer.byteLength(value) <= 214 &&
    PACKAGE_NAME.test(value)
    ? value
    : "invalid-package";
}

function unknownFinding(
  packageId: string,
  read: Exclude<SecureRead, { readonly kind: "ok" }>,
): Finding {
  switch (read.kind) {
    case "budget":
      return {
        rule: "scan-budget-exceeded",
        confidence: "unknown",
        packageId,
        location: "package.json",
      };
    case "deadline":
      return {
        rule: "scan-deadline-exceeded",
        confidence: "unknown",
        packageId,
        location: "package.json",
      };
    case "encoding":
      return {
        rule: "unsupported-encoding",
        confidence: "unknown",
        packageId,
        location: "package.json",
      };
    case "unsafe":
      return {
        rule: "unsafe-file",
        confidence: "unknown",
        packageId,
        location: "package.json",
      };
  }
}

function manifestName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("name" in value))
    return undefined;
  return value.name;
}

function manifestFrom(text: string): {
  readonly manifest?: PackageManifest;
  readonly id: string;
} {
  try {
    const parsed: unknown = JSON.parse(text);
    const corpus = parseCorpus({
      version: 1,
      packages: [
        {
          id: safePackageId(manifestName(parsed)),
          manifest: parsed,
          files: {},
          expected: [],
        },
      ],
    });
    const fixture = corpus.packages[0];
    return fixture
      ? { manifest: fixture.manifest, id: fixture.id }
      : { id: "invalid-package" };
  } catch (error) {
    if (error instanceof Error) return { id: "invalid-package" };
    throw error;
  }
}

export async function scanPackageRoots(
  roots: readonly string[],
  overrides: ScanBudgetOverride = {},
): Promise<DoctorReport> {
  const budget = budgetWith(overrides);
  const state: ReadState = {
    startedAt: Date.now(),
    budget,
    files: 0,
    bytes: 0,
    truncated: roots.length > budget.maxRoots,
  };
  const fixtures: PackageFixture[] = [];
  const unknown: Finding[] = [];
  const openedPaths: string[] = [];

  for (const root of roots.slice(0, budget.maxRoots)) {
    let manifestRead: SecureRead;
    try {
      const rootInfo = await lstat(root);
      manifestRead =
        rootInfo.isDirectory() && !rootInfo.isSymbolicLink()
          ? await secureRead(root, "package.json", state)
          : { kind: "unsafe" };
    } catch (error) {
      if (error instanceof Error) manifestRead = { kind: "unsafe" };
      else throw error;
    }
    if (manifestRead.kind !== "ok") {
      unknown.push(unknownFinding("invalid-package", manifestRead));
      continue;
    }
    openedPaths.push("package.json");
    const parsed = manifestFrom(manifestRead.text);
    if (!parsed.manifest) {
      unknown.push({
        rule: "manifest-invalid",
        confidence: "unknown",
        packageId: parsed.id,
        location: "package.json",
      });
      continue;
    }

    const files: Record<string, string> = {};
    for (const entry of parsed.manifest.pi?.extensions ?? []) {
      let read: SecureRead;
      try {
        read = await secureRead(root, entry, state);
      } catch (error) {
        if (error instanceof Error) read = { kind: "unsafe" };
        else throw error;
      }
      if (read.kind === "ok") {
        files[entry] = read.text;
        openedPaths.push(entry);
      } else {
        unknown.push({
          ...unknownFinding(parsed.id, read),
          location: validRelativePath(entry, budget.maxDepth)
            ? entry
            : "package.json",
        });
      }
    }
    fixtures.push({
      id: parsed.id,
      manifest: parsed.manifest,
      files,
      expected: [],
    });
  }

  if (roots.length > budget.maxRoots) {
    unknown.push({
      rule: "scan-budget-exceeded",
      confidence: "unknown",
      packageId: "scan",
      location: "package.json",
    });
  }
  const findings = [
    ...analyzeCorpus(fixtures).flatMap((analysis) => analysis.findings),
    ...unknown,
  ];
  const hasUnknown =
    state.truncated ||
    findings.some((finding) => finding.confidence === "unknown");
  return {
    status: hasUnknown ? "unknown" : findings.length > 0 ? "findings" : "clean",
    findings,
    scannedFiles: state.files,
    truncated: state.truncated,
    openedPaths,
  };
}
