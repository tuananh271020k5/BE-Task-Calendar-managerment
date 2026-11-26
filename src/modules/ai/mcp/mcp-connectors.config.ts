export type ExternalConnectorId = "github" | "notion" | "google_calendar";

export type ExternalConnectorAuthType = "bearer_pat" | "google_oauth";

export type ExternalConnectorConfig = {
  id: ExternalConnectorId;
  name: string;
  description: string;
  transport: "http" | "stdio";
  url?: string;
  stdioCommand?: string;
  stdioArgs?: string[];
  authType: ExternalConnectorAuthType;
  envTokenKey?: string;
  enabled: boolean;
};

const VALID_CONNECTOR_IDS = new Set<string>([
  "github",
  "notion",
  "google_calendar",
]);

export const isValidConnectorId = (id: string): id is ExternalConnectorId =>
  VALID_CONNECTOR_IDS.has(id);

/**
 * Server-side whitelist of external MCP servers.
 * URLs & commands come strictly from server env/defaults (never from user input)
 * to prevent SSRF or arbitrary command execution.
 */
export const getExternalConnectorConfigs = (): Record<
  ExternalConnectorId,
  ExternalConnectorConfig
> => {
  const gcalUrl = process.env.MCP_GCAL_URL?.trim() || undefined;
  const gcalStdioCmd = process.env.MCP_GCAL_STDIO_CMD?.trim() || undefined;
  const gcalStdioArgs = process.env.MCP_GCAL_STDIO_ARGS
    ? process.env.MCP_GCAL_STDIO_ARGS.split(/\s+/).filter(Boolean)
    : undefined;
  const allowStdio = process.env.MCP_ALLOW_STDIO === "true";

  return {
    github: {
      id: "github",
      name: "GitHub MCP",
      description:
        "Đọc GitHub Issues / PR để tạo Task và chạy AI Breakdown theo đầu việc.",
      transport: "http",
      url:
        process.env.MCP_GITHUB_URL?.trim() ||
        "https://api.githubcopilot.com/mcp/",
      authType: "bearer_pat",
      envTokenKey: "GITHUB_MCP_TOKEN",
      enabled: process.env.MCP_GITHUB_ENABLED !== "false",
    },
    notion: {
      id: "notion",
      name: "Notion MCP",
      description:
        "Đọc trang ghi chú / tài liệu spec trên Notion làm ngữ cảnh cho Task.",
      transport: "http",
      url: process.env.MCP_NOTION_URL?.trim() || "https://mcp.notion.com/mcp",
      authType: "bearer_pat",
      envTokenKey: "NOTION_MCP_TOKEN",
      enabled: process.env.MCP_NOTION_ENABLED !== "false",
    },
    google_calendar: {
      id: "google_calendar",
      name: "Google Calendar MCP",
      description:
        "Đồng bộ sự kiện rảnh/bận hai chiều với Google Calendar bằng OAuth của user.",
      transport: gcalUrl ? "http" : "stdio",
      url: gcalUrl,
      stdioCommand: gcalStdioCmd,
      stdioArgs: gcalStdioArgs,
      authType: "google_oauth",
      enabled: Boolean(gcalUrl || (allowStdio && gcalStdioCmd)),
    },
  };
};
