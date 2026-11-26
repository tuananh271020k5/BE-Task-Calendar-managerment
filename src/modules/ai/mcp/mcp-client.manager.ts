import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { aiGuardrailService } from "../agents/ai-guardrails.service";
import { aiUsageService } from "../ai-usage.service";
import {
  getExternalConnectorConfigs,
  isValidConnectorId,
  type ExternalConnectorConfig,
  type ExternalConnectorId,
} from "./mcp-connectors.config";

export type TestTransportFactory = () =>
  | Promise<{ transport: Transport; cleanup?: () => Promise<void> | void }>
  | { transport: Transport; cleanup?: () => Promise<void> | void };

const testTransportRegistry = new Map<
  ExternalConnectorId,
  TestTransportFactory
>();

export type ConnectorPublicStatus = {
  id: ExternalConnectorId;
  name: string;
  description: string;
  transport: "http" | "stdio";
  enabled: boolean;
  authType: "bearer_pat" | "google_oauth";
  readyForUser: boolean;
};

export type ConnectorToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ConnectorCallResult = {
  connectorId: ExternalConnectorId;
  toolName: string;
  isError: boolean;
  content: Array<Record<string, unknown>>;
  guardrailFlags: string[];
};

const DEFAULT_TIMEOUT_MS = 15_000;

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutCode = "MCP_CALL_TIMEOUT",
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

const resolveConnectorToken = (
  config: ExternalConnectorConfig,
  params: { userToken?: string; googleAccessToken?: string },
): string => {
  if (config.authType === "google_oauth") {
    return (
      params.googleAccessToken?.trim() || params.userToken?.trim() || ""
    );
  }
  return (
    params.userToken?.trim() ||
    (config.envTokenKey ? process.env[config.envTokenKey]?.trim() : "") ||
    ""
  );
};

const buildTransport = async (
  config: ExternalConnectorConfig,
  token: string,
  testFactory?: TestTransportFactory,
): Promise<{ transport: Transport; cleanup?: () => Promise<void> | void }> => {
  if (testFactory) {
    return await testFactory();
  }

  if (config.transport === "http") {
    if (!config.url) {
      throw new Error("MCP_CONNECTOR_NOT_CONFIGURED");
    }
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    });
    return { transport };
  }

  if (process.env.MCP_ALLOW_STDIO !== "true" || !config.stdioCommand) {
    throw new Error("MCP_CONNECTOR_DISABLED");
  }

  const transport = new StdioClientTransport({
    command: config.stdioCommand,
    args: config.stdioArgs ?? [],
  });
  return { transport };
};

const withConnectorClient = async <T>(
  params: {
    connectorId: string;
    userToken?: string;
    googleAccessToken?: string;
    timeoutMs?: number;
  },
  fn: (client: Client, config: ExternalConnectorConfig) => Promise<T>,
): Promise<T> => {
  if (!isValidConnectorId(params.connectorId)) {
    throw new Error("MCP_CONNECTOR_UNKNOWN");
  }

  const configs = getExternalConnectorConfigs();
  const config = configs[params.connectorId];
  const testFactory = testTransportRegistry.get(params.connectorId);

  if (!config.enabled && !testFactory) {
    throw new Error("MCP_CONNECTOR_DISABLED");
  }

  const token = resolveConnectorToken(config, {
    userToken: params.userToken,
    googleAccessToken: params.googleAccessToken,
  });

  if (!token && !testFactory) {
    throw new Error("MCP_CONNECTOR_TOKEN_MISSING");
  }

  const timeoutMs = Math.min(
    Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500),
    60_000,
  );

  const client = new Client({
    name: "taskmind-mcp-client",
    version: "1.0.0",
  });

  const { transport, cleanup } = await buildTransport(
    config,
    token,
    testFactory,
  );

  try {
    return await withTimeout(
      (async () => {
        await client.connect(transport);
        return await fn(client, config);
      })(),
      timeoutMs,
      "MCP_CALL_TIMEOUT",
    );
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close error
    }
    try {
      await transport.close();
    } catch {
      // ignore close error
    }
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // ignore cleanup error
      }
    }
  }
};

export const mcpClientManager = {
  registerTestTransportFactory: (
    connectorId: ExternalConnectorId,
    factory: TestTransportFactory,
  ): void => {
    testTransportRegistry.set(connectorId, factory);
  },

  clearTestTransportFactories: (): void => {
    testTransportRegistry.clear();
  },

  listConnectorsStatus: (ctx: {
    hasGoogleToken?: boolean;
  }): ConnectorPublicStatus[] => {
    const configs = getExternalConnectorConfigs();
    return (Object.keys(configs) as ExternalConnectorId[]).map((id) => {
      const cfg = configs[id];
      const hasEnvPat = Boolean(
        cfg.envTokenKey && process.env[cfg.envTokenKey]?.trim(),
      );
      const readyForUser =
        cfg.enabled &&
        (cfg.authType === "google_oauth"
          ? Boolean(ctx.hasGoogleToken)
          : hasEnvPat);

      return {
        id: cfg.id,
        name: cfg.name,
        description: cfg.description,
        transport: cfg.transport,
        enabled: cfg.enabled,
        authType: cfg.authType,
        readyForUser,
      };
    });
  },

  listConnectorTools: async (params: {
    userId: string;
    connectorId: ExternalConnectorId;
    userToken?: string;
    googleAccessToken?: string;
    timeoutMs?: number;
  }): Promise<ConnectorToolInfo[]> => {
    const startedAt = Date.now();
    try {
      const tools = await withConnectorClient(params, async (client) => {
        const res = await client.listTools();
        return (res.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      });

      await aiUsageService.recordUsage({
        userId: params.userId,
        feature: "mcp_client",
        route: `MCP_LIST:${params.connectorId}`,
        model: `mcp:${params.connectorId}`,
        provider: "mcp",
        latencyMs: Date.now() - startedAt,
        status: "ok",
        meta: { toolCount: tools.length },
      });

      return tools;
    } catch (err) {
      await aiUsageService.recordUsage({
        userId: params.userId,
        feature: "mcp_client",
        route: `MCP_LIST:${params.connectorId}`,
        model: `mcp:${params.connectorId}`,
        provider: "mcp",
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: err instanceof Error ? err.message : "UNKNOWN",
      });
      throw err;
    }
  },

  callConnectorTool: async (params: {
    userId: string;
    connectorId: ExternalConnectorId;
    toolName: string;
    args?: Record<string, unknown>;
    userToken?: string;
    googleAccessToken?: string;
    timeoutMs?: number;
  }): Promise<ConnectorCallResult> => {
    const startedAt = Date.now();
    const toolName = String(params.toolName ?? "").trim();
    if (!toolName) {
      throw new Error("MCP_TOOL_NAME_REQUIRED");
    }

    try {
      const rawRes = await withConnectorClient(params, async (client) => {
        return await client.callTool({
          name: toolName,
          arguments: params.args ?? {},
        });
      });

      const flagsSet = new Set<string>();
      const rawContent = Array.isArray((rawRes as any)?.content)
        ? ((rawRes as any).content as Array<Record<string, unknown>>)
        : [];

      const sanitizedContent = rawContent.map((item) => {
        if (item?.type === "text" && typeof item.text === "string") {
          const checked = aiGuardrailService.validateAndSanitizeOutput(
            item.text,
            { validateInternalRoutes: false },
          );
          for (const f of checked.flags) flagsSet.add(f);
          return { ...item, text: checked.content };
        }
        return item;
      });

      const guardrailFlags = Array.from(flagsSet);
      await aiUsageService.recordUsage({
        userId: params.userId,
        feature: "mcp_client",
        route: `MCP_CALL:${params.connectorId}:${toolName}`,
        model: `mcp:${params.connectorId}`,
        provider: "mcp",
        latencyMs: Date.now() - startedAt,
        guardrailTriggered: guardrailFlags.length
          ? guardrailFlags.join(",")
          : undefined,
        status: "ok",
        meta: { isError: Boolean((rawRes as any)?.isError) },
      });

      return {
        connectorId: params.connectorId,
        toolName,
        isError: Boolean((rawRes as any)?.isError),
        content: sanitizedContent,
        guardrailFlags,
      };
    } catch (err) {
      await aiUsageService.recordUsage({
        userId: params.userId,
        feature: "mcp_client",
        route: `MCP_CALL:${params.connectorId}:${toolName}`,
        model: `mcp:${params.connectorId}`,
        provider: "mcp",
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: err instanceof Error ? err.message : "UNKNOWN",
      });
      throw err;
    }
  },
};
