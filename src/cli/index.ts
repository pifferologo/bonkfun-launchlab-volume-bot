#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";

import { loadConfig } from "../config/env.js";
import { logger } from "../config/logger.js";
import { exitWithError } from "../lib/errors.js";
import { PRESETS, applyGrade, autoGradeForClip, getPreset } from "../lib/grade.js";
import { packTranscripts } from "../lib/pack.js";
import { renderFromEdl } from "../lib/render.js";
import { renderTimeline } from "../lib/timeline.js";
import { transcribeBatch } from "../lib/transcribe-batch.js";
import { defaultEditDir, transcribeOne } from "../lib/transcribe.js";
import type { GradePreset } from "../types/index.js";
import { getRedisManager, pingRedis } from "../redis/manager.js";

const program = new Command();

program
  .name("video-use")
  .description("Conversation-driven video editor CLI")
  .version("0.2.0");

program
  .command("transcribe")
  .description("Transcribe a single video with ElevenLabs Scribe")
  .argument("<video>", "Path to video file")
  .option("--edit-dir <dir>", "Edit output directory")
  .option("--language <code>", "ISO language code")
  .option("--num-speakers <n>", "Number of speakers", (v) => Number.parseInt(v, 10))
  .action(async (video: string, opts: { editDir?: string; language?: string; numSpeakers?: number }) => {
    try {
      loadConfig();
      const editDir = opts.editDir ?? defaultEditDir(video);
      const out = await transcribeOne(video, {
        editDir: resolve(editDir),
        language: opts.language,
        numSpeakers: opts.numSpeakers,
      });
      logger.info(`transcript: ${out}`);
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command("transcribe-batch")
  .description("Parallel batch transcription for a videos directory")
  .argument("<videosDir>", "Directory containing source videos")
  .option("--edit-dir <dir>", "Edit output directory")
  .option("--workers <n>", "Parallel workers", (v) => Number.parseInt(v, 10), 4)
  .option("--language <code>", "ISO language code")
  .option("--num-speakers <n>", "Number of speakers", (v) => Number.parseInt(v, 10))
  .action(async (videosDir: string, opts: { editDir?: string; workers?: number; language?: string; numSpeakers?: number }) => {
    try {
      loadConfig();
      await transcribeBatch({
        videosDir: resolve(videosDir),
        editDir: opts.editDir ? resolve(opts.editDir) : resolve(videosDir, "edit"),
        workers: opts.workers,
        language: opts.language,
        numSpeakers: opts.numSpeakers,
      });
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command("pack")
  .description("Pack Scribe transcripts into takes_packed.md")
  .requiredOption("--edit-dir <dir>", "Edit directory containing transcripts/")
  .option("--silence-threshold <s>", "Silence threshold in seconds", (v) => Number.parseFloat(v), 0.5)
  .option("-o, --output <path>", "Output markdown path")
  .action((opts: { editDir: string; silenceThreshold: number; output?: string }) => {
    try {
      loadConfig();
      const result = packTranscripts({
        editDir: resolve(opts.editDir),
        silenceThreshold: opts.silenceThreshold,
        output: opts.output ? resolve(opts.output) : undefined,
      });
      logger.info(`packed → ${result.outputPath}`);
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command("render")
  .description("Render a video from an EDL")
  .argument("<edl>", "Path to edl.json")
  .requiredOption("-o, --output <path>", "Output video path")
  .option("--preview", "Preview mode (1080p, faster)")
  .option("--draft", "Draft mode (720p, ultrafast)")
  .option("--build-subtitles", "Build master.srt from transcripts")
  .option("--no-subtitles", "Skip subtitles")
  .option("--no-loudnorm", "Skip loudness normalization")
  .action((edl: string, opts: { output: string; preview?: boolean; draft?: boolean; buildSubtitles?: boolean; noSubtitles?: boolean; noLoudnorm?: boolean }) => {
    try {
      loadConfig();
      const out = renderFromEdl({
        edlPath: resolve(edl),
        output: resolve(opts.output),
        preview: opts.preview,
        draft: opts.draft,
        buildSubtitles: opts.buildSubtitles,
        noSubtitles: opts.noSubtitles,
        noLoudnorm: opts.noLoudnorm,
      });
      logger.info(`rendered → ${out}`);
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command("timeline")
  .description("Filmstrip + waveform composite for a video range")
  .argument("<video>", "Source video")
  .argument("<start>", "Start time in seconds", parseFloat)
  .argument("<end>", "End time in seconds", parseFloat)
  .option("-o, --output <path>", "Output PNG path")
  .option("--n-frames <n>", "Number of filmstrip frames", (v) => Number.parseInt(v, 10), 10)
  .option("--transcript <path>", "Transcript JSON path")
  .action(async (video: string, start: number, end: number, opts: { output?: string; nFrames?: number; transcript?: string }) => {
    try {
      loadConfig();
      const out = await renderTimeline({
        video: resolve(video),
        start,
        end,
        output: opts.output ? resolve(opts.output) : undefined,
        nFrames: opts.nFrames,
        transcript: opts.transcript ? resolve(opts.transcript) : undefined,
      });
      logger.info(`timeline → ${out}`);
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command("grade")
  .description("Apply a color grade via ffmpeg filter chain")
  .argument("<input>", "Input video")
  .requiredOption("-o, --output <path>", "Output video")
  .option("--preset <name>", "Grade preset")
  .option("--filter <chain>", "Raw ffmpeg filter string")
  .option("--list-presets", "List available presets")
  .option("--analyze", "Print auto-grade analysis only")
  .action((input: string, opts: { output: string; preset?: string; filter?: string; listPresets?: boolean; analyze?: boolean }) => {
    try {
      loadConfig();
      if (opts.listPresets) {
        for (const [name, filter] of Object.entries(PRESETS)) {
          console.log(`${name}:\n  ${filter || "(no filter)"}\n`);
        }
        return;
      }

      const resolved = resolve(input);
      if (opts.analyze) {
        const { filter, stats } = autoGradeForClip(resolved);
        console.log(`filter: ${filter || "(none)"}`);
        console.log(`stats: ${JSON.stringify(stats, null, 2)}`);
        return;
      }

      let filterString = opts.filter ?? "";
      if (!filterString && opts.preset) {
        filterString = getPreset(opts.preset as GradePreset);
      } else if (!filterString && !opts.preset) {
        filterString = autoGradeForClip(resolved).filter;
      }

      applyGrade(resolved, resolve(opts.output), filterString);
      logger.info(`graded → ${opts.output}`);
    } catch (error) {
      exitWithError(error);
    }
  });

const redisCmd = program.command("redis").description("Redis connectivity commands");

redisCmd
  .command("ping")
  .description("Ping the configured Redis instance")
  .action(async () => {
    try {
      loadConfig();
      const result = await pingRedis();
      if (result.ok) {
        logger.info(`redis ping: ${result.message}`);
      } else {
        logger.warn(result.message);
        process.exitCode = 1;
      }
      await getRedisManager().shutdown();
    } catch (error) {
      exitWithError(error);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  exitWithError(error);
});
