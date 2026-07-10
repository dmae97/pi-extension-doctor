import { isAbsolute, win32 } from "node:path";
import type { DoctorReport, Finding } from "./types.ts";

const BIDI_CONTROLS = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069,
]);

function escapedCodePoint(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`;
}

export function escapeUntrusted(value: string, maxCodePoints = 214): string {
  const output: string[] = [];
  let count = 0;
  for (const character of value) {
    if (count >= maxCodePoints) {
      output.push("…");
      break;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      BIDI_CONTROLS.has(codePoint)
    ) {
      output.push(escapedCodePoint(codePoint));
    } else {
      output.push(character);
    }
    count += 1;
  }
  return output.join("");
}

function safeLocation(location: string): string {
  if (
    isAbsolute(location) ||
    win32.isAbsolute(location) ||
    location.replaceAll("\\", "/").split("/").includes("..")
  ) {
    return "redacted-path";
  }
  return escapeUntrusted(location, 512);
}

function publicFinding(finding: Finding) {
  return {
    rule: finding.rule,
    confidence: finding.confidence,
    packageId: escapeUntrusted(finding.packageId),
    location: safeLocation(finding.location),
    ...(finding.line === undefined ? {} : { line: finding.line }),
  };
}

function bounded(line: string, width: number): string {
  if (line.length <= width) return line;
  if (width <= 1) return "…".slice(0, width);
  return `${line.slice(0, width - 1)}…`;
}

export function renderText(report: DoctorReport, width: number): string {
  const safeWidth = Math.max(20, Math.min(width, 240));
  const header = `extension-doctor ${report.status} findings=${report.findings.length} scanned=${report.scannedFiles}`;
  const lines = [bounded(header, safeWidth)];
  for (const finding of report.findings) {
    const item = publicFinding(finding);
    lines.push(
      bounded(
        `[${item.confidence}] ${item.rule} ${item.packageId} ${item.location}${item.line === undefined ? "" : `:${item.line}`}`,
        safeWidth,
      ),
    );
  }
  return lines.join("\n");
}

export function renderJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      status: report.status,
      truncated: report.truncated,
      scannedFiles: report.scannedFiles,
      findings: report.findings.map(publicFinding),
    },
    null,
    2,
  );
}
