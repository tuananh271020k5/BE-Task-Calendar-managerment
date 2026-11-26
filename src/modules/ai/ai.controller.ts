import { Request, Response } from "express";
import { Types } from "mongoose";
import { aiService } from "./ai.service";
import { aiStreamingService } from "./ai.streaming.service";
import { aiRepository } from "./ai.repository";
import { aiCalendarActionService } from "./ai-calendar-action.service";
import {
  getUserId,
  handleAiError,
  parseOptionalNumber,
  parseOptionalString,
} from "./ai-controller.helpers";

export const chat = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const body = (req as any).body ?? {};
    const message = String(body?.message ?? "").trim();
    if (!message) {
      res.status(400).json({ message: "Message không hợp lệ" });
      return;
    }

    const temperature = parseOptionalNumber(body?.temperature);
    if (
      body?.temperature !== undefined &&
      body?.temperature !== null &&
      (temperature === undefined || temperature < 0 || temperature > 2)
    ) {
      res.status(400).json({ message: "Temperature không hợp lệ" });
      return;
    }

    const maxTokens = parseOptionalNumber(body?.maxTokens);
    if (
      body?.maxTokens !== undefined &&
      body?.maxTokens !== null &&
      (maxTokens === undefined || Math.floor(maxTokens) <= 0)
    ) {
      res.status(400).json({ message: "MaxTokens không hợp lệ" });
      return;
    }

    const fewShotMessages = Array.isArray(body?.fewShotMessages)
      ? (body.fewShotMessages as any[])
          .filter(
            (m) =>
              m && (m.role === "user" || m.role === "assistant") && m.content,
          )
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content),
          }))
      : undefined;

    const rawCtx = body?.subtaskContext;
    const subtaskContext =
      rawCtx && typeof rawCtx === "object"
        ? {
            subtaskTitle: rawCtx.subtaskTitle
              ? String(rawCtx.subtaskTitle)
              : undefined,
            parentTaskTitle: rawCtx.parentTaskTitle
              ? String(rawCtx.parentTaskTitle)
              : undefined,
            parentTaskDescription: rawCtx.parentTaskDescription
              ? String(rawCtx.parentTaskDescription)
              : undefined,
            estimatedDuration: rawCtx.estimatedDuration
              ? Number(rawCtx.estimatedDuration)
              : undefined,
            parentEstimatedDuration: rawCtx.parentEstimatedDuration
              ? Number(rawCtx.parentEstimatedDuration)
              : undefined,
            dailyTargetMin: rawCtx.dailyTargetMin
              ? Number(rawCtx.dailyTargetMin)
              : undefined,
            dailyTargetDuration: rawCtx.dailyTargetDuration
              ? Number(rawCtx.dailyTargetDuration)
              : undefined,
            difficulty: rawCtx.difficulty
              ? String(rawCtx.difficulty)
              : undefined,
            description: rawCtx.description
              ? String(rawCtx.description)
              : undefined,
            subtaskKey: rawCtx.subtaskKey
              ? String(rawCtx.subtaskKey)
              : undefined,
            subtaskIndex:
              rawCtx.subtaskIndex !== undefined && rawCtx.subtaskIndex !== null
                ? Number(rawCtx.subtaskIndex)
                : undefined,
          }
        : undefined;

    const result = await aiService.chat(userId, {
      message,
      conversationId: parseOptionalString(body?.conversationId),
      parentTaskId: parseOptionalString(body?.parentTaskId),
      currentPage: parseOptionalString(body?.currentPage),
      systemPrompt: parseOptionalString(body?.systemPrompt),
      subtaskContext,
      fewShotMessages,
      model: parseOptionalString(body?.model),
      temperature,
      maxTokens: maxTokens !== undefined ? Math.floor(maxTokens) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, {
      logPrefix: "[AI_CHAT_ERROR]",
      includeDevDetail: true,
    });
  }
};

export const chatStream = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const body = (req as any).body ?? {};
    const message = String(body?.message ?? "").trim();
    if (!message) {
      res.status(400).json({ message: "Message không hợp lệ" });
      return;
    }

    const temperature = parseOptionalNumber(body?.temperature);
    if (
      body?.temperature !== undefined &&
      body?.temperature !== null &&
      (temperature === undefined || temperature < 0 || temperature > 2)
    ) {
      res.status(400).json({ message: "Temperature không hợp lệ" });
      return;
    }

    const maxTokens = parseOptionalNumber(body?.maxTokens);
    if (
      body?.maxTokens !== undefined &&
      body?.maxTokens !== null &&
      (maxTokens === undefined || Math.floor(maxTokens) <= 0)
    ) {
      res.status(400).json({ message: "MaxTokens không hợp lệ" });
      return;
    }

    aiStreamingService.initSse(res);

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const stream = aiService.chatStream(userId, {
      message,
      conversationId: parseOptionalString(body?.conversationId),
      model: parseOptionalString(body?.model),
      temperature,
      maxTokens: maxTokens !== undefined ? Math.floor(maxTokens) : undefined,
    });

    for await (const ev of stream) {
      if (closed) return;

      if (ev.type === "meta") {
        aiStreamingService.sendSseEvent(
          res,
          { conversationId: ev.conversationId },
          "meta",
        );
      } else if (ev.type === "delta") {
        aiStreamingService.sendSseEvent(res, { delta: ev.delta }, "chunk");
      } else {
        aiStreamingService.sendSseEvent(
          res,
          { model: ev.model, usage: ev.usage },
          "done",
        );
      }
    }

    if (!closed) {
      aiStreamingService.closeSse(res);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error("UNKNOWN");
    console.error("[AI_CHAT_STREAM_ERROR]", error);
    const message = error.message;

    if (res.headersSent) {
      const payload = {
        message:
          message === "CONVERSATION_FORBIDDEN"
            ? "Không có quyền truy cập conversation này"
            : message === "CONVERSATION_ID_INVALID"
              ? "ConversationId không hợp lệ"
              : message === "USER_ID_INVALID"
                ? "UserId không hợp lệ"
                : message === "AI_DAILY_QUOTA_EXCEEDED"
                  ? "Bạn đã đạt giới hạn sử dụng AI trong ngày hôm nay."
                  : "Lỗi hệ thống",
        ...(process.env.NODE_ENV !== "production" ? { detail: message } : {}),
      };
      aiStreamingService.sendSseEvent(res, payload, "error");
      aiStreamingService.closeSse(res);
      return;
    }

    handleAiError(res, err);
  }
};

export const listConversations = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const limit = parseOptionalNumber((req as any).query?.limit);
    const result = await aiService.listConversations(userId, {
      limit: limit !== undefined ? Math.floor(limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err);
  }
};

export const getConversationById = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const id = String((req as any).params?.id ?? "").trim();
    if (!id) {
      res.status(400).json({ message: "Conversation id không hợp lệ" });
      return;
    }

    const limit = parseOptionalNumber((req as any).query?.limit);
    const result = await aiService.getConversationById(userId, {
      id,
      limitMessages: limit !== undefined ? Math.floor(limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, {
      invalidConversationMessage: "Conversation id không hợp lệ",
    });
  }
};

export const getOrCreateConversationByParent = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const parentTaskId = String((req as any).params?.parentTaskId ?? "").trim();
    if (!parentTaskId) {
      res.status(400).json({ message: "parentTaskId không hợp lệ" });
      return;
    }

    const title = parseOptionalString((req as any).query?.title);
    const { aiChatService } = await import("./ai-chat.service");
    const result = await aiChatService.getOrCreateConversationByParentTask(
      userId,
      { parentTaskId, title },
    );
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, {
      logPrefix: "[AI_GET_OR_CREATE_BY_PARENT_ERROR]",
    });
  }
};

export const taskBreakdown = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const title = String((req as any).body?.title ?? "").trim();
    const deadlineRaw = (req as any).body?.deadline;
    const deadline = deadlineRaw ? new Date(String(deadlineRaw)) : undefined;

    if (!title) {
      res.status(400).json({ message: "Title không hợp lệ" });
      return;
    }
    if (deadlineRaw && Number.isNaN(deadline?.getTime())) {
      res.status(400).json({ message: "Deadline không hợp lệ" });
      return;
    }

    const result = await aiService.taskBreakdown(userId, { title, deadline });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, { includeDevDetail: true });
  }
};

export const prioritySuggest = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const title = String((req as any).body?.title ?? "").trim();
    const deadlineRaw = (req as any).body?.deadline;
    const deadline = deadlineRaw ? new Date(String(deadlineRaw)) : undefined;

    if (!title) {
      res.status(400).json({ message: "Title không hợp lệ" });
      return;
    }
    if (deadlineRaw && Number.isNaN(deadline?.getTime())) {
      res.status(400).json({ message: "Deadline không hợp lệ" });
      return;
    }

    const result = await aiService.prioritySuggest(userId, { title, deadline });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, { includeDevDetail: true });
  }
};

export const schedulePlan = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const taskIds = (req as any).body?.taskIds;
    const startDateRaw = (req as any).body?.startDate;
    const schedulingStrategy = (req as any).body?.schedulingStrategy;
    const distributionPattern = (req as any).body?.distributionPattern;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      res.status(400).json({ message: "Danh sách taskIds không hợp lệ" });
      return;
    }
    if (taskIds.length > 20) {
      res
        .status(400)
        .json({ message: "Tối đa 20 công việc trong một lịch trình" });
      return;
    }

    const startDate = startDateRaw ? new Date(startDateRaw) : new Date();
    if (isNaN(startDate.getTime())) {
      res.status(400).json({ message: "Ngày bắt đầu không hợp lệ" });
      return;
    }

    const validStrategies = ["sequential", "parallel", "balanced"];
    const validDistributions = ["front-load", "even", "adaptive"];

    const result = await aiService.schedulePlan(userId, {
      taskIds,
      startDate,
      schedulingStrategy: validStrategies.includes(schedulingStrategy)
        ? schedulingStrategy
        : undefined,
      distributionPattern: validDistributions.includes(distributionPattern)
        ? distributionPattern
        : undefined,
    });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, {
      logPrefix: "schedulePlan error:",
      invalidUserMessage: "User ID không hợp lệ",
      invalidJsonStatus: 502,
      includeErrorDetail: true,
    });
  }
};

export const smartReschedule = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const body = (req as any).body ?? {};
    const missedTask = body?.missedTask;
    const reason = String(body?.reason ?? "missed");

    if (!missedTask || !missedTask.id || !missedTask.title) {
      res.status(400).json({ message: "Thông tin task không hợp lệ" });
      return;
    }

    const result = await aiService.smartReschedule(userId, {
      missedTask: {
        id: String(missedTask.id),
        title: String(missedTask.title),
        description: missedTask.description,
        priority: String(missedTask.priority ?? "medium"),
        deadline: missedTask.deadline
          ? new Date(missedTask.deadline)
          : undefined,
        estimatedDuration: missedTask.estimatedDuration,
        originalScheduledTime: missedTask.originalScheduledTime,
      },
      reason,
    });
    res.status(200).json(result);
  } catch (err) {
    handleAiError(res, err, {
      invalidUserMessage: "User ID không hợp lệ",
      notFoundTaskMessage: "Không tìm thấy task",
      includeErrorDetail: true,
    });
  }
};

export const deleteConversation = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const id = String((req as any).params?.id ?? "").trim();
    if (!id || !Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Conversation id không hợp lệ" });
      return;
    }

    const deleted = await aiRepository.deleteConversation({
      conversationId: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
    if (!deleted) {
      res.status(403).json({ message: "Không có quyền hoặc không tìm thấy" });
      return;
    }
    res.status(200).json({ message: "Đã xóa cuộc trò chuyện" });
  } catch (err) {
    handleAiError(res, err);
  }
};

export const renameConversation = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const id = String((req as any).params?.id ?? "").trim();
    if (!id || !Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Conversation id không hợp lệ" });
      return;
    }

    const title = String((req as any).body?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ message: "Title không được để trống" });
      return;
    }

    const updated = await aiRepository.renameConversation({
      conversationId: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
      title,
    });
    if (!updated) {
      res.status(403).json({ message: "Không có quyền hoặc không tìm thấy" });
      return;
    }
    res.status(200).json({ message: "Đã đổi tên", title: updated.title });
  } catch (err) {
    handleAiError(res, err);
  }
};

export const applyCalendarAction = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const body = (req as any).body ?? {};
    const targetDate = String(body.targetDate || "").trim();
    const actions: any[] = Array.isArray(body.actions) ? body.actions : [];

    if (!targetDate && actions.length === 0) {
      res.status(400).json({ message: "Dữ liệu hành động không hợp lệ" });
      return;
    }

    const result = await aiCalendarActionService.applyActions(userId, {
      targetDate,
      actions,
    });
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({
      message: "Lỗi khi áp dụng lịch trình",
      error: error?.message || String(error),
    });
  }
};

export const getUsageSummary = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const days = parseOptionalNumber((req as any).query?.days) ?? 7;
    const { aiUsageService } = await import("./ai-usage.service");
    const summary = await aiUsageService.getUserUsageSummary(userId, days);
    res.status(200).json(summary);
  } catch (err) {
    handleAiError(res, err);
  }
};
