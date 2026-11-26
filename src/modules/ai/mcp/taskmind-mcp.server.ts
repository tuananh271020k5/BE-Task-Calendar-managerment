import mongoose, { Types } from "mongoose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Task } from "../../task/task.model";
import { executeToolCall } from "../ai-tools";
import { aiBreakdownService } from "../ai-breakdown.service";
import { kbRetriever } from "../agents/kb-retriever.service";

export type TaskMindMcpContext = {
  userId: string;
};

type McpToolTextResponse = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const jsonTextResult = (payload: unknown): McpToolTextResponse => ({
  content: [
    {
      type: "text",
      text:
        typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    },
  ],
});

const withToolErrorBoundary = async (
  fn: () => Promise<McpToolTextResponse>,
): Promise<McpToolTextResponse> => {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
};

const TASKMIND_OVERVIEW_MARKDOWN = `# TaskMind AI — MCP Overview

## Modules & Internal Routes
- **Tasks** (\`/tasks\`): Tạo công việc, xem Danh sách / Bảng Kanban, AI Breakdown chia nhỏ bước, AI Copilot, gia hạn deadline.
- **Calendar** (\`/calendar\`): Xem lịch theo ngày/tuần/tháng, cài đặt Lịch rảnh (Availability), Lịch hàng ngày (Daily Routines), AI Tối ưu Lịch.
- **Teams** (\`/teams\`): Tạo nhóm, mời thành viên qua email, giao việc nhóm, quy tắc gia hạn deadline theo vai trò.
- **Notifications** (\`/notifications\`): Nhắc nhở, Snooze (tạm ẩn), Quiet Hours (không làm phiền), Digest Email.
- **Chat & Profile** (\`/chat\`, \`/profile\`, \`/guide\`): Chat AI, Widget hỗ trợ, User Habits (thói quen làm việc), đổi mật khẩu / OTP.

## Available MCP Tools
1. \`list_tasks\` — Liệt kê công việc của người dùng hiện tại (lọc theo status, priority, keyword).
2. \`create_task\` — Tạo công việc / sự kiện mới vào lịch trình của người dùng.
3. \`breakdown_task\` — Chia nhỏ công việc thành các bước hành động (tự động tận dụng Template KB & Redis Cache).
4. \`get_free_busy\` — Xem báo cáo khung giờ bận/rảnh trong khoảng thời gian [from, to].
5. \`propose_schedule\` — Đề xuất khung giờ phù hợp cho một hoặc nhiều hoạt động.
6. \`search_kb\` — Tìm kiếm tài liệu hướng dẫn sử dụng TaskMind AI (Hybrid BM25 + Vector RRF).
`;

export const createTaskMindMcpServer = (ctx: TaskMindMcpContext): McpServer => {
  const server = new McpServer({
    name: "taskmind-mcp-server",
    version: "1.0.0",
  });

  // 1. list_tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List User Tasks",
      description:
        "Liệt kê danh sách công việc (chưa lưu trữ) của user hiện tại. Hỗ trợ lọc theo status, priority, keyword và limit.",
      inputSchema: {
        status: z
          .enum(["todo", "scheduled", "in_progress", "completed", "cancelled"])
          .optional()
          .describe("Lọc theo trạng thái công việc."),
        priority: z
          .enum(["low", "medium", "high", "urgent"])
          .optional()
          .describe("Lọc theo độ ưu tiên."),
        keyword: z
          .string()
          .optional()
          .describe("Từ khóa tìm kiếm trong tiêu đề công việc."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Số lượng task tối đa trả về (1..50, mặc định 20)."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        if (!Types.ObjectId.isValid(ctx.userId)) {
          throw new Error("USER_ID_INVALID");
        }
        if (mongoose.connection.readyState !== 1) {
          throw new Error("DATABASE_NOT_CONNECTED");
        }

        const filter: Record<string, unknown> = {
          userId: new Types.ObjectId(ctx.userId),
          isArchived: { $ne: true },
        };
        if (args.status) filter.status = args.status;
        if (args.priority) filter.priority = args.priority;
        if (args.keyword?.trim()) {
          const escaped = args.keyword
            .trim()
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          filter.title = { $regex: new RegExp(escaped, "i") };
        }

        const limit = args.limit ?? 20;
        const docs = await Task.find(filter)
          .sort({ deadline: 1, createdAt: -1 })
          .limit(limit)
          .lean();

        const tasks = docs.map((t: any) => ({
          id: String(t._id),
          title: t.title,
          status: t.status,
          priority: t.priority,
          deadline: t.deadline ?? null,
          startAt: t.startAt ?? null,
          scheduledTime: t.scheduledTime ?? null,
          estimatedDuration: t.estimatedDuration ?? null,
          tags: Array.isArray(t.tags) ? t.tags : [],
          description: t.description ?? undefined,
        }));

        return jsonTextResult({ count: tasks.length, tasks });
      }),
  );

  // 2. create_task
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Tạo một công việc hoặc sự kiện mới vào hệ thống TaskMind của user hiện tại.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("Tiêu đề công việc."),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Định dạng ngày YYYY-MM-DD")
          .describe("Ngày thực hiện dạng YYYY-MM-DD."),
        description: z.string().max(4000).optional().describe("Mô tả chi tiết."),
        startTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Định dạng HH:mm")
          .optional()
          .describe("Giờ bắt đầu dạng HH:mm."),
        endTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Định dạng HH:mm")
          .optional()
          .describe("Giờ kết thúc dạng HH:mm."),
        priority: z
          .enum(["urgent", "high", "medium", "low"])
          .optional()
          .describe("Độ ưu tiên (mặc định medium)."),
        category: z.string().optional().describe("Thể loại / tag."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        if (!Types.ObjectId.isValid(ctx.userId)) {
          throw new Error("USER_ID_INVALID");
        }
        if (mongoose.connection.readyState !== 1) {
          throw new Error("DATABASE_NOT_CONNECTED");
        }

        const result = await executeToolCall(
          {
            id: `mcp_create_${Date.now()}`,
            name: "create_task",
            arguments: JSON.stringify(args),
          },
          { userId: ctx.userId },
        );
        return jsonTextResult(result.content);
      }),
  );

  // 3. breakdown_task
  server.registerTool(
    "breakdown_task",
    {
      title: "AI Breakdown Task",
      description:
        "Chia nhỏ một công việc thành các bước hành động cụ thể kèm thời lượng dự kiến và độ khó.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("Tiêu đề công việc."),
        description: z
          .string()
          .max(4000)
          .optional()
          .describe("Mô tả chi tiết / yêu cầu kỹ thuật."),
        totalMinutes: z
          .number()
          .min(5)
          .max(1440)
          .optional()
          .describe("Tổng thời gian mục tiêu (phút, 5..1440)."),
        deadline: z
          .string()
          .optional()
          .describe("Hạn chót dạng ISO 8601 (tùy chọn)."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        const deadlineDate = args.deadline ? new Date(args.deadline) : undefined;
        if (deadlineDate && Number.isNaN(deadlineDate.getTime())) {
          throw new Error("DEADLINE_INVALID");
        }

        const result = await aiBreakdownService.taskBreakdown(ctx.userId, {
          title: args.title,
          description: args.description,
          totalMinutes: args.totalMinutes,
          deadline: deadlineDate,
        });
        return jsonTextResult(result);
      }),
  );

  // 4. get_free_busy
  server.registerTool(
    "get_free_busy",
    {
      title: "Get Free/Busy Schedule",
      description:
        "Lấy báo cáo khung giờ bận và khung giờ rảnh của user trong khoảng thời gian [from, to].",
      inputSchema: {
        from: z
          .string()
          .min(1)
          .describe("Thời điểm bắt đầu ISO 8601 +07:00."),
        to: z
          .string()
          .min(1)
          .describe("Thời điểm kết thúc ISO 8601 +07:00."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        if (mongoose.connection.readyState !== 1) {
          throw new Error("DATABASE_NOT_CONNECTED");
        }

        const result = await executeToolCall(
          {
            id: `mcp_fb_${Date.now()}`,
            name: "get_free_busy_report",
            arguments: JSON.stringify({ from: args.from, to: args.to }),
          },
          { userId: ctx.userId },
        );
        return jsonTextResult(result.content);
      }),
  );

  // 5. propose_schedule
  server.registerTool(
    "propose_schedule",
    {
      title: "Propose Schedule Slots",
      description:
        "Đề xuất khung giờ phù hợp trên lịch rảnh cho một hoặc nhiều hoạt động (chỉ đề xuất, không tự tạo task).",
      inputSchema: {
        from: z.string().min(1).describe("ISO 8601 +07:00 bắt đầu."),
        to: z.string().min(1).describe("ISO 8601 +07:00 kết thúc."),
        activityName: z.string().optional().describe("Tên hoạt động đơn lẻ."),
        durationMin: z.number().optional().describe("Số phút mỗi buổi."),
        sessionsPerWeek: z.number().optional().describe("Số buổi mỗi tuần."),
        windowStart: z
          .string()
          .optional()
          .describe("Giờ ưu tiên bắt đầu HH:mm."),
        windowEnd: z
          .string()
          .optional()
          .describe("Giờ ưu tiên kết thúc HH:mm."),
        daysAllowed: z
          .array(z.string())
          .optional()
          .describe("Danh sách ngày cho phép (vd: ['monday', 'wednesday'])."),
        minGapDays: z
          .number()
          .optional()
          .describe("Khoảng cách tối thiểu giữa 2 buổi (ngày)."),
        activities: z
          .array(
            z.object({
              activityName: z.string(),
              durationMin: z.number().optional(),
              sessionsPerWeek: z.number(),
            }),
          )
          .optional()
          .describe("Danh sách nhiều hoạt động cần xếp cùng lúc."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        if (mongoose.connection.readyState !== 1) {
          throw new Error("DATABASE_NOT_CONNECTED");
        }

        const result = await executeToolCall(
          {
            id: `mcp_prop_${Date.now()}`,
            name: "propose_schedule",
            arguments: JSON.stringify(args),
          },
          { userId: ctx.userId },
        );
        return jsonTextResult(result.content);
      }),
  );

  // 6. search_kb
  server.registerTool(
    "search_kb",
    {
      title: "Search TaskMind Knowledge Base",
      description:
        "Tìm kiếm hướng dẫn sử dụng, quy tắc tính năng và route của ứng dụng TaskMind AI (Hybrid BM25 + Vector RRF).",
      inputSchema: {
        query: z.string().min(1).describe("Câu hỏi hoặc từ khóa tìm kiếm."),
        module: z
          .enum([
            "tasks",
            "calendar",
            "teams",
            "notifications",
            "chat-and-profile",
          ])
          .optional()
          .describe("Giới hạn phạm vi module tài liệu (tùy chọn)."),
        topK: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Số lượng đoạn tài liệu tối đa trả về (1..5, mặc định 3)."),
      },
    },
    async (args) =>
      withToolErrorBoundary(async () => {
        const { results, mode } = await kbRetriever.searchKbHybrid(args.query, {
          module: args.module,
          topK: args.topK ?? 3,
        });
        return jsonTextResult({
          mode,
          count: results.length,
          results: results.map((r) => ({
            id: r.chunk.id,
            module: r.chunk.module,
            route: r.chunk.route,
            title: r.chunk.title,
            score: Number(r.score.toFixed(4)),
            content: r.chunk.content,
          })),
        });
      }),
  );

  // Resource: taskmind://kb/overview
  server.registerResource(
    "taskmind-kb-overview",
    "taskmind://kb/overview",
    {
      title: "TaskMind AI Architecture & Guide Overview",
      description:
        "Tổng quan các module, route giao diện và danh sách MCP tools của TaskMind AI.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: TASKMIND_OVERVIEW_MARKDOWN,
        },
      ],
    }),
  );

  return server;
};
