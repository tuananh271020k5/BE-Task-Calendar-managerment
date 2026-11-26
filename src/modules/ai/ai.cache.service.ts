import crypto from "crypto";
import { getRedis } from "../../services/redis.service";
import { CACHE_VERSION, versionedKey } from "../../config/cache-version";

const AI_CACHE_TTL_SECONDS = 300; // 5 minutes default for AI responses
const BREAKDOWN_CACHE_TTL_SECONDS = 86400; // 24 hours for shared task breakdown cache

const normalizeCacheSegment = (text?: string): string =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const buildTaskBreakdownCacheKey = (params: {
  title: string;
  description?: string;
  totalMinutes?: number;
  profileKey?: string;
  model?: string;
}): string => {
  const modelPart = params.model || "default";
  const payload = [
    normalizeCacheSegment(params.title),
    normalizeCacheSegment(params.description),
    params.totalMinutes !== undefined && params.totalMinutes !== null
      ? String(params.totalMinutes)
      : "auto",
    params.profileKey || "default",
  ].join("|");

  const hash = crypto
    .createHash("sha256")
    .update(payload)
    .digest("hex")
    .slice(0, 20);

  return versionedKey(
    CACHE_VERSION.AI,
    `ai:task-breakdown:shared:${hash}:${modelPart}`,
  );
};

export type CachedTaskBreakdown = {
  steps: {
    title: string;
    status: string;
    estimatedDuration?: number;
    difficulty?: "easy" | "medium" | "hard";
    description?: string;
  }[];
  totalEstimatedDuration?: number;
};

export const aiCacheService = {
  buildPromptHash: (prompt: string): string => {
    return crypto.createHash("sha256").update(prompt).digest("hex");
  },

  getCachedPrompt: async (promptHash: string): Promise<string | null> => {
    const redis = getRedis();
    const key = versionedKey(CACHE_VERSION.AI, `ai:prompt:${promptHash}`);
    return redis.get(key);
  },

  setCachedPrompt: async (
    promptHash: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> => {
    const redis = getRedis();
    const key = versionedKey(CACHE_VERSION.AI, `ai:prompt:${promptHash}`);
    await redis.set(key, value, "EX", ttlSeconds);
  },

  // Task Breakdown cache methods (shared key omits userId & deadline)
  getTaskBreakdown: async (params: {
    userId: string;
    title: string;
    deadline?: Date;
    description?: string;
    totalMinutes?: number;
    profileKey?: string;
    model?: string;
  }): Promise<CachedTaskBreakdown | null> => {
    try {
      const redis = getRedis();
      const key = buildTaskBreakdownCacheKey(params);
      const cached = await redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as CachedTaskBreakdown;
    } catch {
      return null;
    }
  },

  setTaskBreakdown: async (
    params: {
      userId: string;
      title: string;
      deadline?: Date;
      description?: string;
      totalMinutes?: number;
      profileKey?: string;
      model?: string;
    },
    value: CachedTaskBreakdown,
    ttlSeconds: number = BREAKDOWN_CACHE_TTL_SECONDS,
  ): Promise<void> => {
    try {
      const redis = getRedis();
      const key = buildTaskBreakdownCacheKey(params);
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Silently fail - cache is best-effort
    }
  },

  // Priority Suggest cache methods
  getPrioritySuggest: async (params: {
    userId: string;
    title: string;
    deadline?: Date;
    model?: string;
  }): Promise<{ priority: string; reason?: string } | null> => {
    try {
      const redis = getRedis();
      const deadlinePart = params.deadline
        ? params.deadline.toISOString()
        : "no-deadline";
      const modelPart = params.model || "default";
      const titleHash = crypto
        .createHash("sha256")
        .update(params.title)
        .digest("hex")
        .slice(0, 16);
      const baseKey = `ai:priority-suggest:${params.userId}:${titleHash}:${deadlinePart}:${modelPart}`;
      const key = versionedKey(CACHE_VERSION.AI, baseKey);
      const cached = await redis.get(key);
      if (!cached) return null;
      return JSON.parse(cached) as { priority: string; reason?: string };
    } catch {
      return null;
    }
  },

  setPrioritySuggest: async (
    params: {
      userId: string;
      title: string;
      deadline?: Date;
      model?: string;
    },
    value: { priority: string; reason?: string },
    ttlSeconds: number = AI_CACHE_TTL_SECONDS,
  ): Promise<void> => {
    try {
      const redis = getRedis();
      const deadlinePart = params.deadline
        ? params.deadline.toISOString()
        : "no-deadline";
      const modelPart = params.model || "default";
      const titleHash = crypto
        .createHash("sha256")
        .update(params.title)
        .digest("hex")
        .slice(0, 16);
      const baseKey = `ai:priority-suggest:${params.userId}:${titleHash}:${deadlinePart}:${modelPart}`;
      const key = versionedKey(CACHE_VERSION.AI, baseKey);
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Silently fail - cache is best-effort
    }
  },

  getGuideReply: async (cacheKey: string): Promise<string | null> => {
    try {
      const redis = getRedis();
      const key = versionedKey(CACHE_VERSION.AI, `ai:guide:${cacheKey}`);
      return await redis.get(key);
    } catch {
      return null;
    }
  },

  setGuideReply: async (
    cacheKey: string,
    reply: string,
    ttlSeconds: number = 3600,
  ): Promise<void> => {
    try {
      const redis = getRedis();
      const key = versionedKey(CACHE_VERSION.AI, `ai:guide:${cacheKey}`);
      await redis.setex(key, ttlSeconds, reply);
    } catch {
      // Silently fail - cache is best-effort
    }
  },

  invalidateUserAiCache: async (userId: string): Promise<void> => {
    try {
      const redis = getRedis();
      const prefix = `ai:`;
      let cursor = "0";
      const keysToDelete: string[] = [];
      do {
        const [next, batch] = await redis.scan(
          cursor,
          "MATCH",
          `${prefix}*:${userId}:*`,
          "COUNT",
          100,
        );
        cursor = next;
        if (Array.isArray(batch)) {
          keysToDelete.push(...batch);
        }
      } while (cursor !== "0");

      if (keysToDelete.length) {
        await redis.del(...keysToDelete);
      }
    } catch {
      // Silently fail
    }
  },
};
