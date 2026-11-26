import { getRedis } from "../../../services/redis.service";
import { CACHE_VERSION, versionedKey } from "../../../config/cache-version";

export type InputGuardrailResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "PROMPT_INJECTION" | "INPUT_TOO_LONG";
      safeReply: string;
    };

export type OutputValidationResult = {
  content: string;
  flags: string[];
};

export type DailyQuotaStatus = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
};

export const ALLOWED_INTERNAL_ROUTES = new Set<string>([
  "/tasks",
  "/calendar",
  "/teams",
  "/notifications",
  "/profile",
  "/chat",
  "/guide",
]);

const getDailyTokenLimit = (): number => {
  const parsed = Number(process.env.AI_DAILY_TOKEN_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100_000;
};

const normalizeForGuardrail = (text: string): string =>
  text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(your|all|the)?\s*(system|previous|prior)?\s*(prompt|instructions?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?|prompts?)/i,
  /(reveal|show|print|dump|repeat|output|display)\s+(your|the|full|exact)?\s*(system\s*prompt|hidden\s*instructions?|developer\s*prompt)/i,
  /\bDAN\b[\s\S]{0,40}\bmode\b/i,
  /\bjailbreak\b/i,
  /bo\s+qua\s+(moi|tat\s+ca|cac|nhung)?\s*(huong\s+dan|chi\s+dan|quy\s+tac|lenh)\s*(truoc|o\s+tren|he\s+thong)/i,
  /(tiet\s+lo|in\s+ra|hien\s+thi|cho\s+xem|doc\s+lai)\s+(toan\s+bo\s+)?(system\s*prompt|prompt\s*he\s+thong|lenh\s*he\s+thong|chi\s+dan\s*an)/i,
  /tu\s+gio\s+ban\s+khong\s+con\s+la\s+taskmind/i,
];

const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
];

const PROMPT_LEAK_MARKERS: string[] = [
  "TÀI LIỆU HỆ THỐNG (Knowledge Base):",
  "SELF-CHECK BẮT BUỘC:",
];

const todayKeyDate = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getQuotaRedisKey = (userId: string): string =>
  versionedKey(CACHE_VERSION.AI, `ai:quota:daily:${userId}:${todayKeyDate()}`);

const canUseRedisFast = (): boolean => {
  if (process.env.AI_SKIP_REDIS === "true") return false;
  if (!process.env.REDIS_HOST || !process.env.REDIS_PORT) return false;
  return true;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  ms = 400,
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

export const aiGuardrailService = {
  checkInputGuardrail: (
    message: string,
    maxChars = 6000,
  ): InputGuardrailResult => {
    const text = String(message ?? "");
    if (text.length > maxChars) {
      return {
        allowed: false,
        reason: "INPUT_TOO_LONG",
        safeReply: `Tin nhắn quá dài (tối đa ${maxChars} ký tự). Bạn vui lòng rút gọn lại câu hỏi để mình hỗ trợ chính xác hơn nhé.`,
      };
    }

    const normalized = normalizeForGuardrail(text);
    const matched = PROMPT_INJECTION_PATTERNS.some(
      (re) => re.test(text) || re.test(normalized),
    );
    if (matched) {
      return {
        allowed: false,
        reason: "PROMPT_INJECTION",
        safeReply:
          "Xin lỗi, mình không thể bỏ qua quy tắc hệ thống hoặc tiết lộ cấu hình nội bộ. Mình có thể hỗ trợ bạn dùng TaskMind AI, sắp xếp lịch hoặc chia nhỏ công việc nhé.",
      };
    }

    return { allowed: true };
  },

  validateAndSanitizeOutput: (
    content: string,
    options?: { validateInternalRoutes?: boolean },
  ): OutputValidationResult => {
    let sanitized = String(content ?? "");
    const flags: string[] = [];

    for (const pattern of API_KEY_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(sanitized)) {
        flags.push("API_KEY_REDACTED");
        pattern.lastIndex = 0;
        sanitized = sanitized.replace(pattern, "[REDACTED_KEY]");
      }
    }

    for (const marker of PROMPT_LEAK_MARKERS) {
      const idx = sanitized.indexOf(marker);
      if (idx !== -1) {
        flags.push("PROMPT_LEAK_STRIPPED");
        sanitized = sanitized.slice(0, idx).trim();
      }
    }

    if (options?.validateInternalRoutes) {
      let strippedRoutes = false;
      sanitized = sanitized.replace(
        /\[([^\]]+)\]\((\/[^)\s]*)\)/g,
        (full, label: string, rawRoute: string) => {
          const cleanPath = rawRoute.split(/[?#]/)[0].trim();
          const normalizedPath =
            cleanPath.length > 1 ? cleanPath.replace(/\/+$/, "") : cleanPath;
          if (ALLOWED_INTERNAL_ROUTES.has(normalizedPath)) {
            return full;
          }
          strippedRoutes = true;
          return `**${label}**`;
        },
      );
      if (strippedRoutes) {
        flags.push("INVALID_ROUTE_STRIPPED");
      }
    }

    return { content: sanitized, flags };
  },

  checkDailyQuota: async (userId: string): Promise<DailyQuotaStatus> => {
    const limit = getDailyTokenLimit();
    if (!canUseRedisFast() || !userId) {
      return { allowed: true, used: 0, limit, remaining: limit };
    }
    try {
      const redis = getRedis();
      if (redis.status !== "ready" && redis.status !== "connect") {
        // Attempt short-bounded read; if Redis is down, fail-open quickly
        const raw = await withTimeout(redis.get(getQuotaRedisKey(userId)), 350);
        const used = raw ? Math.max(0, Number(raw) || 0) : 0;
        return {
          allowed: used < limit,
          used,
          limit,
          remaining: Math.max(0, limit - used),
        };
      }
      const raw = await withTimeout(redis.get(getQuotaRedisKey(userId)), 400);
      const used = raw ? Math.max(0, Number(raw) || 0) : 0;
      return {
        allowed: used < limit,
        used,
        limit,
        remaining: Math.max(0, limit - used),
      };
    } catch {
      return { allowed: true, used: 0, limit, remaining: limit };
    }
  },

  recordDailyTokens: async (userId: string, tokens: number): Promise<void> => {
    const delta = Math.floor(Number(tokens) || 0);
    if (delta <= 0 || !userId || !canUseRedisFast()) return;
    try {
      const redis = getRedis();
      const key = getQuotaRedisKey(userId);
      const next = await withTimeout(redis.incrby(key, delta), 400);
      if (next !== null) {
        await withTimeout(redis.expire(key, 172_800), 300);
      }
    } catch {
      // Best-effort telemetry; never block request
    }
  },

  getDailyQuotaStatus: async (userId: string): Promise<DailyQuotaStatus> => {
    return aiGuardrailService.checkDailyQuota(userId);
  },
};
