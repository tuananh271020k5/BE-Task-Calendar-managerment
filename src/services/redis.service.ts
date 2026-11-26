import Redis from "ioredis";

let redisClient: Redis | null = null;

const toBool = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
};

const getRedisOptions = () => {
  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT
    ? Number(process.env.REDIS_PORT)
    : undefined;
  const username = process.env.REDIS_USERNAME?.trim() || undefined;
  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  const tlsEnabled = toBool(process.env.REDIS_TLS, false);

  if (!host || !port) {
    throw new Error("Missing env REDIS_HOST/REDIS_PORT");
  }

  return {
    host,
    port,
    username,
    password,
    ...(tlsEnabled ? { tls: {} } : {}),
    keepAlive: 10000,
    connectTimeout: 10000,
    retryStrategy: (times: number) => Math.min(times * 200, 3000),
    maxRetriesPerRequest: null as any,
  };
};

export const getRedis = (): Redis => {
  if (redisClient) return redisClient;

  redisClient = new Redis(getRedisOptions());
  redisClient.on("error", (err) => {
    console.error("[Redis] Client error:", err.message);
  });
  return redisClient;
};

// Export config for BullMQ (needs plain object, not Redis instance)
export const getRedisConfig = () => {
  return getRedisOptions();
};

let bullMqSupportCache: { supported: boolean; version: string | null } | null =
  null;

export const supportsBullMQ = async (): Promise<{
  supported: boolean;
  version: string | null;
}> => {
  if (bullMqSupportCache) return bullMqSupportCache;
  try {
    const redis = getRedis();
    const info = await redis.info("server");
    const match = info.match(/redis_version:(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) {
      bullMqSupportCache = { supported: true, version: null };
      return bullMqSupportCache;
    }
    const major = Number(match[1]);
    const version = match[3]
      ? `${match[1]}.${match[2]}.${match[3]}`
      : `${match[1]}.${match[2]}`;
    bullMqSupportCache = { supported: major >= 5, version };
    return bullMqSupportCache;
  } catch {
    return { supported: false, version: null };
  }
};
