import { aiProvider, type AiChatMessage } from "../ai.provider";
import { aiCacheService } from "../ai.cache.service";
import type { Lang } from "../ai-intent";
import { aiGuardrailService } from "./ai-guardrails.service";
import {
  kbRetriever,
  normalizeKbText,
  type KbModule,
  type KbSearchResult,
} from "./kb-retriever.service";

export type GuideAgentParams = {
  userId?: string;
  message: string;
  userLang: Lang;
  currentPage?: string;
  kbModule?: KbModule;
  historyForAI: { role: "user" | "assistant"; content: string }[];
  model?: string;
  maxTokens?: number;
};

export type GuideAgentResult = {
  content: string;
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  cached?: boolean;
  retrievalMode?: string;
  kbChunksUsed?: number;
  guardrailFlags?: string[];
};

const formatKbSnippets = (results: KbSearchResult[]): string => {
  if (!results.length) {
    return "(Không tìm thấy mục nào khớp trong Knowledge Base.)";
  }
  return results
    .map(
      (r, idx) =>
        `[${idx + 1}] (${r.chunk.module} - route ${r.chunk.route}) ${r.chunk.title}\n${r.chunk.content}`,
    )
    .join("\n\n");
};

const buildGuideSystemPrompt = (params: {
  userLang: Lang;
  currentPage?: string;
  kbResults: KbSearchResult[];
}): string => {
  const replyLang = params.userLang === "en" ? "English" : "Vietnamese";
  const pageHint = params.currentPage
    ? `Trang người dùng đang mở: ${params.currentPage}`
    : "Trang người dùng đang mở: chưa rõ";

  return `Bạn là Chuyên viên Hướng dẫn & Chăm sóc người dùng của ứng dụng TaskMind AI.
${pageHint}
Ngôn ngữ trả lời: ${replyLang}.

NHIỆM VỤ & QUY TẮC:
1. Chỉ hướng dẫn dựa trên TÀI LIỆU HỆ THỐNG dưới đây, KHÔNG bịa tên nút hay tính năng không có trong tài liệu.
2. Trả lời ngắn gọn, thân thiện, chia từng bước đánh số rõ ràng. In đậm tên nút/thao tác (ví dụ: **+ Thêm công việc**, **AI Tối ưu Lịch**).
3. Chèn link nội bộ dạng Markdown đúng route từ tài liệu (ví dụ: [Mở trang Công việc](/tasks), [Mở trang Lịch](/calendar), [Mở trang Nhóm](/teams), [Mở trang Thông báo](/notifications), [Mở Hồ sơ](/profile)) để người dùng bấm tới ngay.
4. Nếu người dùng **báo lỗi, gặp sự cố hoặc hỏi tính năng không có trong tài liệu**: nói rõ tài liệu chưa bao phủ, hỏi ngắn 2–3 thông tin còn thiếu (trang bị lỗi, thao tác vừa làm, thông báo lỗi) và xuất bảng Markdown tóm tắt phiếu hỗ trợ 4 dòng: | Mục | Nội dung | (Loại, Trang/Tính năng, Mô tả lỗi, Thao tác đã thử).

TÀI LIỆU HỆ THỐNG (Knowledge Base):
${formatKbSnippets(params.kbResults)}`;
};

export const guideAgent = {
  run: async (params: GuideAgentParams): Promise<GuideAgentResult> => {
    const isStandalone = params.historyForAI.length === 0;
    const cacheKey = isStandalone
      ? aiCacheService.buildPromptHash(
          `guide:v1:${params.userLang}:${params.kbModule || "all"}:${normalizeKbText(params.message)}`,
        )
      : null;

    if (cacheKey) {
      const cached = await aiCacheService.getGuideReply(cacheKey);
      if (cached) {
        return {
          content: cached,
          model: "cache:guide",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cached: true,
          retrievalMode: "cache",
          kbChunksUsed: 0,
        };
      }
    }

    if (params.userId) {
      const quota = await aiGuardrailService.checkDailyQuota(params.userId);
      if (!quota.allowed) {
        throw new Error("AI_DAILY_QUOTA_EXCEEDED");
      }
    }

    const { results: kbResults, mode: retrievalMode } =
      await kbRetriever.searchKbHybrid(params.message, {
        module: params.kbModule,
        topK: 3,
      });

    const systemPrompt = buildGuideSystemPrompt({
      userLang: params.userLang,
      currentPage: params.currentPage,
      kbResults,
    });

    const messages: AiChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...params.historyForAI.map(
        (m) => ({ role: m.role, content: m.content }) as AiChatMessage,
      ),
      { role: "user", content: params.message },
    ];

    const res = await aiProvider.chat({
      purpose: "chat",
      messages,
      model: params.model,
      temperature: 0.2,
      maxTokens: params.maxTokens ?? 600,
    });

    const sanitized = aiGuardrailService.validateAndSanitizeOutput(res.content, {
      validateInternalRoutes: true,
    });

    if (cacheKey && sanitized.content.trim()) {
      await aiCacheService.setGuideReply(cacheKey, sanitized.content, 3600);
    }

    return {
      content: sanitized.content,
      model: res.model,
      usage: res.usage,
      cached: false,
      retrievalMode,
      kbChunksUsed: kbResults.length,
      guardrailFlags: sanitized.flags,
    };
  },
};
