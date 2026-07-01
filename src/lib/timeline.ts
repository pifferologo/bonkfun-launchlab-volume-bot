import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

import { logger } from "../config/logger.js";
import type { ScribeTranscript, ScribeWord, TimelineOptions } from "../types/index.js";
import { ValidationError } from "./errors.js";
import { computeAudioEnvelope, extractFrame } from "./ffmpeg.js";

const BG = { r: 18, g: 18, b: 22 };

function wordsInRange(
  transcriptPath: string,
  start: number,
  end: number,
): ScribeWord[] {
  if (!existsSync(transcriptPath)) return [];
  const data = JSON.parse(readFileSync(transcriptPath, "utf8")) as ScribeTranscript;
  return (data.words ?? []).filter((w) => {
    const ws = w.start;
    const we = w.end;
    if (ws === undefined || we === undefined) return false;
    return !(we <= start || ws >= end);
  });
}

function findSilences(
  words: ScribeWord[],
  start: number,
  end: number,
  threshold = 0.4,
): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let prevEnd = start;
  for (const word of words) {
    if (word.type === "spacing") continue;
    const ws = Math.max(start, word.start ?? start);
    if (ws - prevEnd >= threshold) gaps.push([prevEnd, ws]);
    prevEnd = Math.max(prevEnd, word.end ?? ws);
  }
  if (end - prevEnd >= threshold) gaps.push([prevEnd, end]);
  return gaps;
}

function extractFrames(
  videoPath: string,
  start: number,
  end: number,
  n: number,
  destDir: string,
): string[] {
  const count = Math.max(1, n);
  const times =
    count === 1
      ? [(start + end) / 2]
      : Array.from({ length: count }, (_, i) => start + (i * (end - start)) / (count - 1));

  return times.map((t, i) => {
    const out = join(destDir, `f_${String(i).padStart(3, "0")}.jpg`);
    extractFrame(videoPath, t, out);
    return out;
  });
}

async function buildFilmstrip(framePaths: string[], frameHeight: number): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
}> {
  const resized = await Promise.all(
    framePaths.map(async (path) => {
      const img = sharp(path);
      const meta = await img.metadata();
      const aspect = (meta.width ?? 320) / (meta.height ?? 180);
      const width = Math.round(frameHeight * aspect);
      return img.resize(width, frameHeight).toBuffer();
    }),
  );

  const gap = 4;
  let widthSum = 0;
  const metas = await Promise.all(resized.map((buf) => sharp(buf).metadata()));
  for (const meta of metas) {
    widthSum += (meta.width ?? 0) + gap;
  }
  widthSum -= gap;

  const composite: sharp.OverlayOptions[] = [];
  let x = 0;
  for (let i = 0; i < resized.length; i++) {
    const buf = resized[i];
    const meta = metas[i];
    if (!buf || meta?.width === undefined) continue;
    composite.push({ input: buf, left: x, top: 0 });
    x += meta.width + gap;
  }

  const strip = await sharp({
    create: {
      width: Math.max(1, widthSum),
      height: frameHeight,
      channels: 3,
      background: BG,
    },
  })
    .composite(composite)
    .png()
    .toBuffer();

  return { buffer: strip, width: widthSum, height: frameHeight };
}

function drawWaveformSvg(
  envelope: Float32Array,
  width: number,
  height: number,
  silences: Array<[number, number]>,
  start: number,
  end: number,
): string {
  const midY = height / 2;
  const maxAmp = height / 2 - 8;
  let topPoints = "";
  let bottomPoints = "";

  for (let i = 0; i < envelope.length; i++) {
    const x = (i / Math.max(1, envelope.length - 1)) * width;
    const amp = (envelope[i] ?? 0) * maxAmp;
    topPoints += `${x.toFixed(1)},${(midY - amp).toFixed(1)} `;
    bottomPoints += `${x.toFixed(1)},${(midY + amp).toFixed(1)} `;
  }

  const silenceRects = silences
    .map(([a, b]) => {
      const xa = ((a - start) / (end - start)) * width;
      const xb = ((b - start) / (end - start)) * width;
      return `<rect x="${xa.toFixed(1)}" y="0" width="${Math.max(1, xb - xa).toFixed(1)}" height="${height}" fill="rgba(50,80,120,0.35)"/>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="rgb(28,28,34)"/>
    ${silenceRects}
    <polygon points="${topPoints}${bottomPoints.split(" ").reverse().join(" ")}" fill="rgba(140,180,255,0.35)" stroke="rgb(140,180,255)" stroke-width="1"/>
  </svg>`;
}

function drawLabelsSvg(
  words: ScribeWord[],
  width: number,
  waveY: number,
  start: number,
  end: number,
): string {
  let lastLabelX = -9999;
  const labels: string[] = [];

  for (const word of words) {
    if (word.type !== "word") continue;
    const ws = word.start;
    const we = word.end;
    const text = (word.text ?? "").trim();
    if (!text || ws === undefined || we === undefined) continue;
    if (we - ws < 0.05) continue;

    const xa = ((ws - start) / (end - start)) * width;
    const xb = ((we - start) / (end - start)) * width;
    const cx = (xa + xb) / 2;
    if (cx - lastLabelX < 28) continue;

    labels.push(`<line x1="${cx.toFixed(1)}" y1="${waveY - 4}" x2="${cx.toFixed(1)}" y2="${waveY}" stroke="rgb(110,110,120)" stroke-width="1"/>`);
    labels.push(
      `<text x="${(cx + 2).toFixed(1)}" y="${waveY - 18}" fill="rgb(235,235,235)" font-family="monospace" font-size="12">${text.replace(/[<>&]/g, "")}</text>`,
    );
    lastLabelX = cx;
  }

  return labels.join("");
}

/** Render a filmstrip + waveform composite PNG for a video range. */
export async function renderTimeline(options: TimelineOptions): Promise<string> {
  const { video, start, end } = options;
  if (end <= start) {
    throw new ValidationError("end must be greater than start");
  }

  const nFrames = options.nFrames ?? 10;
  const videoName = basename(video);
  const transcript =
    options.transcript ??
    join(dirname(video), "edit", "transcripts", `${basename(video, ".mp4")}.json`);

  const output =
    options.output ??
    join(dirname(video), "edit", "verify", `${basename(video, ".mp4")}_${start.toFixed(2)}-${end.toFixed(2)}.png`);

  logger.info(`extracting ${nFrames} frames from ${start.toFixed(2)}s to ${end.toFixed(2)}s`);

  const tempDir = mkdtempSync(join(tmpdir(), "video-use-timeline-"));
  try {
    const framePaths = extractFrames(video, start, end, nFrames, tempDir);
    const frameHeight = 180;
    const filmstrip = await buildFilmstrip(framePaths, frameHeight);

    const margin = 50;
    const filmstripY = 50;
    const waveY = filmstripY + frameHeight + 20;
    const waveH = 220;
    const labelY = waveY + waveH + 40;
    const contentWidth = Math.max(1400, filmstrip.width);
    const canvasWidth = contentWidth + margin * 2;
    const canvasHeight = labelY + 40;

    const words = wordsInRange(transcript, start, end);
    const silences = words.length > 0 ? findSilences(words, start, end) : [];
    const envelope = computeAudioEnvelope(video, start, end, Math.max(contentWidth, 200));

    const headerSvg = Buffer.from(
      `<svg width="${canvasWidth}" height="40">
        <text x="${margin}" y="28" fill="rgb(235,235,235)" font-family="monospace" font-size="18">
          ${videoName}   ${start.toFixed(2)}s → ${end.toFixed(2)}s   (${(end - start).toFixed(2)}s, ${nFrames} frames)
        </text>
      </svg>`,
    );

    const waveSvg = Buffer.from(
      drawWaveformSvg(envelope, contentWidth, waveH, silences, start, end),
    );
    const labelsSvg = Buffer.from(
      `<svg width="${canvasWidth}" height="30">${drawLabelsSvg(words, contentWidth, waveH, start, end)}</svg>`,
    );

    const rulerLines: string[] = [];
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const t = start + frac * (end - start);
      const x = margin + frac * contentWidth;
      rulerLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="6" stroke="rgb(110,110,120)"/>`);
      rulerLines.push(
        `<text x="${x - 20}" y="22" fill="rgb(110,110,120)" font-family="monospace" font-size="12">${t.toFixed(2)}s</text>`,
      );
    }
    const rulerSvg = Buffer.from(
      `<svg width="${canvasWidth}" height="30">${rulerLines.join("")}</svg>`,
    );

    await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: BG,
      },
    })
      .composite([
        { input: headerSvg, left: 0, top: 0 },
        { input: filmstrip.buffer, left: margin, top: filmstripY },
        { input: waveSvg, left: margin, top: waveY },
        { input: labelsSvg, left: margin, top: waveY - 20 },
        { input: rulerSvg, left: 0, top: waveY + waveH + 2 },
      ])
      .png()
      .toFile(output);

    logger.info(`saved: ${output}`);
    return output;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
