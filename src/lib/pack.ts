import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { PackOptions, PackedPhrase, PackedTake, ScribeTranscript, ScribeWord } from "../types/index.js";
import { ValidationError } from "./errors.js";

/** Format seconds as a fixed-width timestamp string. */
export function formatTime(seconds: number): string {
  return seconds.toFixed(2).padStart(6, "0");
}

/** Format duration as seconds or minutes. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1).padStart(4, "0")}s`;
}

/** Group Scribe words into phrase-level lines. */
export function groupIntoPhrases(
  words: ScribeWord[],
  silenceThreshold = 0.5,
): PackedPhrase[] {
  const phrases: PackedPhrase[] = [];
  let currentWords: ScribeWord[] = [];
  let currentStart: number | null = null;
  let currentSpeaker: string | null = null;
  let prevEnd: number | null = null;

  const flush = (): void => {
    if (currentWords.length === 0) {
      return;
    }

    const textParts: string[] = [];
    for (const word of currentWords) {
      const tokenType = word.type ?? "word";
      let raw = (word.text ?? "").trim();
      if (!raw) {
        continue;
      }
      if (tokenType === "audio_event" && !raw.startsWith("(")) {
        raw = `(${raw})`;
      }
      textParts.push(raw);
    }

    if (textParts.length === 0) {
      currentWords = [];
      currentStart = null;
      currentSpeaker = null;
      return;
    }

    let text = textParts.join(" ");
    text = text
      .replace(" ,", ",")
      .replace(" .", ".")
      .replace(" ?", "?")
      .replace(" !", "!");

    const lastWord = currentWords[currentWords.length - 1];
    const endTime = lastWord?.end ?? lastWord?.start ?? currentStart ?? 0;

    phrases.push({
      start: currentStart ?? 0,
      end: endTime,
      text,
      speaker_id: currentSpeaker,
    });

    currentWords = [];
    currentStart = null;
    currentSpeaker = null;
  };

  for (const word of words) {
    const tokenType = word.type ?? "word";

    if (tokenType === "spacing") {
      const gapStart = word.start;
      const gapEnd = word.end;
      if (gapStart !== undefined && gapEnd !== undefined) {
        const gap = gapEnd - gapStart;
        if (gap >= silenceThreshold) {
          flush();
        }
      }
      continue;
    }

    const start = word.start;
    if (start === undefined) {
      continue;
    }

    const speaker = word.speaker_id ?? null;
    if (currentSpeaker !== null && speaker !== null && speaker !== currentSpeaker) {
      flush();
    }

    if (prevEnd !== null && start - prevEnd >= silenceThreshold) {
      flush();
    }

    if (currentStart === null) {
      currentStart = start;
      currentSpeaker = speaker;
    }

    currentWords.push(word);
    prevEnd = word.end ?? start;
  }

  flush();
  return phrases;
}

/** Pack one transcript JSON file into a take entry. */
export function packOneFile(
  jsonPath: string,
  silenceThreshold: number,
): PackedTake {
  const data = JSON.parse(readFileSync(jsonPath, "utf8")) as ScribeTranscript;
  const phrases = groupIntoPhrases(data.words ?? [], silenceThreshold);
  const duration =
    phrases.length > 0
      ? (phrases[phrases.length - 1]?.end ?? 0) - (phrases[0]?.start ?? 0)
      : 0;

  return {
    name: basename(jsonPath, ".json"),
    duration,
    phrases,
  };
}

/** Render packed takes as markdown for the LLM reading view. */
export function renderPackedMarkdown(
  entries: PackedTake[],
  silenceThreshold: number,
): string {
  const lines: string[] = [
    "# Packed transcripts",
    "",
    `Phrase-level, grouped on silences ≥ ${silenceThreshold.toFixed(1)}s or speaker change.`,
    "Use `[start-end]` ranges to address cuts in the EDL.",
    "",
  ];

  for (const entry of entries) {
    lines.push(
      `## ${entry.name}  (duration: ${formatDuration(entry.duration)}, ${entry.phrases.length} phrases)`,
    );

    if (entry.phrases.length === 0) {
      lines.push("  _no speech detected_");
      lines.push("");
      continue;
    }

    for (const phrase of entry.phrases) {
      let speakerTag = "";
      if (phrase.speaker_id !== null) {
        let speaker = phrase.speaker_id;
        if (speaker.startsWith("speaker_")) {
          speaker = speaker.slice("speaker_".length);
        }
        speakerTag = ` S${speaker}`;
      }
      lines.push(
        `  [${formatTime(phrase.start)}-${formatTime(phrase.end)}]${speakerTag} ${phrase.text}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Pack all transcripts in an edit directory into markdown. */
export function packTranscripts(options: PackOptions): {
  outputPath: string;
  entries: PackedTake[];
  markdown: string;
} {
  const editDir = options.editDir;
  const silenceThreshold = options.silenceThreshold ?? 0.5;
  const transcriptsDir = join(editDir, "transcripts");

  if (!statSync(transcriptsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ValidationError(`no transcripts directory at ${transcriptsDir}`);
  }

  const jsonFiles = readdirSync(transcriptsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(transcriptsDir, name));

  if (jsonFiles.length === 0) {
    throw new ValidationError(`no .json files in ${transcriptsDir}`);
  }

  const entries = jsonFiles.map((path) => packOneFile(path, silenceThreshold));
  const markdown = renderPackedMarkdown(entries, silenceThreshold);
  const outputPath = options.output ?? join(editDir, "takes_packed.md");
  writeFileSync(outputPath, markdown, "utf8");

  return { outputPath, entries, markdown };
}
