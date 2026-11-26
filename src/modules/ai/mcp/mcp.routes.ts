import { Request, Response, Router } from "express";
import { Types } from "mongoose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authMiddleware } from "../../../middleware/auth.middleware";
import { aiLimiter } from "../../../middleware/rate-limit.middleware";
import { createTaskMindMcpServer } from "./taskmind-mcp.server";
import { isValidConnectorId } from "./mcp-connectors.config";
import { mcpClientManager } from "./mcp-client.manager";

const mcpRouter = Router();

// Yêu cầu đăng nhập JWT/Cookie & áp dụng rate limit theo userId
mcpRouter.use(authMiddleware);
mcpRouter.use(aiLimiter);

const getAuthenticatedUser = (
  req: Request,
): { userId: string; googleAccessToken?: string } | null => {
  const user = (req as any).user;
  const userId = user?.userId ? String(user.userId).trim() : "";
  if (!userId || !Types.ObjectId.isValid(userId)) return null;
  return {
    userId,
    googleAccessToken: user?.googleAccessToken
      ? String(user.googleAccessToken)
      : undefined,
  };
};

const handleConnectorError = (
  res: Response,
  err: unknown,
  connectorId?: string,
): void => {
  const code = err instanceof Error ? err.message : "UNKNOWN";
  if (code === "MCP_CONNECTOR_UNKNOWN") {
    res
      .status(400)
      .json({ message: `Connector MCP không hợp lệ: ${connectorId ?? ""}` });
    return;
  }
  if (code === "MCP_TOOL_NAME_REQUIRED") {
    res.status(400).json({ message: "Thiếu tên tool (toolName)" });
    return;
  }
  if (code === "MCP_CONNECTOR_DISABLED" || code === "MCP_CONNECTOR_NOT_CONFIGURED") {
    res.status(503).json({
      message: `Connector '${connectorId ?? ""}' chưa được bật hoặc chưa cấu hình trên server.`,
    });
    return;
  }
  if (code === "MCP_CONNECTOR_TOKEN_MISSING") {
    const hint =
      connectorId === "google_calendar"
        ? "Vui lòng đăng nhập bằng Google OAuth hoặc truyền token qua header x-mcp-token."
        : "Vui lòng truyền Personal Access Token qua header x-mcp-token (hoặc cấu hình token mặc định trên server).";
    res.status(400).json({
      message: `Thiếu token xác thực cho connector '${connectorId ?? ""}'. ${hint}`,
    });
    return;
  }
  if (code === "MCP_CALL_TIMEOUT") {
    res.status(504).json({
      message: `Kết nối tới connector '${connectorId ?? ""}' bị quá thời gian (timeout).`,
    });
    return;
  }
  res.status(502).json({
    message: `Lỗi khi gọi MCP connector '${connectorId ?? ""}': ${code}`,
  });
};

mcpRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const userIdRaw = (req as any).user?.userId;
  const userId = userIdRaw ? String(userIdRaw).trim() : "";

  if (!userId || !Types.ObjectId.isValid(userId)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: invalid userId" },
      id: null,
    });
    return;
  }

  const server = createTaskMindMcpServer({ userId });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[TaskMind MCP HTTP Error]", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    }
  }
});

const methodNotAllowedHandler = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed in stateless MCP mode",
    },
    id: null,
  });
};

mcpRouter.get("/", methodNotAllowedHandler);
mcpRouter.delete("/", methodNotAllowedHandler);

// ─── Outbound MCP Client Hub endpoints ───────────────────────────────────────

mcpRouter.get("/connectors", (req: Request, res: Response): void => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    res.status(401).json({ message: "Chưa đăng nhập" });
    return;
  }

  const connectors = mcpClientManager.listConnectorsStatus({
    hasGoogleToken: Boolean(authUser.googleAccessToken),
  });
  res.status(200).json({ connectors });
});

mcpRouter.post(
  "/connectors/:connectorId/tools",
  async (req: Request, res: Response): Promise<void> => {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const connectorId = String(req.params.connectorId ?? "").trim();
    if (!isValidConnectorId(connectorId)) {
      res
        .status(400)
        .json({ message: `Connector MCP không hợp lệ: ${connectorId}` });
      return;
    }

    const headerToken = req.headers["x-mcp-token"];
    const userToken =
      typeof headerToken === "string"
        ? headerToken
        : typeof (req as any).body?.token === "string"
          ? (req as any).body.token
          : undefined;

    try {
      const tools = await mcpClientManager.listConnectorTools({
        userId: authUser.userId,
        connectorId,
        userToken,
        googleAccessToken: authUser.googleAccessToken,
      });
      res.status(200).json({ connectorId, count: tools.length, tools });
    } catch (err) {
      handleConnectorError(res, err, connectorId);
    }
  },
);

mcpRouter.post(
  "/connectors/:connectorId/call",
  async (req: Request, res: Response): Promise<void> => {
    const authUser = getAuthenticatedUser(req);
    if (!authUser) {
      res.status(401).json({ message: "Chưa đăng nhập" });
      return;
    }

    const connectorId = String(req.params.connectorId ?? "").trim();
    if (!isValidConnectorId(connectorId)) {
      res
        .status(400)
        .json({ message: `Connector MCP không hợp lệ: ${connectorId}` });
      return;
    }

    const body = (req as any).body ?? {};
    const toolName = String(body.toolName ?? "").trim();
    if (!toolName) {
      res.status(400).json({ message: "Thiếu tên tool (toolName)" });
      return;
    }

    const args =
      body.arguments && typeof body.arguments === "object"
        ? (body.arguments as Record<string, unknown>)
        : {};
    const headerToken = req.headers["x-mcp-token"];
    const userToken =
      typeof headerToken === "string"
        ? headerToken
        : typeof body.token === "string"
          ? body.token
          : undefined;

    try {
      const result = await mcpClientManager.callConnectorTool({
        userId: authUser.userId,
        connectorId,
        toolName,
        args,
        userToken,
        googleAccessToken: authUser.googleAccessToken,
      });
      res.status(200).json(result);
    } catch (err) {
      handleConnectorError(res, err, connectorId);
    }
  },
);

export default mcpRouter;
