/** Word-level Scribe transcript token. */
export interface ScribeWord {
  type: "word" | "spacing" | "audio_event";
  text?: string;
  start?: number;
  end?: number;
  speaker_id?: string;
}

/** Full ElevenLabs Scribe API response. */
export interface ScribeTranscript {
  words: ScribeWord[];
  language_code?: string;
  text?: string;
}

/** Phrase grouped from word-level tokens for packed markdown. */
export interface PackedPhrase {
  start: number;
  end: number;
  text: string;
  speaker_id: string | null;
}

/** Single entry in packed transcript output. */
export interface PackedTake {
  name: string;
  duration: number;
  phrases: PackedPhrase[];
}

/** EDL segment range. */
export interface EdlRange {
  source: string;
  start: number;
  end: number;
  beat?: string;
  quote?: string;
  reason?: string;
  note?: string;
}

/** Animation overlay on the output timeline. */
export interface EdlOverlay {
  file: string;
  start_in_output: number;
  duration: number;
}

/** Edit Decision List consumed by render. */
export interface Edl {
  version: number;
  sources: Record<string, string>;
  ranges: EdlRange[];
  grade?: string;
  overlays?: EdlOverlay[];
  subtitles?: string;
  total_duration_s?: number;
}

/** Grade preset identifiers. */
export type GradePreset = "subtle" | "neutral_punch" | "warm_cinematic" | "none";

/** Auto-grade statistics from ffmpeg signalstats. */
export interface GradeStats {
  y_mean: number;
  y_std: number;
  sat_mean: number;
}

/** Video file extensions scanned for batch transcription. */
export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".MP4",
  ".mov",
  ".MOV",
  ".mkv",
  ".MKV",
  ".avi",
  ".AVI",
  ".m4v",
]);

/** Log levels supported by the logger. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Redis connection status lifecycle. */
export type RedisConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

/** Application environment configuration. */
export interface AppConfig {
  elevenLabsApiKey: string;
  logLevel: LogLevel;
  redis: RedisConfig;
}

/** Redis configuration from environment. */
export interface RedisConfig {
  enabled: boolean;
  url: string;
  keyPrefix: string;
  connectTimeoutMs: number;
  maxRetries: number;
  defaultTtlSeconds: number;
}

/** Transcription options for Scribe. */
export interface TranscribeOptions {
  editDir: string;
  language?: string | undefined;
  numSpeakers?: number | undefined;
  verbose?: boolean | undefined;
}

/** Batch transcription options. */
export interface TranscribeBatchOptions extends TranscribeOptions {
  videosDir: string;
  workers?: number | undefined;
}

/** Timeline render options. */
export interface TimelineOptions {
  video: string;
  start: number;
  end: number;
  output?: string | undefined;
  nFrames?: number | undefined;
  transcript?: string | undefined;
}

/** Render pipeline options. */
export interface RenderOptions {
  edlPath: string;
  output: string;
  preview?: boolean | undefined;
  draft?: boolean | undefined;
  buildSubtitles?: boolean | undefined;
  noSubtitles?: boolean | undefined;
  noLoudnorm?: boolean | undefined;
}

/** Pack transcripts options. */
export interface PackOptions {
  editDir: string;
  silenceThreshold?: number | undefined;
  output?: string | undefined;
}

/** Grade application options. */
export interface GradeOptions {
  input: string;
  output: string;
  preset?: GradePreset | undefined;
  filter?: string | undefined;
}
