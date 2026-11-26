/**
 * ai-chat.service.ts
 * -------------------
 * Thin orchestrator for the AI chat feature. Heavy logic has been extracted:
 *   - ai-chat-helpers.ts  → types, pure functions, debug logging
 *   - ai-chat-draft.ts    → proposal-draft merging
 *   - ai-chat-calendar.ts → fast-path, model tool-loop, forced-commit
 *
 * This file wires together context loading, intent detection, prompt
 * building, and delegates to the appropriate handler.
 */

import { Types } from "mongoose";
import { aiProvider, AiChatStreamEvent, AiChatMessage } from "./ai.provider";
import { aiRepository } from "./ai.repository";
import {
  PublicAiConversation,
  PublicAiMessage,
  toPublicConversation,
  toPublicMessage,
} from "./ai.mapper";
import {
  detectUserLanguage,
  resolveTargetLanguage,
  buildSystemPrompt,
} from "./ai-intent";
import { routeChatMessage } from "./agents/agent-router";
import { guideAgent } from "./agents/guide.agent";
import { aiGuardrailService } from "./agents/ai-guardrails.service";
import { aiUsageService } from "./ai-usage.service";
import {
  buildDiscussedSubtasks,
  computePendingSlots,
  detectDomainFromTask,
  toMemoryHints,
} from "./ai-context";
import { userMemoryService } from "./user-memory.service";
import {
  shortUser,
  isCommitConfirmationMessage,
  ensureAssistantContent,
  FALLBACK_ASSISTANT_REPLY,
  resolveConversation,
  type ChatInput,
} from "./ai-chat-helpers";
import { handleCalendarIntent } from "./ai-chat-calendar";
import { aiCalendarContextService } from "./ai-calendar-context.service";

export const aiChatService = {
  /**
   * Main non-streaming chat endpoint.
   * Routes via Hybrid Router → 0-token greeting, Guide Agent (BM25 + cache),
   * Calendar Agent, or Tutor/General LLM without stuffing unused context.
   */
  chat: async (
    userId: string,
    input: ChatInput,
  ): Promise<{
    reply: string;
    conversationId: string;
    model?: string;
    tasksCreated?: number;
    cached?: boolean;
    route?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  }> => {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error("USER_ID_INVALID");
    }
    const startedAt = Date.now();
    const userObjectId = new Types.ObjectId(userId);

    const { id: conversationObjectId, lastSubtaskKey } =
      await resolveConversation(userObjectId, input);

    // ── Input Guardrail (length & prompt injection) ──────────────────
    const inputCheck = aiGuardrailService.checkInputGuardrail(input.message);
    if (!inputCheck.allowed) {
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "user",
        content: input.message.slice(0, 6000),
      });
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "assistant",
        content: inputCheck.safeReply,
        tokens: 0,
      });
      await aiRepository.touchConversationUpdatedAt({
        conversationId: conversationObjectId,
        userId: userObjectId,
      });
      await aiUsageService.recordUsage({
        userId,
        conversationId: String(conversationObjectId),
        feature: "chat",
        route: "GUARDRAIL_BLOCKED",
        model: "guardrail:input",
        provider: "guardrail",
        cacheHit: false,
        guardrailTriggered: inputCheck.reason,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
      });
      return {
        reply: inputCheck.safeReply,
        conversationId: String(conversationObjectId),
        model: "guardrail:input",
        route: "GUARDRAIL_BLOCKED",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // ── Load conversation history once ───────────────────────────────
    const historyMessages = await aiRepository.listMessagesByConversation({
      conversationId: conversationObjectId,
      userId: userObjectId,
      limit: 40,
    });

    // ── Detect subtask transition ────────────────────────────────────
    const currentSubtaskKey = input.subtaskContext?.subtaskKey;
    const isSubtaskTransition =
      !!currentSubtaskKey &&
      !!lastSubtaskKey &&
      currentSubtaskKey !== lastSubtaskKey;

    if (isSubtaskTransition && input.subtaskContext?.subtaskTitle) {
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "system",
        content: `[TRANSITION] Người dùng chuyển sang nhiệm vụ: "${input.subtaskContext.subtaskTitle}"`,
        meta: {
          kind: "transition",
          subtaskKey: currentSubtaskKey,
          subtaskTitle: input.subtaskContext.subtaskTitle,
          subtaskIndex: input.subtaskContext.subtaskIndex,
        },
      });
    }

    // ── Save user message ────────────────────────────────────────────
    await aiRepository.createMessage({
      conversationId: conversationObjectId,
      userId: userObjectId,
      role: "user",
      content: input.message,
      meta: currentSubtaskKey
        ? {
            kind: "chat",
            subtaskKey: currentSubtaskKey,
            subtaskTitle: input.subtaskContext?.subtaskTitle,
            subtaskIndex: input.subtaskContext?.subtaskIndex,
          }
        : undefined,
    });

    // ── Check pending draft only when message looks like confirmation ─
    let hasPendingDraft = false;
    if (isCommitConfirmationMessage(input.message)) {
      try {
        const convDoc = await aiRepository.findConversationByIdForUser({
          conversationId: conversationObjectId,
          userId: userObjectId,
        });
        const pendingDraft = (convDoc as any)?.context?.proposalDraft;
        hasPendingDraft =
          !!pendingDraft &&
          (Array.isArray(pendingDraft.items)
            ? pendingDraft.items.length > 0
            : Array.isArray(pendingDraft.sessions) &&
              pendingDraft.sessions.length > 0);
      } catch {
        hasPendingDraft = false;
      }
    }

    // ── Hybrid Router (0 token) ──────────────────────────────────────
    const decision = routeChatMessage({
      message: input.message,
      currentPage: input.currentPage,
      hasSubtaskContext: !!input.subtaskContext,
      hasPendingDraft,
    });

    const userLang = detectUserLanguage(input.message);
    const targetLang = resolveTargetLanguage(input.subtaskContext);

    // ── Prepare compact LLM history ──────────────────────────────────
    const HISTORY_TURN_CAP = 8;
    const PER_MSG_CHAR_CAP = 1000;
    const historyForAI = historyMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-HISTORY_TURN_CAP)
      .map((m) => ({
        role:
          m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content:
          m.content.length > PER_MSG_CHAR_CAP
            ? `${m.content.slice(0, PER_MSG_CHAR_CAP)}…`
            : m.content,
      }));

    // ── Fast 0-token GREETING branch ─────────────────────────────────
    if (decision.route === "GREETING" && decision.quickReply && !input.systemPrompt) {
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "assistant",
        content: decision.quickReply,
        tokens: 0,
      });
      await aiRepository.touchConversationUpdatedAt({
        conversationId: conversationObjectId,
        userId: userObjectId,
      });
      await aiUsageService.recordUsage({
        userId,
        conversationId: String(conversationObjectId),
        feature: "chat",
        route: decision.route,
        model: "router:quick-reply",
        provider: "router",
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        status: "ok",
      });
      return {
        reply: decision.quickReply,
        conversationId: String(conversationObjectId),
        model: "router:quick-reply",
        route: decision.route,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // ── Dispatch to specialist agent or LLM ──────────────────────────
    let result: {
      content: string;
      model?: string;
      usage?: any;
      cached?: boolean;
      retrievalMode?: string;
      kbChunksUsed?: number;
      guardrailFlags?: string[];
    } = {
      content: FALLBACK_ASSISTANT_REPLY,
      model: undefined,
      usage: undefined,
    };
    let tasksCreatedCount = 0;

    const domain = detectDomainFromTask({
      parentTaskTitle: input.subtaskContext?.parentTaskTitle,
      parentTaskDescription: input.subtaskContext?.parentTaskDescription,
      subtaskTitle: input.subtaskContext?.subtaskTitle,
      subtaskDescription: input.subtaskContext?.description,
    });

    try {
      if (decision.route === "APP_GUIDE" && !input.systemPrompt) {
        result = await guideAgent.run({
          userId,
          message: input.message,
          userLang,
          currentPage: input.currentPage,
          kbModule: decision.kbModule,
          historyForAI,
          model: input.model,
          maxTokens: input.maxTokens,
        });
      } else {
        const quota = await aiGuardrailService.checkDailyQuota(userId);
        if (!quota.allowed) {
          throw new Error("AI_DAILY_QUOTA_EXCEEDED");
        }

        const shouldLoadMemories = !!(domain || input.subtaskContext);
        const memories = shouldLoadMemories
          ? await userMemoryService.loadRelevantMemories(userObjectId, domain, 12)
          : [];

        const discussedSubtasks = input.subtaskContext
          ? buildDiscussedSubtasks(historyMessages)
          : [];
        const pendingSlots = shouldLoadMemories
          ? computePendingSlots({
              domain,
              memories,
              history: historyMessages,
            })
          : [];

        // Only load 7-day calendar context for CALENDAR_TASK!
        const calendarContext =
          decision.route === "CALENDAR_TASK"
            ? await aiCalendarContextService
                .getAIOrchestratorContext(userId)
                .catch(() => "")
            : "";

        const systemContent = buildSystemPrompt({
          userLang,
          targetLang,
          intent: decision.subIntent,
          subtaskContext: input.subtaskContext,
          customSystemPrompt: input.systemPrompt,
          memoryHints: toMemoryHints(memories),
          discussedSubtasks,
          pendingSlots,
          calendarContext,
        });

        const fewShot =
          historyForAI.length === 0 && input.fewShotMessages?.length
            ? input.fewShotMessages.map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              }))
            : [];

        const baseMessages: AiChatMessage[] = [
          { role: "system", content: systemContent },
          ...fewShot.map(
            (m) => ({ role: m.role, content: m.content }) as AiChatMessage,
          ),
          ...historyForAI.map(
            (m) => ({ role: m.role, content: m.content }) as AiChatMessage,
          ),
          { role: "user", content: input.message },
        ];

        if (decision.route === "CALENDAR_TASK") {
          const calResult = await handleCalendarIntent({
            userId,
            userObjectId,
            conversationObjectId,
            domain,
            currentSubtaskKey,
            input,
            baseMessages,
            historyForAILength: historyForAI.length,
          });
          result = {
            content: calResult.content,
            model: calResult.model,
            usage: calResult.usage,
          };
          tasksCreatedCount = calResult.tasksCreatedCount;
        } else {
          result = await aiProvider.chat({
            purpose: "chat",
            messages: baseMessages,
            model: input.model,
            temperature:
              decision.subIntent === "EXERCISE" ||
              decision.subIntent === "CHECK_ANSWER"
                ? 0.2
                : 0.4,
            maxTokens: input.maxTokens,
          });
        }
      }
    } catch (err) {
      const errCode = err instanceof Error ? err.message : "UNKNOWN";
      const isQuotaBlocked = errCode === "AI_DAILY_QUOTA_EXCEEDED";
      await aiUsageService.recordUsage({
        userId,
        conversationId: String(conversationObjectId),
        feature: "chat",
        route: decision.route,
        model: result.model,
        latencyMs: Date.now() - startedAt,
        status: isQuotaBlocked ? "blocked" : "error",
        guardrailTriggered: isQuotaBlocked ? "QUOTA_EXCEEDED" : undefined,
        errorCode: isQuotaBlocked ? undefined : errCode,
        meta: { subIntent: decision.subIntent },
      });
      throw err;
    }

    // ── Output Guardrail + Persist assistant reply ───────────────────
    const rawAssistantContent = ensureAssistantContent(result.content);
    const sanitizedOutput = aiGuardrailService.validateAndSanitizeOutput(
      rawAssistantContent,
      { validateInternalRoutes: decision.route === "APP_GUIDE" },
    );
    const finalAssistantContent = ensureAssistantContent(sanitizedOutput.content);
    const guardrailFlags = Array.from(
      new Set([...(result.guardrailFlags ?? []), ...sanitizedOutput.flags]),
    );

    await aiRepository.createMessage({
      conversationId: conversationObjectId,
      userId: userObjectId,
      role: "assistant",
      content: finalAssistantContent,
      tokens: result.usage?.totalTokens,
      meta: currentSubtaskKey
        ? {
            kind: "chat",
            subtaskKey: currentSubtaskKey,
            subtaskTitle: input.subtaskContext?.subtaskTitle,
            subtaskIndex: input.subtaskContext?.subtaskIndex,
          }
        : undefined,
    });

    await aiRepository.touchConversationUpdatedAt({
      conversationId: conversationObjectId,
      userId: userObjectId,
    });

    await aiRepository.updateConversationContext({
      conversationId: conversationObjectId,
      userId: userObjectId,
      lastSubtaskKey: currentSubtaskKey,
      domain,
    });

    if (decision.route !== "APP_GUIDE") {
      void userMemoryService.ingestUtterance(userObjectId, input.message);
    }

    await aiUsageService.recordUsage({
      userId,
      conversationId: String(conversationObjectId),
      feature: "chat",
      route: decision.route,
      model: result.model,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      totalTokens: result.usage?.totalTokens,
      latencyMs: Date.now() - startedAt,
      cacheHit: !!result.cached,
      guardrailTriggered: guardrailFlags.length
        ? guardrailFlags.join(",")
        : undefined,
      status: "ok",
      meta: {
        subIntent: decision.subIntent,
        retrievalMode: result.retrievalMode,
        kbChunksUsed: result.kbChunksUsed,
        tasksCreatedCount,
      },
    });

    return {
      reply: finalAssistantContent,
      conversationId: String(conversationObjectId),
      model: result.model,
      route: decision.route,
      ...(result.cached ? { cached: true } : {}),
      usage: result.usage,
      ...(tasksCreatedCount > 0 ? { tasksCreated: tasksCreatedCount } : {}),
    };
  },

  /**
   * Streaming chat endpoint (with recent conversation history when conversationId exists).
   */
  chatStream: async function* (
    userId: string,
    input: {
      message: string;
      conversationId?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): AsyncGenerator<AiChatStreamEvent> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error("USER_ID_INVALID");
    }
    const startedAt = Date.now();
    const userObjectId = new Types.ObjectId(userId);
    const title = input.message.slice(0, 60);

    const inputCheck = aiGuardrailService.checkInputGuardrail(input.message);
    if (!inputCheck.allowed && inputCheck.reason === "INPUT_TOO_LONG") {
      await aiUsageService.recordUsage({
        userId,
        feature: "chat_stream",
        route: "GUARDRAIL_BLOCKED",
        model: "guardrail:input",
        provider: "guardrail",
        guardrailTriggered: "INPUT_TOO_LONG",
        latencyMs: Date.now() - startedAt,
        status: "blocked",
      });
      throw new Error("INPUT_TOO_LONG");
    }

    const quota = await aiGuardrailService.checkDailyQuota(userId);
    if (!quota.allowed && inputCheck.allowed) {
      await aiUsageService.recordUsage({
        userId,
        feature: "chat_stream",
        route: "GENERAL_CHAT",
        guardrailTriggered: "QUOTA_EXCEEDED",
        latencyMs: Date.now() - startedAt,
        status: "blocked",
      });
      throw new Error("AI_DAILY_QUOTA_EXCEEDED");
    }

    if (input.conversationId && !Types.ObjectId.isValid(input.conversationId)) {
      throw new Error("CONVERSATION_ID_INVALID");
    }
    const conversationObjectId = input.conversationId
      ? new Types.ObjectId(input.conversationId)
      : (
          await aiRepository.createConversation({
            userId: userObjectId,
            title,
          })
        )._id;

    let streamHistory: AiChatMessage[] = [];
    if (input.conversationId) {
      const existing = await aiRepository.findConversationByIdForUser({
        conversationId: conversationObjectId,
        userId: userObjectId,
      });
      if (!existing) {
        throw new Error("CONVERSATION_FORBIDDEN");
      }
      const recent = await aiRepository.listMessagesByConversation({
        conversationId: conversationObjectId,
        userId: userObjectId,
        limit: 12,
      });
      streamHistory = recent
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({
          role:
            m.role === "assistant"
              ? ("assistant" as const)
              : ("user" as const),
          content:
            m.content.length > 1000
              ? `${m.content.slice(0, 1000)}…`
              : m.content,
        }));
    }

    await aiRepository.createMessage({
      conversationId: conversationObjectId,
      userId: userObjectId,
      role: "user",
      content: input.message,
    });

    yield { type: "meta", conversationId: String(conversationObjectId) };

    if (!inputCheck.allowed) {
      yield { type: "delta", delta: inputCheck.safeReply };
      yield {
        type: "done",
        model: "guardrail:input",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "assistant",
        content: inputCheck.safeReply,
        tokens: 0,
      });
      await aiRepository.touchConversationUpdatedAt({
        conversationId: conversationObjectId,
        userId: userObjectId,
      });
      await aiUsageService.recordUsage({
        userId,
        conversationId: String(conversationObjectId),
        feature: "chat_stream",
        route: "GUARDRAIL_BLOCKED",
        model: "guardrail:input",
        provider: "guardrail",
        guardrailTriggered: inputCheck.reason,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
      });
      return;
    }

    const stream = aiProvider.chatStream({
      purpose: "chat",
      messages: [
        {
          role: "system",
          content:
            "Bạn là trợ lý AI cho ứng dụng quản lý công việc TaskMind AI. Luôn trả lời ngắn gọn, bám đúng câu hỏi, đề xuất bước hành động cụ thể khi phù hợp. Không bịa thông tin, không tự mở rộng ngoài phạm vi câu hỏi. Trả lời bằng tiếng Việt trừ khi người dùng viết bằng ngôn ngữ khác.",
        },
        ...streamHistory,
        { role: "user", content: input.message },
      ],
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });

    let assistantText = "";
    let streamModel: string | undefined;
    let finalUsage:
      | {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        }
      | undefined;

    try {
      for await (const ev of stream) {
        if (ev.type === "meta") {
          yield ev;
          continue;
        }
        if (ev.type === "delta") {
          assistantText += ev.delta;
          yield ev;
          continue;
        }
        streamModel = ev.model;
        finalUsage = ev.usage;
        yield ev;
      }
    } catch (err) {
      await aiUsageService.recordUsage({
        userId,
        conversationId: String(conversationObjectId),
        feature: "chat_stream",
        route: "GENERAL_CHAT",
        model: streamModel,
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: err instanceof Error ? err.message : "UNKNOWN",
      });
      throw err;
    }

    const sanitizedStream = aiGuardrailService.validateAndSanitizeOutput(
      assistantText,
      { validateInternalRoutes: false },
    );

    if (sanitizedStream.content) {
      await aiRepository.createMessage({
        conversationId: conversationObjectId,
        userId: userObjectId,
        role: "assistant",
        content: sanitizedStream.content,
        tokens: finalUsage?.totalTokens,
      });
    }
    await aiRepository.touchConversationUpdatedAt({
      conversationId: conversationObjectId,
      userId: userObjectId,
    });

    await aiUsageService.recordUsage({
      userId,
      conversationId: String(conversationObjectId),
      feature: "chat_stream",
      route: "GENERAL_CHAT",
      model: streamModel,
      promptTokens: finalUsage?.promptTokens,
      completionTokens: finalUsage?.completionTokens,
      totalTokens: finalUsage?.totalTokens,
      latencyMs: Date.now() - startedAt,
      guardrailTriggered: sanitizedStream.flags.length
        ? sanitizedStream.flags.join(",")
        : undefined,
      status: "ok",
    });
  },

  listConversations: async (
    userId: string,
    input?: { limit?: number },
  ): Promise<{ conversations: PublicAiConversation[] }> => {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error("USER_ID_INVALID");
    }
    const userObjectId = new Types.ObjectId(userId);
    const limit = Math.min(Math.max(input?.limit ?? 20, 1), 100);
    const items = await aiRepository.listConversationsByUser({
      userId: userObjectId,
      limit,
    });
    return { conversations: items.map(toPublicConversation) };
  },

  getConversationById: async (
    userId: string,
    input: { id: string; limitMessages?: number },
  ): Promise<{
    conversation: PublicAiConversation;
    messages: PublicAiMessage[];
  }> => {
    if (!Types.ObjectId.isValid(userId)) {
      throw new Error("USER_ID_INVALID");
    }
    if (!Types.ObjectId.isValid(input.id)) {
      throw new Error("CONVERSATION_ID_INVALID");
    }
    const userObjectId = new Types.ObjectId(userId);
    const conversationObjectId = new Types.ObjectId(input.id);

    const conversation = await aiRepository.findConversationByIdForUser({
      conversationId: conversationObjectId,
      userId: userObjectId,
    });
    if (!conversation) {
      throw new Error("CONVERSATION_FORBIDDEN");
    }

    const limit = Math.min(Math.max(input.limitMessages ?? 100, 1), 500);
    const messages = await aiRepository.listMessagesByConversation({
      conversationId: conversationObjectId,
      userId: userObjectId,
      limit,
    });

    return {
      conversation: toPublicConversation(conversation),
      messages: messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map(toPublicMessage),
    };
  },

  getOrCreateConversationByParentTask: async (
    userId: string,
    input: { parentTaskId: string; title?: string },
  ): Promise<{
    conversation: PublicAiConversation;
    messages: PublicAiMessage[];
    created: boolean;
  }> => {
    if (!Types.ObjectId.isValid(userId)) throw new Error("USER_ID_INVALID");
    if (!Types.ObjectId.isValid(input.parentTaskId))
      throw new Error("PARENT_TASK_ID_INVALID");

    const userObjectId = new Types.ObjectId(userId);
    const parentTaskObjectId = new Types.ObjectId(input.parentTaskId);
    const { doc, created } =
      await aiRepository.findOrCreateConversationForParentTask({
        userId: userObjectId,
        parentTaskId: parentTaskObjectId,
        title: (input.title || "").slice(0, 80) || "Task conversation",
      });

    const messages = await aiRepository.listMessagesByConversation({
      conversationId: doc._id,
      userId: userObjectId,
      limit: 100,
    });

    return {
      conversation: toPublicConversation(doc),
      messages: messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map(toPublicMessage),
      created,
    };
  },
};
