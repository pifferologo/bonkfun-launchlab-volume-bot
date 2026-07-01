import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FfmpegError } from "./errors.js";

export interface RunCommandOptions {
  quiet?: boolean | undefined;
  capture?: boolean | undefined;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Run a subprocess and throw FfmpegError on non-zero exit. */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): RunCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : options.quiet ? "ignore" : "inherit",
  });

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const status = result.status ?? 1;

  if (status !== 0) {
    throw new FfmpegError(
      `${command} failed with exit code ${status}`,
      stderr,
    );
  }

  return { stdout, stderr, status };
}

/** Extract mono 16 kHz PCM audio from a video file. */
export function extractAudio(videoPath: string, destPath: string): void {
  runCommand(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", destPath],
    { quiet: true },
  );
}

/** Probe video duration in seconds. */
export function probeDuration(videoPath: string): number {
  const { stdout } = runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { capture: true, quiet: true },
  );
  const parsed = Number.parseFloat(stdout.trim());
  return Number.isFinite(parsed) ? parsed : 10;
}

/** Return true when the source uses PQ or HLG HDR transfer. */
export function isHdrSource(videoPath: string): boolean {
  try {
    const { stdout } = runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=color_transfer",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { capture: true, quiet: true },
    );
    const transfer = stdout.trim();
    return transfer === "smpte2084" || transfer === "arib-std-b67";
  } catch {
    return false;
  }
}

/** Return true when video height exceeds width (portrait). */
export function isPortraitSource(videoPath: string): boolean {
  try {
    const { stdout } = runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        videoPath,
      ],
      { capture: true, quiet: true },
    );
    const [widthRaw, heightRaw] = stdout.trim().split(",");
    const width = Number.parseInt(widthRaw ?? "0", 10);
    const height = Number.parseInt(heightRaw ?? "0", 10);
    return height > width;
  } catch {
    return false;
  }
}

/** Extract a single JPEG frame at the given timestamp. */
export function extractFrame(
  videoPath: string,
  timestamp: number,
  outputPath: string,
): void {
  runCommand(
    "ffmpeg",
    [
      "-y",
      "-ss",
      timestamp.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "-vf",
      "scale=320:-2",
      outputPath,
    ],
    { quiet: true },
  );
}

/** Extract audio segment and return normalized RMS envelope samples. */
export function computeAudioEnvelope(
  videoPath: string,
  start: number,
  end: number,
  samples = 2000,
): Float32Array {
  const tempDir = mkdtempSync(join(tmpdir(), "video-use-"));
  const wavPath = join(tempDir, "segment.wav");

  try {
    const duration = end - start;
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        start.toFixed(3),
        "-i",
        videoPath,
        "-t",
        duration.toFixed(3),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { stdio: "ignore" },
    );

    if (result.status !== 0) {
      return new Float32Array(samples);
    }

    const buffer = readFileSync(wavPath);
    if (buffer.length <= 44) {
      return new Float32Array(samples);
    }

    const pcm = new Int16Array(
      buffer.buffer,
      buffer.byteOffset + 44,
      (buffer.length - 44) / 2,
    );
    if (pcm.length === 0) {
      return new Float32Array(samples);
    }

    const floats = Float32Array.from(pcm, (v) => v / 32768);
    const window = Math.max(1, Math.floor(floats.length / samples));
    const usable = Math.floor(floats.length / window) * window;
    const envelope = new Float32Array(samples);
    let max = 0;

    for (let i = 0; i < usable / window; i++) {
      let sum = 0;
      for (let j = 0; j < window; j++) {
        const value = floats[i * window + j] ?? 0;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / window);
      envelope[i] = rms;
      if (rms > max) {
        max = rms;
      }
    }

    if (max > 0) {
      for (let i = 0; i < envelope.length; i++) {
        envelope[i] = (envelope[i] ?? 0) / max;
      }
    }

    return envelope;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Write a concat demuxer list file for ffmpeg. */
export function writeConcatList(segmentPaths: string[], listPath: string): void {
  const content = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, `${content}\n`, "utf8");
}
