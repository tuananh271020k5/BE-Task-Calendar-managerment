import { Request, Response } from "express";

export const getUserId = (req: Request): string | null => {
  const userId = (req as any).user?.userId;
  return userId ? String(userId) : null;
};

export const parseOptionalString = (val: unknown): string | undefined => {
  if (val === undefined || val === null) return undefined;
  const trimmed = String(val).trim();
  return trimmed || undefined;
};

export const parseOptionalNumber = (val: unknown): number | undefined => {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
};

export type HandleAiErrorOptions = {
  logPrefix?: string;
  invalidJsonStatus?: number;
  invalidJsonMessage?: string;
  includeErrorDetail?: boolean;
  includeDevDetail?: boolean;
  invalidUserMessage?: string;
  invalidConversationMessage?: string;
  notFoundTaskMessage?: string;
};

export const handleAiError = (
  res: Response,
  err: unknown,
  options: HandleAiErrorOptions = {},
): void => {
  const error = err instanceof Error ? err : new Error("UNKNOWN");
  if (options.logPrefix) {
    console.error(options.logPrefix, error);
  }

  const message = error.message;
  const devDetail =
    options.includeDevDetail && process.env.NODE_ENV !== "production"
      ? { detail: message }
      : {};

  if (message === "USER_ID_INVALID") {
    res
      .status(400)
      .json({ message: options.invalidUserMessage ?? "UserId không hợp lệ" });
    return;
  }
  if (message === "CONVERSATION_ID_INVALID") {
    res.status(400).json({
      message:
        options.invalidConversationMessage ?? "ConversationId không hợp lệ",
    });
    return;
  }
  if (message === "PARENT_TASK_ID_INVALID") {
    res.status(400).json({ message: "parentTaskId không hợp lệ" });
    return;
  }
  if (message === "TASK_ID_INVALID") {
    res.status(400).json({ message: "Task ID không hợp lệ" });
    return;
  }
  if (message === "INPUT_TOO_LONG") {
    res.status(400).json({ message: "Nội dung đầu vào quá dài" });
    return;
  }
  if (message === "CONVERSATION_FORBIDDEN") {
    res
      .status(403)
      .json({ message: "Không có quyền truy cập conversation này" });
    return;
  }
  if (message === "TASK_NOT_FOUND") {
    res
      .status(404)
      .json({ message: options.notFoundTaskMessage ?? "Không tìm thấy công việc" });
    return;
  }
  if (message === "NOT_IMPLEMENTED") {
    res.status(501).json({ message: "Chức năng chưa triển khai" });
    return;
  }
  if (message === "AI_DAILY_QUOTA_EXCEEDED") {
    res.status(429).json({
      message:
        "Bạn đã đạt giới hạn sử dụng AI trong ngày hôm nay. Vui lòng thử lại vào ngày mai.",
    });
    return;
  }
  if (message === "AI_JSON_INVALID" || message === "AI_RESPONSE_INVALID") {
    const status = options.invalidJsonStatus ?? 500;
    const defaultMsg =
      status === 502
        ? "AI trả về phản hồi không hợp lệ"
        : "AI trả về dữ liệu không đúng định dạng. Thử lại sau.";
    res.status(status).json({
      message: options.invalidJsonMessage ?? defaultMsg,
      ...devDetail,
    });
    return;
  }
  if (message === "GROQ_API_KEY_MISSING") {
    res.status(500).json({ message: "Thiếu GROQ_API_KEY trong env", ...devDetail });
    return;
  }
  if (message === "GROQ_UNAUTHORIZED") {
    res.status(500).json({
      message: "Groq bị từ chối (API key không hợp lệ hoặc không có quyền).",
      ...devDetail,
    });
    return;
  }
  if (message === "GROQ_RATE_LIMIT") {
    res.status(429).json({
      message: "Groq bị giới hạn rate limit. Thử lại sau.",
      ...devDetail,
    });
    return;
  }

  const lower = message.toLowerCase();
  if (
    lower.includes("permission") ||
    lower.includes("unauthorized") ||
    lower.includes("403")
  ) {
    res.status(500).json({
      message:
        "Provider AI bị từ chối (permission/quota/billing). Kiểm tra API key và quyền truy cập.",
      ...devDetail,
    });
    return;
  }
  if (lower.includes("quota") || lower.includes("rate") || lower.includes("429")) {
    res.status(429).json({
      message: "Provider AI bị giới hạn quota/rate limit. Thử lại sau.",
      ...devDetail,
    });
    return;
  }
  if (
    lower.includes("model") &&
    (lower.includes("not found") || lower.includes("invalid"))
  ) {
    res.status(500).json({
      message: "AI model không hợp lệ. Kiểm tra cấu hình model.",
      ...devDetail,
    });
    return;
  }

  res.status(500).json({
    message: "Lỗi hệ thống",
    ...(options.includeErrorDetail ? { error: message } : {}),
    ...devDetail,
  });
};
