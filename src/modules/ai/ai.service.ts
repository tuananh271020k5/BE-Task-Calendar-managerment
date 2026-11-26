export { aiChatService } from "./ai-chat.service";
export { aiRescheduleService } from "./ai-reschedule.service";
export { aiBreakdownService } from "./ai-breakdown.service";

export const aiService = {
  chat: async (
    ...args: Parameters<typeof import("./ai-chat.service").aiChatService.chat>
  ) => {
    const { aiChatService } = await import("./ai-chat.service");
    return aiChatService.chat(...args);
  },

  chatStream: async function* (
    ...args: Parameters<
      typeof import("./ai-chat.service").aiChatService.chatStream
    >
  ) {
    const { aiChatService } = await import("./ai-chat.service");
    yield* aiChatService.chatStream(...args);
  },

  listConversations: async (
    ...args: Parameters<
      typeof import("./ai-chat.service").aiChatService.listConversations
    >
  ) => {
    const { aiChatService } = await import("./ai-chat.service");
    return aiChatService.listConversations(...args);
  },

  getConversationById: async (
    ...args: Parameters<
      typeof import("./ai-chat.service").aiChatService.getConversationById
    >
  ) => {
    const { aiChatService } = await import("./ai-chat.service");
    return aiChatService.getConversationById(...args);
  },

  schedulePlan: async (
    ...args: Parameters<
      typeof import("../scheduler/hybrid-schedule.service").hybridScheduleService.schedulePlan
    >
  ) => {
    const { hybridScheduleService } =
      await import("../scheduler/hybrid-schedule.service");
    return hybridScheduleService.schedulePlan(...args);
  },

  smartReschedule: async (
    ...args: Parameters<
      typeof import("./ai-reschedule.service").aiRescheduleService.smartReschedule
    >
  ) => {
    const { aiRescheduleService } = await import("./ai-reschedule.service");
    return aiRescheduleService.smartReschedule(...args);
  },

  taskBreakdown: async (
    ...args: Parameters<
      typeof import("./ai-breakdown.service").aiBreakdownService.taskBreakdown
    >
  ) => {
    const { aiBreakdownService } = await import("./ai-breakdown.service");
    return aiBreakdownService.taskBreakdown(...args);
  },

  prioritySuggest: async (
    ...args: Parameters<
      typeof import("./ai-breakdown.service").aiBreakdownService.prioritySuggest
    >
  ) => {
    const { aiBreakdownService } = await import("./ai-breakdown.service");
    return aiBreakdownService.prioritySuggest(...args);
  },
};
