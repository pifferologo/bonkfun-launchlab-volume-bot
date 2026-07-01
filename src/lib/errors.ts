/** Base error for video-use CLI failures. */
export class VideoUseError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = "VIDEO_USE_ERROR", exitCode = 1) {
    super(message);
    this.name = "VideoUseError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Configuration or environment validation failure. */
export class ConfigError extends VideoUseError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", 1);
    this.name = "ConfigError";
  }
}

/** External tool invocation failure (ffmpeg, ffprobe). */
export class FfmpegError extends VideoUseError {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message, "FFMPEG_ERROR", 1);
    this.name = "FfmpegError";
    this.stderr = stderr;
  }
}

/** ElevenLabs Scribe API failure. */
export class ScribeError extends VideoUseError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message, "SCRIBE_ERROR", 1);
    this.name = "ScribeError";
    this.statusCode = statusCode;
  }
}

/** Redis connectivity or operation failure. */
export class RedisError extends VideoUseError {
  constructor(message: string) {
    super(message, "REDIS_ERROR", 1);
    this.name = "RedisError";
  }
}

/** Input validation failure. */
export class ValidationError extends VideoUseError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 1);
    this.name = "ValidationError";
  }
}

/** Format an unknown error for logging or CLI output. */
export function formatError(error: unknown): string {
  if (error instanceof VideoUseError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Exit the process with a formatted error message. */
export function exitWithError(error: unknown): never {
  const message = formatError(error);
  console.error(`error: ${message}`);
  const exitCode = error instanceof VideoUseError ? error.exitCode : 1;
  process.exit(exitCode);
}
