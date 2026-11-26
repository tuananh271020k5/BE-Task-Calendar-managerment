import crypto from "crypto";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRedis } from "../../../services/redis.service";
import { CACHE_VERSION, versionedKey } from "../../../config/cache-version";

export type EmbeddingProvider = "openai" | "gemini" | "local";

export type EmbedTextsResult = {
  vectors: number[][];
  provider: EmbeddingProvider;
  model: string;
};

const LOCAL_DIMS = 256;
const KB_EMB_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const QUERY_EMB_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const QUERY_MEM_CAP = 200;

const kbEmbeddingCache = new Map<string, EmbedTextsResult>();
const queryEmbeddingCache = new Map<
  string,
  { vector: number[]; provider: EmbeddingProvider }
>();

const canUseRedisFast = (): boolean => {
  if (process.env.AI_SKIP_REDIS === "true") return false;
  if (!process.env.REDIS_HOST || !process.env.REDIS_PORT) return false;
  return true;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  ms = 500,
): Promise<T | null> => {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
};

const normalizeEmbeddingText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fnv1aHash = (str: string, seed = 2166136261): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};

const l2Normalize = (vec: number[]): number[] => {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm <= 1e-12) return vec;
  return vec.map((v) => v / norm);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom <= 1e-12 ? 0 : dot / denom;
};

export const buildLocalCharNgramEmbedding = (
  text: string,
  dims = LOCAL_DIMS,
): number[] => {
  const vec = new Array<number>(dims).fill(0);
  const normalized = normalizeEmbeddingText(text);
  if (!normalized) return vec;

  const addFeature = (feat: string, weight: number) => {
    const h1 = fnv1aHash(feat, 2166136261);
    const h2 = fnv1aHash(feat, 33554467);
    const idx = h1 % dims;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  // Word-level features
  const words = normalized.split(/[\s/_-]+/).filter((w) => w.length >= 2);
  for (const w of words) {
    addFeature(`w:${w}`, 1.5);
  }

  // Character 3-grams and 4-grams
  const padded = ` ${normalized} `;
  for (let i = 0; i <= padded.length - 3; i++) {
    const g3 = padded.slice(i, i + 3);
    if (g3.trim().length >= 2) {
      addFeature(`c3:${g3}`, 1.0);
    }
  }
  for (let i = 0; i <= padded.length - 4; i++) {
    const g4 = padded.slice(i, i + 4);
    if (g4.trim().length >= 2) {
      addFeature(`c4:${g4}`, 0.8);
    }
  }

  return l2Normalize(vec);
};

const embedWithOpenAI = async (texts: string[]): Promise<EmbedTextsResult> => {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

  const client = new OpenAI({ apiKey });
  const model = (
    process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small"
  ).trim();

  const res = await client.embeddings.create({
    model,
    input: texts,
    dimensions: LOCAL_DIMS,
  });

  const sorted = [...res.data].sort((a, b) => a.index - b.index);
  return {
    vectors: sorted.map((d) => d.embedding),
    provider: "openai",
    model,
  };
};

const embedWithGemini = async (texts: string[]): Promise<EmbedTextsResult> => {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const candidates = Array.from(
    new Set([
      ...(process.env.GEMINI_EMBEDDING_MODEL
        ? [process.env.GEMINI_EMBEDDING_MODEL.trim()]
        : []),
      "gemini-embedding-001",
      "text-embedding-004",
    ]),
  );

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastErr: unknown;

  for (const modelName of candidates) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const vectors: number[][] = [];
      for (const text of texts) {
        const res = await model.embedContent(text);
        vectors.push(res.embedding.values);
      }
      return {
        vectors,
        provider: "gemini",
        model: modelName,
      };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr ?? new Error("GEMINI_EMBEDDING_FAILED");
};

const embedWithLocal = (texts: string[]): EmbedTextsResult => ({
  vectors: texts.map((t) => buildLocalCharNgramEmbedding(t, LOCAL_DIMS)),
  provider: "local",
  model: "local:char-ngram-256",
});

const rememberQueryCache = (
  key: string,
  value: { vector: number[]; provider: EmbeddingProvider },
) => {
  if (queryEmbeddingCache.size >= QUERY_MEM_CAP) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest) queryEmbeddingCache.delete(oldest);
  }
  queryEmbeddingCache.set(key, value);
};

export const embeddingService = {
  embedTexts: async (texts: string[]): Promise<EmbedTextsResult> => {
    if (!texts.length) {
      return { vectors: [], provider: "local", model: "local:char-ngram-256" };
    }

    if (process.env.AI_EMBEDDING_DISABLED === "true") {
      return embedWithLocal(texts);
    }

    if ((process.env.OPENAI_API_KEY || "").trim()) {
      try {
        return await embedWithOpenAI(texts);
      } catch (err: any) {
        console.warn(
          `[embeddingService] OpenAI embedding failed (${err?.message || "UNKNOWN"}), falling back.`,
        );
      }
    }

    if ((process.env.GEMINI_API_KEY || "").trim()) {
      try {
        return await embedWithGemini(texts);
      } catch (err: any) {
        console.warn(
          `[embeddingService] Gemini embedding failed (${err?.message || "UNKNOWN"}), falling back.`,
        );
      }
    }

    return embedWithLocal(texts);
  },

  getOrComputeKbEmbeddings: async (
    kbHash: string,
    texts: string[],
  ): Promise<EmbedTextsResult> => {
    const memKey =
      process.env.AI_EMBEDDING_DISABLED === "true"
        ? `disabled:${kbHash}`
        : `live:${kbHash}`;
    const memHit = kbEmbeddingCache.get(memKey);
    if (memHit && memHit.vectors.length === texts.length) {
      return memHit;
    }

    if (
      process.env.AI_EMBEDDING_DISABLED !== "true" &&
      canUseRedisFast()
    ) {
      try {
        const redis = getRedis();
        const redisKey = versionedKey(
          CACHE_VERSION.AI,
          `ai:kb:emb:${kbHash}`,
        );
        const raw = await withTimeout(redis.get(redisKey), 500);
        if (raw) {
          const parsed = JSON.parse(raw) as EmbedTextsResult;
          if (
            Array.isArray(parsed?.vectors) &&
            parsed.vectors.length === texts.length
          ) {
            kbEmbeddingCache.set(memKey, parsed);
            return parsed;
          }
        }
      } catch {
        // Fallback to computing
      }
    }

    const computed = await embeddingService.embedTexts(texts);
    kbEmbeddingCache.set(memKey, computed);

    if (computed.provider !== "local" && canUseRedisFast()) {
      try {
        const redis = getRedis();
        const redisKey = versionedKey(
          CACHE_VERSION.AI,
          `ai:kb:emb:${kbHash}`,
        );
        await withTimeout(
          redis.setex(redisKey, KB_EMB_TTL_SECONDS, JSON.stringify(computed)),
          500,
        );
      } catch {
        // Best-effort cache write
      }
    }

    return computed;
  },

  getOrComputeQueryEmbedding: async (
    query: string,
    preferredProvider: EmbeddingProvider,
  ): Promise<number[] | null> => {
    const trimmed = String(query ?? "").trim();
    if (!trimmed) return null;

    if (
      preferredProvider === "local" ||
      process.env.AI_EMBEDDING_DISABLED === "true"
    ) {
      return preferredProvider === "local"
        ? buildLocalCharNgramEmbedding(trimmed, LOCAL_DIMS)
        : null;
    }

    const qHash = crypto
      .createHash("sha256")
      .update(trimmed.toLowerCase())
      .digest("hex")
      .slice(0, 20);
    const cacheKey = `${preferredProvider}:${qHash}`;
    const memHit = queryEmbeddingCache.get(cacheKey);
    if (memHit) return memHit.vector;

    if (canUseRedisFast()) {
      try {
        const redis = getRedis();
        const redisKey = versionedKey(
          CACHE_VERSION.AI,
          `ai:emb:q:${preferredProvider}:${qHash}`,
        );
        const raw = await withTimeout(redis.get(redisKey), 400);
        if (raw) {
          const vec = JSON.parse(raw) as number[];
          if (Array.isArray(vec) && vec.length > 0) {
            rememberQueryCache(cacheKey, {
              vector: vec,
              provider: preferredProvider,
            });
            return vec;
          }
        }
      } catch {
        // Continue to compute
      }
    }

    try {
      const res =
        preferredProvider === "openai"
          ? await embedWithOpenAI([trimmed])
          : await embedWithGemini([trimmed]);
      const vec = res.vectors[0];
      if (!vec?.length) return null;

      rememberQueryCache(cacheKey, { vector: vec, provider: preferredProvider });

      if (canUseRedisFast()) {
        try {
          const redis = getRedis();
          const redisKey = versionedKey(
            CACHE_VERSION.AI,
            `ai:emb:q:${preferredProvider}:${qHash}`,
          );
          await withTimeout(
            redis.setex(redisKey, QUERY_EMB_TTL_SECONDS, JSON.stringify(vec)),
            400,
          );
        } catch {
          // Best-effort
        }
      }

      return vec;
    } catch (err: any) {
      console.warn(
        `[embeddingService] Query embedding failed for ${preferredProvider} (${err?.message || "UNKNOWN"}), falling back to BM25.`,
      );
      return null;
    }
  },

  clearCache: (): void => {
    kbEmbeddingCache.clear();
    queryEmbeddingCache.clear();
  },
};
