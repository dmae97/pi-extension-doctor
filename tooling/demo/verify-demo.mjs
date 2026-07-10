#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = join(ROOT, "demos/pi-extension-doctor");
const REQUIRED = [
  "scenario.md",
  "keystrokes.txt",
  "captures/80x24.txt",
  "captures/120x36.txt",
  "assets/demo.mp4",
  "assets/poster.webp",
  "assets/frames.sha256.json",
];
const BIDI = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069,
]);
const ABSOLUTE_PATH =
  /(?:\/(?:home|Users|private|tmp)\/|[A-Za-z]:\\(?:Users|home)\\)/;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

function hasUnsafeControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 0x0a) continue;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      BIDI.has(codePoint)
    )
      return true;
  }
  return false;
}

function checkCapture(path, width, height) {
  const content = readFileSync(path, "utf8");
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  if (lines.length > height || lines.some((line) => [...line].length > width))
    throw new Error(`Capture exceeds ${width}x${height}`);
  if (
    !content.includes("extension-doctor") ||
    !content.includes("duplicate-command")
  )
    throw new Error(`Capture is missing doctor sentinels: ${width}x${height}`);
  if (hasUnsafeControl(content) || ABSOLUTE_PATH.test(content))
    throw new Error(
      `Capture contains unsafe control or path data: ${width}x${height}`,
    );
  return sha256(path);
}

function probe(path) {
  return JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      path,
    ]),
  );
}

function verifyMedia() {
  const videoPath = join(DEMO, "assets/demo.mp4");
  const posterPath = join(DEMO, "assets/poster.webp");
  const video = probe(videoPath);
  const videoStream = video.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  const duration = Number(video.format?.duration);
  if (
    !videoStream ||
    videoStream.codec_name !== "h264" ||
    videoStream.width !== 1200 ||
    videoStream.height !== 720
  )
    throw new Error("MP4 must be 1200x720 H.264");
  if (!Number.isFinite(duration) || duration < 2 || duration > 15)
    throw new Error("MP4 duration must be 2-15 seconds");
  const metadata = JSON.stringify({
    format: video.format?.tags ?? {},
    stream: videoStream.tags ?? {},
  });
  if (/(?:location|comment|description|artist|copyright)/i.test(metadata))
    throw new Error("MP4 contains disallowed metadata");
  const poster = probe(posterPath);
  const posterStream = poster.streams?.find(
    (stream) => stream.codec_type === "video",
  );
  if (
    !posterStream ||
    posterStream.codec_name !== "webp" ||
    posterStream.width !== 1200 ||
    posterStream.height !== 720
  )
    throw new Error("Poster must be 1200x720 WebP");

  const expected = JSON.parse(
    readFileSync(join(DEMO, "assets/frames.sha256.json"), "utf8"),
  );
  const work = mkdtempSync(join(tmpdir(), "pi-doctor-demo-frames-"));
  try {
    const timestamps = [0, duration / 2, Math.max(0, duration - 0.1)];
    const frames = timestamps.map((timestamp, index) => {
      const output = join(work, `frame-${index}.png`);
      run("ffmpeg", [
        "-v",
        "error",
        "-ss",
        timestamp.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-map_metadata",
        "-1",
        output,
      ]);
      return sha256(output);
    });
    if (JSON.stringify(frames) !== JSON.stringify(expected.frames))
      throw new Error("Decoded frame hashes do not match approved media");
    return { duration, frames };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function verifyChecksums() {
  const lines = readFileSync(join(DEMO, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  const expected = new Map(
    lines.map((line) => [line.slice(66), line.slice(0, 64)]),
  );
  for (const file of REQUIRED) {
    if (expected.get(file) !== sha256(join(DEMO, file)))
      throw new Error(`SHA256SUMS mismatch: ${file}`);
  }
  return Object.fromEntries(
    REQUIRED.map((file) => [file, sha256(join(DEMO, file))]),
  );
}

export function verifyDemo() {
  const hashes = verifyChecksums();
  const capture80Sha256 = checkCapture(
    join(DEMO, "captures/80x24.txt"),
    80,
    24,
  );
  const capture120Sha256 = checkCapture(
    join(DEMO, "captures/120x36.txt"),
    120,
    36,
  );
  const frames = JSON.parse(
    readFileSync(join(DEMO, "assets/frames.sha256.json"), "utf8"),
  );
  if (
    frames.capture80Sha256 !== capture80Sha256 ||
    frames.capture120Sha256 !== capture120Sha256
  )
    throw new Error("Media is not bound to approved captures");
  const media = verifyMedia();
  return {
    verdict: "PASS",
    hashes,
    capture80Sha256,
    capture120Sha256,
    frameSha256: media.frames,
    durationSeconds: media.duration,
  };
}

function main() {
  const outputIndex = process.argv.indexOf("--output");
  const checkIndex = process.argv.indexOf("--check");
  const result = verifyDemo();
  if (checkIndex >= 0) {
    const previous = JSON.parse(
      readFileSync(resolve(process.argv[checkIndex + 1]), "utf8"),
    );
    if (JSON.stringify(previous) !== JSON.stringify(result))
      throw new Error("Demo evidence is stale");
  } else if (outputIndex >= 0)
    writeFileSync(
      resolve(process.argv[outputIndex + 1]),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  console.log(`DEMO=${result.verdict}`);
  const requireIndex = process.argv.indexOf("--require");
  if (requireIndex >= 0 && result.verdict !== process.argv[requireIndex + 1])
    process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown demo verification failure",
    );
    process.exitCode = 1;
  }
}
