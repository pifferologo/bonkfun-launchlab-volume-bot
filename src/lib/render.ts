import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { logger } from "../config/logger.js";
import type { Edl, EdlOverlay, RenderOptions, ScribeTranscript, ScribeWord } from "../types/index.js";
import { ValidationError } from "./errors.js";
import {
  isHdrSource,
  isPortraitSource,
  runCommand,
  writeConcatList,
} from "./ffmpeg.js";
import { autoGradeForClip, getPreset } from "./grade.js";

const SUB_FORCE_STYLE =
  "FontName=Helvetica,FontSize=18,Bold=1," +
  "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000," +
  "BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=90";

const TONEMAP_CHAIN =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709," +
  "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

const LOUDNORM_I = -14;
const LOUDNORM_TP = -1;
const LOUDNORM_LRA = 11;
const PUNCT_BREAK = new Set(".,!?;:");

function resolvePath(maybePath: string, base: string): string {
  return isAbsolute(maybePath) ? maybePath : resolve(base, maybePath);
}

function resolveGradeFilter(gradeField: string | undefined): string {
  if (!gradeField) return "";
  if (gradeField === "auto") return "__AUTO__";
  if (/^[a-zA-Z0-9_-]+$/.test(gradeField)) {
    try {
      return getPreset(gradeField as "subtle");
    } catch {
      logger.warn(`unknown preset '${gradeField}', using as raw filter`);
      return gradeField;
    }
  }
  return gradeField;
}

export function extractSegment(
  source: string,
  segStart: number,
  duration: number,
  gradeFilter: string,
  outPath: string,
  preview = false,
  draft = false,
): void {
  const portrait = isPortraitSource(source);
  const scale = draft
    ? portrait
      ? "scale=-2:1280"
      : "scale=1280:-2"
    : portrait
      ? "scale=-2:1920"
      : "scale=1920:-2";

  const vfParts: string[] = [];
  if (isHdrSource(source)) vfParts.push(TONEMAP_CHAIN);
  vfParts.push(scale);
  if (gradeFilter) vfParts.push(gradeFilter);
  const vf = vfParts.join(",");

  const fadeOutStart = Math.max(0, duration - 0.03);
  const af = `afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.03`;

  const [preset, crf] = draft ? ["ultrafast", "28"] : preview ? ["medium", "22"] : ["fast", "20"];

  runCommand(
    "ffmpeg",
    [
      "-y", "-ss", segStart.toFixed(3), "-i", source,
      "-t", duration.toFixed(3), "-vf", vf, "-af", af,
      "-c:v", "libx264", "-preset", preset, "-crf", crf,
      "-pix_fmt", "yuv420p", "-r", "24",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart", outPath,
    ],
    { quiet: true },
  );
}

export function extractAllSegments(
  edl: Edl,
  editDir: string,
  preview: boolean,
  draft = false,
): string[] {
  const resolved = resolveGradeFilter(edl.grade);
  const isAuto = resolved === "__AUTO__";
  const clipsDir = join(
    editDir,
    draft ? "clips_draft" : preview ? "clips_preview" : "clips_graded",
  );

  const segPaths: string[] = [];
  logger.info(`extracting ${edl.ranges.length} segment(s) → ${clipsDir}`);

  for (let i = 0; i < edl.ranges.length; i++) {
    const range = edl.ranges[i];
    if (!range) continue;

    const srcPath = resolvePath(edl.sources[range.source] ?? "", editDir);
    const start = range.start;
    const end = range.end;
    const duration = end - start;
    const outPath = join(clipsDir, `seg_${String(i).padStart(2, "0")}_${range.source}.mp4`);

    const segFilter = isAuto
      ? autoGradeForClip(srcPath, start, duration).filter
      : resolved;

    extractSegment(srcPath, start, duration, segFilter, outPath, preview, draft);
    segPaths.push(outPath);
  }

  return segPaths;
}

export function concatSegments(segmentPaths: string[], outPath: string, editDir: string): void {
  const concatList = join(editDir, "_concat.txt");
  writeConcatList(segmentPaths, concatList);
  runCommand(
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-movflags", "+faststart", outPath],
    { quiet: true },
  );
  unlinkSync(concatList);
}

function srtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function wordsInRange(transcript: ScribeTranscript, tStart: number, tEnd: number): ScribeWord[] {
  return (transcript.words ?? []).filter((w) => {
    if (w.type !== "word") return false;
    const ws = w.start;
    const we = w.end;
    if (ws === undefined || we === undefined) return false;
    return !(we <= tStart || ws >= tEnd);
  });
}

export function buildMasterSrt(edl: Edl, editDir: string, outPath: string): void {
  const transcriptsDir = join(editDir, "transcripts");
  const entries: Array<[number, number, string]> = [];
  let segOffset = 0;

  for (const range of edl.ranges) {
    const segStart = range.start;
    const segEnd = range.end;
    const segDuration = segEnd - segStart;
    const trPath = join(transcriptsDir, `${range.source}.json`);

    if (!existsSync(trPath)) {
      logger.warn(`no transcript for ${range.source}, skipping captions`);
      segOffset += segDuration;
      continue;
    }

    const transcript = JSON.parse(readFileSync(trPath, "utf8")) as ScribeTranscript;
    const wordsInSeg = wordsInRange(transcript, segStart, segEnd);
    const chunks: ScribeWord[][] = [];
    let current: ScribeWord[] = [];

    for (const word of wordsInSeg) {
      const text = (word.text ?? "").trim();
      if (!text) continue;
      current.push(word);
      const endsInPunct = text.at(-1) !== undefined && PUNCT_BREAK.has(text.at(-1) ?? "");
      if (current.length >= 2 || endsInPunct) {
        chunks.push(current);
        current = [];
      }
    }
    if (current.length > 0) chunks.push(current);

    for (const chunk of chunks) {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const localStart = Math.max(segStart, first?.start ?? segStart);
      const localEnd = Math.min(segEnd, last?.end ?? segEnd);
      const outStart = Math.max(0, localStart - segStart) + segOffset;
      let outEnd = Math.max(0, localEnd - segStart) + segOffset;
      if (outEnd <= outStart) outEnd = outStart + 0.4;
      const text = chunk
        .map((w) => (w.text ?? "").trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[,;:]+$/u, "")
        .toUpperCase();
      entries.push([outStart, outEnd, text]);
    }

    segOffset += segDuration;
  }

  entries.sort((a, b) => a[0] - b[0]);
  const lines: string[] = [];
  entries.forEach(([a, b, t], index) => {
    lines.push(String(index + 1));
    lines.push(`${srtTimestamp(a)} --> ${srtTimestamp(b)}`);
    lines.push(t);
    lines.push("");
  });
  writeFileSync(outPath, lines.join("\n"), "utf8");
  logger.info(`master SRT → ${outPath} (${entries.length} cues)`);
}

function measureLoudness(videoPath: string): Record<string, string> | null {
  const filterStr = `loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:print_format=json`;
  const proc = spawnSync(
    "ffmpeg",
    ["-y", "-hide_banner", "-nostats", "-i", videoPath, "-af", filterStr, "-vn", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const stderr = proc.stderr ?? "";
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const data = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const needed = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"];
    if (!needed.every((k) => k in data)) return null;
    return data;
  } catch {
    return null;
  }
}

function applyLoudnormTwoPass(inputPath: string, outputPath: string, preview: boolean): boolean {
  if (preview) {
    const filterStr = `loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}`;
    runCommand(
      "ffmpeg",
      ["-y", "-hide_banner", "-nostats", "-i", inputPath, "-c:v", "copy", "-af", filterStr,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath],
      { quiet: true },
    );
    return true;
  }

  const measurement = measureLoudness(inputPath);
  if (!measurement) {
    return applyLoudnormTwoPass(inputPath, outputPath, true);
  }

  const filterStr =
    `loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}` +
    `:measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}` +
    `:measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}` +
    `:offset=${measurement.target_offset}:linear=true`;

  runCommand(
    "ffmpeg",
    ["-y", "-hide_banner", "-nostats", "-i", inputPath, "-c:v", "copy", "-af", filterStr,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outputPath],
    { quiet: true },
  );
  return true;
}

export function buildFinalComposite(
  basePath: string,
  overlays: EdlOverlay[],
  subtitlesPath: string | null,
  outPath: string,
  editDir: string,
): void {
  const hasOverlays = overlays.length > 0;
  const hasSubs = subtitlesPath !== null;

  if (!hasOverlays && !hasSubs) {
    runCommand("ffmpeg", ["-y", "-i", basePath, "-c", "copy", outPath], { quiet: true });
    return;
  }

  const inputs: string[] = ["-i", basePath];
  for (const ov of overlays) {
    inputs.push("-i", resolvePath(ov.file, editDir));
  }

  const filterParts: string[] = [];
  for (let idx = 0; idx < overlays.length; idx++) {
    const ov = overlays[idx];
    if (!ov) continue;
    const t = ov.start_in_output;
    filterParts.push(`[${idx + 1}:v]setpts=PTS-STARTPTS+${t}/TB[a${idx + 1}]`);
  }

  let current = "[0:v]";
  for (let idx = 0; idx < overlays.length; idx++) {
    const ov = overlays[idx];
    if (!ov) continue;
    const t = ov.start_in_output;
    const end = t + ov.duration;
    const nextLabel = `[v${idx + 1}]`;
    filterParts.push(`${current}[a${idx + 1}]overlay=enable='between(t,${t.toFixed(3)},${end.toFixed(3)})'${nextLabel}`);
    current = nextLabel;
  }

  let outLabel = "[0:v]";
  if (hasSubs && subtitlesPath) {
    const subsAbs = resolve(subtitlesPath).replace(/:/g, "\\:").replace(/'/g, "\\'");
    filterParts.push(`${current}subtitles='${subsAbs}':force_style='${SUB_FORCE_STYLE}'[outv]`);
    outLabel = "[outv]";
  } else if (hasOverlays) {
    filterParts.push(`${current}null[outv]`);
    outLabel = "[outv]";
  }

  runCommand(
    "ffmpeg",
    ["-y", ...inputs, "-filter_complex", filterParts.join(";"), "-map", outLabel, "-map", "0:a",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart", outPath],
    { quiet: true },
  );
}

export function renderFromEdl(options: RenderOptions): string {
  const edlPath = resolve(options.edlPath);
  const edl = JSON.parse(readFileSync(edlPath, "utf8")) as Edl;
  const editDir = dirname(edlPath);
  const outPath = resolve(options.output);

  const segmentPaths = extractAllSegments(edl, editDir, options.preview ?? false, options.draft ?? false);

  const baseName = options.draft ? "base_draft.mp4" : options.preview ? "base_preview.mp4" : "base.mp4";
  const basePath = join(editDir, baseName);
  concatSegments(segmentPaths, basePath, editDir);

  let subsPath: string | null = null;
  if (!options.noSubtitles) {
    if (options.buildSubtitles) {
      subsPath = join(editDir, "master.srt");
      buildMasterSrt(edl, editDir, subsPath);
    } else if (edl.subtitles) {
      subsPath = resolvePath(edl.subtitles, editDir);
    }
  }

  const overlays = edl.overlays ?? [];

  if (options.noLoudnorm) {
    buildFinalComposite(basePath, overlays, subsPath, outPath, editDir);
  } else {
    const tmpComposite = outPath.replace(/\.mp4$/i, ".prenorm.mp4");
    buildFinalComposite(basePath, overlays, subsPath, tmpComposite, editDir);
    applyLoudnormTwoPass(tmpComposite, outPath, options.draft ?? false);
    try {
      unlinkSync(tmpComposite);
    } catch {
      /* ignore */
    }
  }

  return outPath;
}

export function loadEdl(edlPath: string): Edl {
  const edl = JSON.parse(readFileSync(edlPath, "utf8")) as Edl;
  if (edl.ranges.length === 0 || Object.keys(edl.sources).length === 0) {
    throw new ValidationError("invalid EDL: missing ranges or sources");
  }
  return edl;
}
