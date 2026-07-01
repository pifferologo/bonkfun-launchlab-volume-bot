import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError } from "../lib/errors.js";
import type { AppConfig, LogLevel, RedisConfig } from "../types/index.js";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

let cachedConfig: AppConfig | undefined;

function findEnvFile(): string | undefined {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"),
  ];
  return candidates.find((path) => existsSync(path));
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "info").toLowerCase();
  if (LOG_LEVELS.includes(normalized as LogLevel)) {
    return normalized as LogLevel;
  }
  return "info";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function buildRedisConfig(env: NodeJS.ProcessEnv): RedisConfig {
  return {
    enabled: parseBoolean(env.REDIS_ENABLED, false),
    url: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    keyPrefix: env.REDIS_KEY_PREFIX ?? "video-use:",
    connectTimeoutMs: parseInteger(env.REDIS_CONNECT_TIMEOUT_MS, 10_000),
    maxRetries: parseInteger(env.REDIS_MAX_RETRIES, 5),
    defaultTtlSeconds: parseInteger(env.REDIS_DEFAULT_TTL_SECONDS, 86_400),
  };
}

/** Load and validate application configuration from environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envFile = findEnvFile();
  if (envFile) {
    loadDotenv({ path: envFile });
  }

  const elevenLabsApiKey = env.ELEVENLABS_API_KEY?.trim() ?? "";
  if (!elevenLabsApiKey && env.NODE_ENV !== "test") {
    throw new ConfigError("ELEVENLABS_API_KEY not found in .env or environment");
  }

  return {
    elevenLabsApiKey,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    redis: buildRedisConfig(env),
  };
}

/** Return cached config, loading on first access. */
export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}

/** Reset cached config — used in tests. */
export function resetConfigCache(): void {
  cachedConfig = undefined;
}

/** Extract Redis config from a loaded AppConfig. */
export function getRedisConfig(config: AppConfig): RedisConfig {
  return config.redis;
}

/** Resolve ElevenLabs API key, throwing if missing. */
export function requireApiKey(config: AppConfig = getConfig()): string {
  if (!config.elevenLabsApiKey) {
    throw new ConfigError("ELEVENLABS_API_KEY not found in .env or environment");
  }
  return config.elevenLabsApiKey;
}
