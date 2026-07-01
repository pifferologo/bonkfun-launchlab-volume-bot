import { afterEach, describe, expect, it } from "vitest";

import { getRedisConfig, loadConfig, resetConfigCache } from "../src/config/env.js";
import { buildCacheKey, resetTranscriptCache } from "../src/redis/cache.js";
import { RedisManager, resetRedisManager } from "../src/redis/manager.js";

const testEnv = {
  ...process.env,
  NODE_ENV: "test",
  ELEVENLABS_API_KEY: "test-key",
  LOG_LEVEL: "error",
};

describe("RedisManager", () => {
  afterEach(() => {
    resetConfigCache();
    resetRedisManager();
    resetTranscriptCache();
  });

  it("reports disabled when redis is turned off", () => {
    const config = getRedisConfig(
      loadConfig({ ...testEnv, REDIS_ENABLED: "false" }),
    );
    const manager = new RedisManager(config);
    expect(manager.isEnabled()).toBe(false);
    expect(manager.getStatus()).toBe("disconnected");
  });

  it("throws when connecting while disabled", async () => {
    const config = getRedisConfig(
      loadConfig({ ...testEnv, REDIS_ENABLED: "false" }),
    );
    const manager = new RedisManager(config);
    await expect(manager.connect()).rejects.toThrow(/disabled/i);
  });

  it("shuts down cleanly without an active client", async () => {
    const config = getRedisConfig(loadConfig(testEnv));
    const manager = new RedisManager({ ...config, enabled: false });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe("Redis cache keys", () => {
  it("builds deterministic cache keys", () => {
    const a = buildCacheKey("transcript", { source: "C0103", size: 1024 });
    const b = buildCacheKey("transcript", { source: "C0103", size: 1024 });
    expect(a).toBe(b);
    expect(a.startsWith("transcript:")).toBe(true);
  });
});
