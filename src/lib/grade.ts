import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GradePreset, GradeStats } from "../types/index.js";
import { ValidationError } from "./errors.js";
import { probeDuration, runCommand } from "./ffmpeg.js";

export const PRESETS: Record<GradePreset, string> = {
  subtle: "eq=contrast=1.03:saturation=0.98",
  neutral_punch:
    "eq=contrast=1.06:brightness=0.0:saturation=1.0,curves=master='0/0 0.25/0.23 0.75/0.77 1/1'",
  warm_cinematic:
    "eq=contrast=1.12:brightness=-0.02:saturation=0.88," +
    "colorbalance=rs=0.02:gs=0.0:bs=-0.03:rm=0.04:gm=0.01:bm=-0.02:rh=0.08:gh=0.02:bh=-0.05," +
    "curves=master='0/0 0.25/0.22 0.75/0.78 1/1'",
  none: "",
};

export function getPreset(name: GradePreset): string {
  if (!(name in PRESETS)) {
    throw new ValidationError(
      `unknown preset '${name}'. Available: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return PRESETS[name];
}

function parseMetadataValue(line: string): number | undefined {
  const raw = line.split("=").pop();
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function sampleFrameStats(
  videoPath: string,
  start: number,
  duration: number,
  nSamples = 10,
): GradeStats {
  const fps = Math.max(0.5, Math.min(nSamples / Math.max(duration, 0.1), 10));
  const tempDir = mkdtempSync(join(tmpdir(), "video-use-grade-"));
  const metadataPath = join(tempDir, "stats.txt");

  try {
    runCommand(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-nostats",
        "-ss", start.toFixed(3),
        "-i", videoPath,
        "-t", duration.toFixed(3),
        "-vf", `fps=${fps.toFixed(2)},signalstats,metadata=print:file=${metadataPath}`,
        "-f", "null", "-",
      ],
      { quiet: true },
    );

    const lines = readFileSync(metadataPath, "utf8").split("\n");
    const yAvgs: number[] = [];
    const yMins: number[] = [];
    const yMaxs: number[] = [];
    const satAvgs: number[] = [];
    let bitDepth = 8;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("lavfi.signalstats.YBITDEPTH")) {
        const value = parseMetadataValue(trimmed);
        if (value !== undefined) bitDepth = Math.trunc(value);
      } else if (trimmed.includes("lavfi.signalstats.YAVG")) {
        const value = parseMetadataValue(trimmed);
        if (value !== undefined) yAvgs.push(value);
      } else if (trimmed.includes("lavfi.signalstats.YMIN")) {
        const value = parseMetadataValue(trimmed);
        if (value !== undefined) yMins.push(value);
      } else if (trimmed.includes("lavfi.signalstats.YMAX")) {
        const value = parseMetadataValue(trimmed);
        if (value !== undefined) yMaxs.push(value);
      } else if (trimmed.includes("lavfi.signalstats.SATAVG")) {
        const value = parseMetadataValue(trimmed);
        if (value !== undefined) satAvgs.push(value);
      }
    }

    if (yAvgs.length === 0) {
      return { y_mean: 0.5, y_std: 0.18, sat_mean: 0.25 };
    }

    const maxVal = 2 ** bitDepth - 1;
    const yMean = yAvgs.reduce((a, b) => a + b, 0) / yAvgs.length / maxVal;
    const yRange =
      yMaxs.length > 0 && yMins.length > 0
        ? (yMaxs.reduce((a, b) => a + b, 0) / yMaxs.length -
            yMins.reduce((a, b) => a + b, 0) / yMins.length) / maxVal
        : 0.7;
    const satMean =
      satAvgs.length > 0
        ? satAvgs.reduce((a, b) => a + b, 0) / satAvgs.length / maxVal
        : 0.25;

    return { y_mean: yMean, y_std: yRange / 4, sat_mean: satMean };
  } catch {
    return { y_mean: 0.5, y_std: 0.18, sat_mean: 0.25 };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function autoGradeForClip(
  videoPath: string,
  start = 0,
  duration?: number,
): { filter: string; stats: GradeStats } {
  const clipDuration = duration ?? probeDuration(videoPath);
  const stats = sampleFrameStats(videoPath, start, clipDuration);

  const yMean = stats.y_mean;
  const yRange = stats.y_std * 4;
  const satMean = stats.sat_mean;

  let contrastAdj = 1.03;
  if (yRange < 0.65) {
    const t = Math.max(0, Math.min(1, (yRange - 0.5) / 0.15));
    contrastAdj = 1.08 - 0.05 * t;
  }

  let gammaAdj = 1.0;
  if (yMean < 0.42) {
    const t = Math.max(0, Math.min(1, (yMean - 0.3) / 0.12));
    gammaAdj = 1.1 - 0.08 * t;
  } else if (yMean > 0.6) {
    gammaAdj = 0.97;
  }

  let satAdj = 0.98;
  if (satMean < 0.18) satAdj = 1.04;
  else if (satMean > 0.38) satAdj = 0.96;

  contrastAdj = Math.max(0.94, Math.min(1.08, contrastAdj));
  gammaAdj = Math.max(0.94, Math.min(1.1, gammaAdj));
  satAdj = Math.max(0.94, Math.min(1.06, satAdj));

  const eqParts: string[] = [];
  if (Math.abs(contrastAdj - 1) > 0.005) eqParts.push(`contrast=${contrastAdj.toFixed(3)}`);
  if (Math.abs(gammaAdj - 1) > 0.005) eqParts.push(`gamma=${gammaAdj.toFixed(3)}`);
  if (Math.abs(satAdj - 1) > 0.005) eqParts.push(`saturation=${satAdj.toFixed(3)}`);

  return { filter: eqParts.length > 0 ? `eq=${eqParts.join(":")}` : "", stats };
}

export function applyGrade(inputPath: string, outputPath: string, filterString: string): void {
  if (!filterString) {
    runCommand("ffmpeg", ["-y", "-i", inputPath, "-c", "copy", outputPath], { quiet: true });
    return;
  }
  runCommand(
    "ffmpeg",
    [
      "-y", "-i", inputPath, "-vf", filterString,
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
      outputPath,
    ],
    { quiet: true },
  );
}

export function resolveGradeFilter(options: {
  preset?: GradePreset | undefined;
  filter?: string | undefined;
  input?: string | undefined;
}): string {
  if (options.filter !== undefined) return options.filter;
  if (options.preset !== undefined) return getPreset(options.preset);
  if (options.input) return autoGradeForClip(options.input).filter;
  return "";
}
