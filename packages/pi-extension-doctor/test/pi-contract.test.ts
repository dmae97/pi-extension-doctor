import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type CommandInfo,
  FakePi,
  type SourceInfo,
} from "../../../tooling/fixtures/fake-pi.ts";
import extension, {
  collectRuntimeFindings,
  registerDoctor,
} from "../src/index.ts";

const source = (name: string): SourceInfo => ({
  path: `${name}/index.ts`,
  source: name,
  scope: "user",
  origin: "package",
  baseDir: `/fixtures/${name}`,
});

const command = (name: string, packageName: string): CommandInfo => ({
  name,
  source: "extension",
  sourceInfo: source(packageName),
});

describe("Pi extension contract", () => {
  it("exports a factory typed for the public Pi API", () => {
    const factory: (pi: ExtensionAPI) => void = extension;
    expect(factory).toBeTypeOf("function");
  });

  it("registers one command with the public Pi signature", () => {
    const pi = new FakePi();

    registerDoctor(pi);

    expect(pi.registeredCommands.map(({ name }) => name)).toEqual([
      "extension-doctor",
    ]);
  });

  it("confirms duplicate runtime commands without inventing tool history", () => {
    const pi = new FakePi(
      [command("shared", "one"), command("shared", "two")],
      [{ name: "read", sourceInfo: source("tools") }],
      ["read"],
    );

    const findings = collectRuntimeFindings(pi);

    expect(
      findings.filter((finding) => finding.rule === "duplicate-command"),
    ).toHaveLength(2);
    expect(
      findings.every((finding) => finding.confidence === "confirmed"),
    ).toBe(true);
    expect(
      findings.some((finding) => finding.rule === "tool-override-candidate"),
    ).toBe(false);
  });

  it("recognizes Pi-normalized duplicate invocation names", () => {
    const pi = new FakePi([
      command("shared:1", "one"),
      command("shared:2", "two"),
      command("archive:1", "archive"),
    ]);

    const findings = collectRuntimeFindings(pi);

    const duplicates = findings.filter(
      (finding) => finding.rule === "duplicate-command",
    );
    expect(duplicates.map((finding) => finding.packageId)).toEqual([
      "one",
      "two",
    ]);
    expect(
      duplicates.every((finding) => finding.confidence === "inferred"),
    ).toBe(true);
    expect(findings.some((finding) => finding.packageId === "archive")).toBe(
      false,
    );
  });

  it("does not expose an absolute runtime source as a package id", () => {
    const localSource: SourceInfo = {
      ...source("local"),
      source: "/home/alice/private-extension",
    };
    const pi = new FakePi([
      { name: "shared:1", source: "extension", sourceInfo: localSource },
      command("shared:2", "public-package"),
    ]);

    const findings = collectRuntimeFindings(pi);

    expect(findings[0]?.packageId).toBe("runtime-extension");
    expect(JSON.stringify(findings)).not.toContain("/home/alice");
  });

  it("renders a report when the command is invoked", async () => {
    const pi = new FakePi([command("shared", "one"), command("shared", "two")]);
    registerDoctor(pi);

    await pi.invoke("extension-doctor", "--json");

    expect(pi.notifications).toHaveLength(1);
    expect(pi.notifications[0]).toContain('"duplicate-command"');
  });
});
