import mongoose, { Types } from "mongoose";
import {
  AiUsageLog,
  type AiUsageFeature,
  type AiUsageStatus,
} from "./ai-usage-log.model";
import {
  aiGuardrailService,
  type DailyQuotaStatus,
} from "./agents/ai-guardrails.service";

export type RecordUsageInput = {
  userId: string;
  conversationId?: string;
  feature: AiUsageFeature;
  route?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  cacheHit?: boolean;
  guardrailTriggered?: string;
  status?: AiUsageStatus;
  errorCode?: string;
  meta?: Record<string, unknown>;
};

export type UsageSummaryResult = {
  days: number;
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  cacheHits: number;
  cacheHitRate: number;
  blockedRequests: number;
  errorRequests: number;
  avgLatencyMs: number;
  byFeature: {
    feature: string;
    requests: number;
    tokens: number;
    cacheHits: number;
    avgLatencyMs: number;
  }[];
  byRoute: {
    route: string;
    requests: number;
    tokens: number;
  }[];
  dailyQuota: DailyQuotaStatus;
};

export const inferProviderFromModel = (
  model?: string,
  cacheHit?: boolean,
): string => {
  if (cacheHit) return "cache";
  const m = String(model ?? "").toLowerCase().trim();
  if (!m) return "unknown";
  if (m.startsWith("cache:")) return "cache";
  if (m.startsWith("router:")) return "router";
  if (m.startsWith("template:")) return "template";
  if (m.startsWith("guardrail:")) return "guardrail";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("text-embedding")) {
    return "openai";
  }
  if (m.includes("gemini")) return "gemini";
  if (m.includes("llama") || m.includes("mixtral") || m.includes("groq") || m.includes("oss")) {
    return "groq";
  }
  return "unknown";
};

export const estimateCostUsd = (
  model?: string,
  promptTokens = 0,
  completionTokens = 0,
): number => {
  const m = String(model ?? "").toLowerCase().trim();
  if (
    !m ||
    m.startsWith("cache:") ||
    m.startsWith("router:") ||
    m.startsWith("template:") ||
    m.startsWith("guardrail:")
  ) {
    return 0;
  }

  let inputPerMillion = 0.15;
  let outputPerMillion = 0.6;

  if (m.includes("gpt-4o-mini")) {
    inputPerMillion = 0.15;
    outputPerMillion = 0.6;
  } else if (m.includes("gpt-4o")) {
    inputPerMillion = 2.5;
    outputPerMillion = 10.0;
  } else if (m.includes("gemini-2.5-flash") || m.includes("gemini-2.0-flash")) {
    inputPerMillion = 0.15;
    outputPerMillion = 0.6;
  } else if (m.includes("llama-3.1-8b")) {
    inputPerMillion = 0.05;
    outputPerMillion = 0.08;
  } else if (m.includes("text-embedding-3-small")) {
    inputPerMillion = 0.02;
    outputPerMillion = 0;
  }

  const cost =
    (Math.max(0, promptTokens) / 1_000_000) * inputPerMillion +
    (Math.max(0, completionTokens) / 1_000_000) * outputPerMillion;
  return Number(cost.toFixed(8));
};

export const aiUsageService = {
  recordUsage: async (input: RecordUsageInput): Promise<void> => {
    try {
      const promptTokens = Math.max(0, Number(input.promptTokens ?? 0) || 0);
      const completionTokens = Math.max(
        0,
        Number(input.completionTokens ?? 0) || 0,
      );
      const totalTokens = Math.max(
        0,
        Number(input.totalTokens ?? promptTokens + completionTokens) || 0,
      );
      const provider =
        input.provider || inferProviderFromModel(input.model, input.cacheHit);
      const estimatedCostUsd = estimateCostUsd(
        input.model,
        promptTokens,
        completionTokens,
      );

      if (totalTokens > 0 && Types.ObjectId.isValid(input.userId)) {
        await aiGuardrailService.recordDailyTokens(input.userId, totalTokens);
      }

      if (
        mongoose.connection.readyState !== 1 ||
        !Types.ObjectId.isValid(input.userId)
      ) {
        return;
      }

      await AiUsageLog.create({
        userId: new Types.ObjectId(input.userId),
        conversationId:
          input.conversationId && Types.ObjectId.isValid(input.conversationId)
            ? new Types.ObjectId(input.conversationId)
            : undefined,
        feature: input.feature,
        route: input.route,
        model: input.model,
        provider,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        latencyMs: Math.max(0, Math.round(Number(input.latencyMs ?? 0) || 0)),
        cacheHit: !!input.cacheHit,
        guardrailTriggered: input.guardrailTriggered,
        status: input.status ?? "ok",
        errorCode: input.errorCode,
        meta: input.meta,
      });
    } catch {
      // Telemetry must never crash or slow down user flows
    }
  },

  getUserUsageSummary: async (
    userId: string,
    daysInput = 7,
  ): Promise<UsageSummaryResult> => {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error("USER_ID_INVALID");
    }
    const days = Math.min(Math.max(Math.floor(Number(daysInput) || 7), 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const userObjectId = new Types.ObjectId(userId);

    const dailyQuota = await aiGuardrailService.getDailyQuotaStatus(userId);

    if (mongoose.connection.readyState !== 1) {
      return {
        days,
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostUsd: 0,
        cacheHits: 0,
        cacheHitRate: 0,
        blockedRequests: 0,
        errorRequests: 0,
        avgLatencyMs: 0,
        byFeature: [],
        byRoute: [],
        dailyQuota,
      };
    }

    const matchStage = {
      userId: userObjectId,
      createdAt: { $gte: since },
    };

    const [totalsAgg, byFeatureAgg, byRouteAgg] = await Promise.all([
      AiUsageLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalTokens: { $sum: "$totalTokens" },
            promptTokens: { $sum: "$promptTokens" },
            completionTokens: { $sum: "$completionTokens" },
            estimatedCostUsd: { $sum: "$estimatedCostUsd" },
            cacheHits: { $sum: { $cond: ["$cacheHit", 1, 0] } },
            blockedRequests: {
              $sum: { $cond: [{ $eq: ["$status", "blocked"] }, 1, 0] },
            },
            errorRequests: {
              $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
            },
            avgLatencyMs: { $avg: "$latencyMs" },
          },
        },
      ]),
      AiUsageLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: "$feature",
            requests: { $sum: 1 },
            tokens: { $sum: "$totalTokens" },
            cacheHits: { $sum: { $cond: ["$cacheHit", 1, 0] } },
            avgLatencyMs: { $avg: "$latencyMs" },
          },
        },
        { $sort: { requests: -1 } },
      ]),
      AiUsageLog.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: { $ifNull: ["$route", "UNKNOWN"] },
            requests: { $sum: 1 },
            tokens: { $sum: "$totalTokens" },
          },
        },
        { $sort: { requests: -1 } },
      ]),
    ]);

    const t = totalsAgg[0] || {};
    const totalRequests = Number(t.totalRequests ?? 0);
    const cacheHits = Number(t.cacheHits ?? 0);

    return {
      days,
      totalRequests,
      totalTokens: Number(t.totalTokens ?? 0),
      promptTokens: Number(t.promptTokens ?? 0),
      completionTokens: Number(t.completionTokens ?? 0),
      estimatedCostUsd: Number(Number(t.estimatedCostUsd ?? 0).toFixed(6)),
      cacheHits,
      cacheHitRate:
        totalRequests > 0
          ? Number((cacheHits / totalRequests).toFixed(4))
          : 0,
      blockedRequests: Number(t.blockedRequests ?? 0),
      errorRequests: Number(t.errorRequests ?? 0),
      avgLatencyMs: Math.round(Number(t.avgLatencyMs ?? 0)),
      byFeature: byFeatureAgg.map((f: any) => ({
        feature: String(f._id),
        requests: Number(f.requests ?? 0),
        tokens: Number(f.tokens ?? 0),
        cacheHits: Number(f.cacheHits ?? 0),
        avgLatencyMs: Math.round(Number(f.avgLatencyMs ?? 0)),
      })),
      byRoute: byRouteAgg.map((r: any) => ({
        route: String(r._id),
        requests: Number(r.requests ?? 0),
        tokens: Number(r.tokens ?? 0),
      })),
      dailyQuota,
    };
  },
};
