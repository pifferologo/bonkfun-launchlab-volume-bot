import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { requireApiKey } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { ScribeTranscript, TranscribeOptions } from "../types/index.js";
import { ValidationError } from "./errors.js";
import { extractAudio } from "./ffmpeg.js";
import { callScribe } from "./scribe.js";
import { getTranscriptCache } from "../redis/cache.js";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function fileFingerprint(videoPath: string): string {
  const stat = statSync(videoPath);
  return createHash("sha256")
    .update(`${videoPath}:${stat.size}:${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
}

/** Transcribe a single video file, using filesystem and optional Redis cache. */
export async function transcribeOne(
  videoPath: string,
  options: TranscribeOptions,
): Promise<string> {
  const video = resolve(videoPath);
  if (!existsSync(video)) {
    throw new ValidationError(`video not found: ${video}`);
  }

  const editDir = resolve(options.editDir);
  const transcriptsDir = join(editDir, "transcripts");
  ensureDir(transcriptsDir);

  const stem = basename(video).replace(/\.[^.]+$/, "");
  const outPath = join(transcriptsDir, `${stem}.json`);

  if (existsSync(outPath)) {
    if (options.verbose !== false) {
      logger.info(`cached: ${basename(outPath)}`);
    }
    return outPath;
  }

  const cache = getTranscriptCache();
  const cacheKey = `transcript:${stem}:${fileFingerprint(video)}`;
  const cached = await cache.get<ScribeTranscript>(cacheKey);
  if (cached) {
    writeFileSync(outPath, JSON.stringify(cached, null, 2), "utf8");
    logger.info(`redis cache hit: ${basename(outPath)}`);
    return outPath;
  }

  const apiKey = requireApiKey();
  const tempDir = mkdtempSync(join(tmpdir(), "video-use-transcribe-"));
  const audioPath = join(tempDir, `${stem}.wav`);

  try {
    if (options.verbose !== false) {
      logger.info(`extracting audio from ${basename(video)}`);
    }
    extractAudio(video, audioPath);

    const started = Date.now();
    const payload = await callScribe(audioPath, {
      language: options.language,
      numSpeakers: options.numSpeakers,
      apiKey,
    });

    writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
    await cache.set(cacheKey, payload);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (options.verbose !== false) {
      logger.info(`saved: ${basename(outPath)} in ${elapsed}s (${payload.words?.length ?? 0} words)`);
    }

    return outPath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Resolve default edit directory adjacent to the source video. */
export function defaultEditDir(videoPath: string): string {
  return join(dirname(resolve(videoPath)), "edit");
}

/** Load a cached transcript JSON if present. */
export function loadTranscript(transcriptPath: string): ScribeTranscript {
  return JSON.parse(readFileSync(transcriptPath, "utf8")) as ScribeTranscript;
}
