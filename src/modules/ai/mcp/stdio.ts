// Redirect stdout logs to stderr BEFORE importing any modules so JSON-RPC frames over stdout are never corrupted.
console.log = (...args: unknown[]) => {
  console.error(...args);
};

import dotenv from "dotenv";
dotenv.config({ quiet: true } as any);

import { Types } from "mongoose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect } from "../../../config/database";
import { createTaskMindMcpServer } from "./taskmind-mcp.server";

async function main(): Promise<void> {
  const userId = String(process.env.TASKMIND_MCP_USER_ID ?? "").trim();

  if (!userId || !Types.ObjectId.isValid(userId)) {
    console.error(
      "[TaskMind MCP stdio] Thiếu hoặc sai định dạng biến môi trường TASKMIND_MCP_USER_ID (phải là MongoDB ObjectId hợp lệ).",
    );
    console.error(
      'Ví dụ: TASKMIND_MCP_USER_ID="67f123..." npm run mcp:stdio',
    );
    process.exit(1);
  }

  if (process.env.TASKMIND_MCP_SKIP_DB !== "true") {
    await connect();
  }

  const server = createTaskMindMcpServer({ userId });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[TaskMind MCP stdio] Đã khởi động thành công (userId=${userId.slice(0, 6)}...${userId.slice(-4)}).`,
  );
}

main().catch((err) => {
  console.error("[TaskMind MCP stdio] Lỗi khởi động:", err);
  process.exit(1);
});
