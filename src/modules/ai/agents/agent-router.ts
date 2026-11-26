import { isCommitConfirmationMessage } from "../ai-chat-helpers";
import { detectIntent, type ChatIntent } from "../ai-intent";
import { normalizeKbText, type KbModule } from "./kb-retriever.service";

export type AgentRoute =
  | "GREETING"
  | "APP_GUIDE"
  | "CALENDAR_TASK"
  | "LEARNING_TUTOR"
  | "GENERAL_CHAT";

export type RouteDecision = {
  route: AgentRoute;
  kbModule?: KbModule;
  subIntent: ChatIntent;
  quickReply?: string;
};

const PURE_GREETING_RE =
  /^(xin chao|chao( ban| anh| chi| em| ad| bot| ai| moi nguoi)?|hi+|hello+|hey+|alo+)$/i;

const PURE_THANKS_RE =
  /^(cam on(\s+(ban|anh|chi|em|ad|bot|moi nguoi))?(\s+(nhieu|lam|nhe|nha))?|thank(s| you)?(\s+very\s+much)?|ok(e|ela|ay)?|tam biet|bye+)$/i;

const APP_GUIDE_EXPLICIT_RE =
  /\b(o dau|nut nao|trang nao|man hinh nay|chuc nang|tinh nang|taskmind|ai breakdown|ai copilot|quiet hours|khong lam phien|digest email|gom nhom thong bao|snooze|tam an|kanban|user habits|thoi quen lam viec|lich hang ngay|daily routine|daily routines|cho phep chen|bao loi|gop y|ho tro su dung|how to use taskmind|where is)\b/i;

const APP_GUIDE_HOWTO_RE =
  /\b(huong dan|cach dung|cach su dung|cach tao|cach them|cach sua|cach xoa|cach moi|cach bat|cach tat|cach cai dat|cach xem|lam sao de|lam sao|lam the nao|how to|guide)\b/i;

const APP_DOMAIN_ENTITY_RE =
  /\b(cong viec|task|kanban|breakdown|subtask|copilot|lich ranh|lich hang ngay|routine|routines|toi uu lich|nhom|team|thanh vien|thong bao|notification|snooze|quiet hours|digest|nhac nho|ho so|profile|user habits|tai khoan|mat khau|otp|widget|chat ai|video huong dan|taskmind|ung dung|app|phan mem)\b/i;

const CALENDAR_ACTION_RE =
  /(\b(thoi gian ranh|thoi gian ban|lich ranh|lich ban|lich trong|lich ca nhan|khi nao ranh|khi nao ban|xem lich|doc lich|free time|busy time|my schedule|free slots|busy slots)\b|\b(sap xep|xep lich|len lich|lap lich|tao lich|dat lich|schedule|plan)\b|(\d+\s*(buoi|lan|session|luot)\s*(\/|moi|trong|tuan|ngay|week|day))|\b(doi lich|thay lich|thay vi|thay cho|thay bang|doi sang|doi gio|hoan lich|chuyen lich|huy lich|xoa lich|bo lich|nghi lam|duoc nghi|ngu nuong|day muon|day som|tap gym thay|thay di dao|co gian|thoi gian bieu)\b|\b(tao cong viec|them cong viec|tao task|them task|tao viec|them viec|tao su kien|them su kien)\b|(thu [2-7]|chu nhat|hom nay|ngay mai|ngay kia|tuan nay|tuan sau).*(\d{1,2}h|\d{1,2}:\d{2}|sang|chieu|toi)|(cong viec|task|viec|su kien).*(\d{1,2}h|\d{1,2}:\d{2}))/i;

const inferKbModule = (
  normalizedText: string,
  currentPage?: string,
): KbModule | undefined => {
  if (
    /\b(thong bao|notification|snooze|tam an|quiet hours|khong lam phien|digest|gom nhom|nhac nho)\b/.test(
      normalizedText,
    )
  ) {
    return "notifications";
  }
  if (
    /\b(nhom|team|moi thanh vien|truong nhom|phe duyet|tu choi|quan ly o team)\b/.test(
      normalizedText,
    )
  ) {
    return "teams";
  }
  if (
    /\b(lich ranh|lich hang ngay|routine|routines|cho phep chen|xoa lich ai|keo tha.*lich|trang lich|toi uu lich|calendar)\b/.test(
      normalizedText,
    )
  ) {
    return "calendar";
  }
  if (
    /\b(cong viec|task|kanban|breakdown|subtask|copilot|qua han|gia han)\b/.test(
      normalizedText,
    )
  ) {
    return "tasks";
  }
  if (
    /\b(chat ai|widget|boi den|hoi ve doan nay|ho so|profile|user habits|thoi quen lam viec|doi mat khau|quen mat khau|otp|video huong dan)\b/.test(
      normalizedText,
    )
  ) {
    return "chat-and-profile";
  }

  const page = (currentPage || "").toLowerCase();
  if (page.startsWith("/tasks")) return "tasks";
  if (page.startsWith("/calendar")) return "calendar";
  if (page.startsWith("/teams")) return "teams";
  if (page.startsWith("/notifications")) return "notifications";
  if (
    page.startsWith("/profile") ||
    page.startsWith("/chat") ||
    page.startsWith("/guide")
  ) {
    return "chat-and-profile";
  }
  return undefined;
};

export const routeChatMessage = (params: {
  message: string;
  currentPage?: string;
  hasSubtaskContext?: boolean;
  hasPendingDraft?: boolean;
}): RouteDecision => {
  const { message, currentPage, hasSubtaskContext, hasPendingDraft } = params;
  const normalized = normalizeKbText(message).replace(/[!?.]+$/g, "").trim();

  // 1. Zero-token quick reply for pure greetings / thanks
  if (!hasSubtaskContext && !hasPendingDraft && normalized.length <= 40) {
    if (PURE_GREETING_RE.test(normalized)) {
      return {
        route: "GREETING",
        subIntent: "CHAT",
        quickReply:
          "Xin chào! Mình là trợ lý TaskMind AI. Bạn cần hướng dẫn sử dụng tính năng nào, lên lịch công việc hay hỏi đáp học tập?",
      };
    }
    if (PURE_THANKS_RE.test(normalized)) {
      return {
        route: "GREETING",
        subIntent: "CHAT",
        quickReply:
          "Rất vui được hỗ trợ bạn! Nếu cần hướng dẫn tính năng hoặc xếp lịch thêm, cứ nhắn mình nhé.",
      };
    }
  }

  // 2. Pending scheduling draft confirmation
  if (hasPendingDraft && isCommitConfirmationMessage(message)) {
    return {
      route: "CALENDAR_TASK",
      subIntent: "CALENDAR_QUERY",
    };
  }

  // 3. App Guide & User Support (runs BEFORE calendar check to avoid false collisions)
  const hasExplicitTimeSlot = /\b\d{1,2}\s*[:h]\s*\d{0,2}\b/.test(normalized);
  const isAppGuideQuery =
    APP_GUIDE_EXPLICIT_RE.test(normalized) ||
    (APP_GUIDE_HOWTO_RE.test(normalized) &&
      APP_DOMAIN_ENTITY_RE.test(normalized));
  if (isAppGuideQuery && !hasExplicitTimeSlot) {
    return {
      route: "APP_GUIDE",
      kbModule: inferKbModule(normalized, currentPage),
      subIntent: "SYSTEM_HELP",
    };
  }

  // 4. Calendar & task execution
  if (CALENDAR_ACTION_RE.test(normalized)) {
    return {
      route: "CALENDAR_TASK",
      subIntent: "CALENDAR_QUERY",
    };
  }

  // 5. Learning / Tutor
  const baseIntent = detectIntent(message);
  if (
    hasSubtaskContext ||
    baseIntent === "EXERCISE" ||
    baseIntent === "CHECK_ANSWER" ||
    baseIntent === "EXPLAIN"
  ) {
    return {
      route: "LEARNING_TUTOR",
      subIntent: baseIntent === "CHAT" ? "EXPLAIN" : baseIntent,
    };
  }

  // 6. General chat
  return {
    route: "GENERAL_CHAT",
    subIntent: "CHAT",
  };
};
