import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { logger } from "../config/logger.js";
import type { TranscribeBatchOptions } from "../types/index.js";
import { VIDEO_EXTENSIONS } from "../types/index.js";
import { ValidationError } from "./errors.js";
import { transcribeOne } from "./transcribe.js";

function findVideos(videosDir: string): string[] {
  return readdirSync(videosDir)
    .map((name) => join(videosDir, name))
    .filter((path) => {
      const stat = statSync(path);
      if (!stat.isFile()) return false;
      const ext = path.slice(path.lastIndexOf("."));
      return VIDEO_EXTENSIONS.has(ext);
    })
    .sort();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function runWorker(): Promise<void> {
    while (index < items.length) {
      const current = index;
      index += 1;
      const item = items[current];
      if (item === undefined) continue;
      results[current] = await worker(item);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

/** Batch-transcribe every video in a directory with parallel workers. */
export async function transcribeBatch(options: TranscribeBatchOptions): Promise<string[]> {
  const videosDir = resolve(options.videosDir);
  if (!statSync(videosDir).isDirectory()) {
    throw new ValidationError(`not a directory: ${videosDir}`);
  }

  const editDir = resolve(options.editDir ?? join(videosDir, "edit"));
  const videos = findVideos(videosDir);
  if (videos.length === 0) {
    throw new ValidationError(`no videos found in ${videosDir}`);
  }

  const pending = videos.filter((video) => {
    const stem = basename(video).replace(/\.[^.]+$/, "");
    return !existsSync(join(editDir, "transcripts", `${stem}.json`));
  });

  const cachedCount = videos.length - pending.length;
  logger.info(`found ${videos.length} videos (${cachedCount} cached, ${pending.length} to transcribe)`);

  if (pending.length === 0) {
    logger.info("nothing to do");
    return videos.map((v) => join(editDir, "transcripts", `${basename(v).replace(/\.[^.]+$/, "")}.json`));
  }

  const workers = options.workers ?? 4;
  logger.info(`transcribing ${pending.length} files with ${workers} parallel workers`);

  const started = Date.now();
  const errors: Array<{ video: string; message: string }> = [];

  await mapWithConcurrency(pending, workers, async (video) => {
    try {
      const out = await transcribeOne(video, {
        editDir,
        language: options.language,
        numSpeakers: options.numSpeakers,
        verbose: false,
      });
      logger.info(`  + ${basename(video)} → ${basename(out)}`);
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ video, message });
      logger.error(`  x ${basename(video)} FAILED: ${message}`);
      return "";
    }
  });

  logger.info(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (errors.length > 0) {
    throw new ValidationError(`${errors.length} transcription failures`);
  }

  return pending.map((v) => join(editDir, "transcripts", `${basename(v).replace(/\.[^.]+$/, "")}.json`));
}
