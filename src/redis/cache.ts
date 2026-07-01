import { createHash } from "node:crypto";

import { getRedisConfig, loadConfig } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getRedisManager } from "./manager.js";

export function buildCacheKey(namespace: string, payload: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
  return `${namespace}:${hash}`;
}

export class TranscriptCache {
  constructor(private readonly ttlSeconds: number) {}

  private isEnabled(): boolean {
    return getRedisConfig(loadConfig()).enabled;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isEnabled()) return null;

    try {
      const manager = getRedisManager();
      const client = await manager.connect();
      const raw = await client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.warn("Cache get failed", {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const manager = getRedisManager();
      const client = await manager.connect();
      await client.set(key, JSON.stringify(value), "EX", this.ttlSeconds);
    } catch (error) {
      logger.warn("Cache set failed", {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const manager = getRedisManager();
      const client = await manager.connect();
      await client.del(key);
    } catch (error) {
      logger.warn("Cache delete failed", {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await factory();
    await this.set(key, value);
    return value;
  }
}

let transcriptCache: TranscriptCache | undefined;

export function getTranscriptCache(): TranscriptCache {
  const config = getRedisConfig(loadConfig());
  transcriptCache ??= new TranscriptCache(config.defaultTtlSeconds);
  return transcriptCache;
}

export function resetTranscriptCache(): void {
  transcriptCache = undefined;
}
