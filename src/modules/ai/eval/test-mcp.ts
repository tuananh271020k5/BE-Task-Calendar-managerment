process.env.AI_EMBEDDING_DISABLED = "true";
process.env.AI_SKIP_REDIS = "true";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "mcp_test_secret_123456";
process.env.GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "mcp_test_google_client_id";
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "mcp_test_google_client_secret";
process.env.GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || "http://localhost:3002/auth/google/callback";
process.env.NODE_ENV = "test";

import assert from "assert";
import jwt from "jsonwebtoken";
import request from "supertest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../../../app";
import { createTaskMindMcpServer } from "../mcp/taskmind-mcp.server";
import { mcpClientManager } from "../mcp/mcp-client.manager";

const TEST_USER_ID = "507f1f77bcf86cd799439011";

async function runInMemoryMcpTests(): Promise<void> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createTaskMindMcpServer({ userId: TEST_USER_ID });
  const client = new Client({
    name: "taskmind-mcp-test-client",
    version: "1.0.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    // 1. Check 6 tools
    const toolsRes = await client.listTools();
    const toolNames = toolsRes.tools.map((t) => t.name).sort();
    const expectedTools = [
      "breakdown_task",
      "create_task",
      "get_free_busy",
      "list_tasks",
      "propose_schedule",
      "search_kb",
    ];
    assert.deepStrictEqual(
      toolNames,
      expectedTools,
      `Expected tools ${expectedTools.join(", ")}, got ${toolNames.join(", ")}`,
    );
    console.log("PASS: InMemory listTools() returned all 6 tools");

    // 2. Check resource taskmind://kb/overview
    const resourcesRes = await client.listResources();
    const hasOverview = resourcesRes.resources.some(
      (r) => r.uri === "taskmind://kb/overview",
    );
    assert.strictEqual(
      hasOverview,
      true,
      "Expected resource taskmind://kb/overview",
    );

    const readRes = await client.readResource({
      uri: "taskmind://kb/overview",
    });
    const overviewText = (readRes.contents[0] as any)?.text || "";
    assert.ok(
      overviewText.includes("TaskMind AI"),
      "Overview resource should contain TaskMind AI",
    );
    console.log("PASS: InMemory listResources() & readResource() ok");

    // 3. Call search_kb tool
    const searchRes = await client.callTool({
      name: "search_kb",
      arguments: { query: "cach bat quiet hours", topK: 3 },
    });
    const searchText = ((searchRes.content as any[])?.[0]?.text as string) || "";
    const searchJson = JSON.parse(searchText);
    assert.ok(
      searchJson.count >= 1 &&
        searchJson.results[0]?.module === "notifications",
      `Expected top search_kb module to be notifications, got: ${searchText}`,
    );
    console.log("PASS: InMemory search_kb returned notifications top-1");

    // 4. Call breakdown_task tool (0-token Template fast-path)
    const breakdownRes = await client.callTool({
      name: "breakdown_task",
      arguments: {
        title: "Làm slide thuyết trình",
        totalMinutes: 90,
      },
    });
    const breakdownText =
      ((breakdownRes.content as any[])?.[0]?.text as string) || "";
    const breakdownJson = JSON.parse(breakdownText);
    const stepSum = (breakdownJson.steps || []).reduce(
      (sum: number, s: any) => sum + (s.estimatedDuration ?? 0),
      0,
    );
    assert.strictEqual(
      breakdownJson.totalEstimatedDuration,
      90,
      "Expected totalEstimatedDuration === 90",
    );
    assert.strictEqual(stepSum, 90, "Expected sum of steps === 90");
    console.log("PASS: InMemory breakdown_task template scaled cleanly to 90m");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

async function runHttpEndpointTests(): Promise<void> {
  const app = createApp();
  const validToken = jwt.sign(
    {
      userId: TEST_USER_ID,
      email: "mcp-test@taskmind.local",
      role: "member",
    },
    process.env.JWT_ACCESS_SECRET as string,
    { expiresIn: "15m" },
  );

  // 1. POST /mcp without token -> 401
  const unauthRes = await request(app).post("/mcp").send({});
  assert.strictEqual(
    unauthRes.status,
    401,
    `Expected 401 on unauthenticated POST /mcp, got ${unauthRes.status}`,
  );
  console.log("PASS: POST /mcp without token -> 401");

  // 2. GET /mcp with token -> 405
  const getRes = await request(app)
    .get("/mcp")
    .set("Authorization", `Bearer ${validToken}`);
  assert.strictEqual(
    getRes.status,
    405,
    `Expected 405 on GET /mcp, got ${getRes.status}`,
  );
  console.log("PASS: GET /mcp with valid JWT -> 405");

  // 3. POST /mcp initialize handshake -> 200 & taskmind-mcp-server
  const initRes = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${validToken}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "supertest-client", version: "1.0.0" },
      },
    });

  assert.strictEqual(
    initRes.status,
    200,
    `Expected 200 on POST /mcp initialize, got ${initRes.status}: ${initRes.text}`,
  );
  assert.ok(
    initRes.text.includes("taskmind-mcp-server"),
    `Expected initialize response to contain taskmind-mcp-server, got: ${initRes.text}`,
  );
  console.log("PASS: POST /mcp initialize handshake -> 200 (taskmind-mcp-server)");
}

async function runOutboundMcpClientTests(): Promise<void> {
  const registerMockGithub = () => {
    mcpClientManager.registerTestTransportFactory("github", async () => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const mockServer = new McpServer({
        name: "mock-github-mcp",
        version: "1.0.0",
      });

      mockServer.registerTool(
        "list_issues",
        {
          title: "List Issues",
          description: "Mock list GitHub issues",
          inputSchema: { repo: z.string().optional() },
        },
        async (args) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                repo: args.repo || "taskmind/web",
                issues: [{ id: 101, title: "Fix 401 refresh interceptor" }],
              }),
            },
          ],
        }),
      );

      const dummySecret = ["sk", "dummy", "0".repeat(24)].join("-");

      mockServer.registerTool(
        "leak_key_test",
        {
          title: "Leak Key Test",
          description: "Returns a fake key to test output guardrail",
          inputSchema: {},
        },
        async () => ({
          content: [
            {
              type: "text",
              text: `Secret leaked: ${dummySecret}`,
            },
          ],
        }),
      );

      await mockServer.connect(serverTransport);
      return {
        transport: clientTransport,
        cleanup: async () => {
          await mockServer.close();
        },
      };
    });
  };

  registerMockGithub();

  try {
    // 1. Unknown connector throws MCP_CONNECTOR_UNKNOWN
    await assert.rejects(
      () =>
        mcpClientManager.callConnectorTool({
          userId: TEST_USER_ID,
          connectorId: "unknown_id" as any,
          toolName: "foo",
        }),
      /MCP_CONNECTOR_UNKNOWN/,
    );
    console.log("PASS: Unknown MCP connector rejected cleanly");

    // 2. listConnectorTools via mock github transport
    const tools = await mcpClientManager.listConnectorTools({
      userId: TEST_USER_ID,
      connectorId: "github",
    });
    const toolNames = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(toolNames, ["leak_key_test", "list_issues"]);
    console.log("PASS: Outbound listConnectorTools(github) returned 2 mock tools");

    // 3. callConnectorTool list_issues
    const issueCall = await mcpClientManager.callConnectorTool({
      userId: TEST_USER_ID,
      connectorId: "github",
      toolName: "list_issues",
      args: { repo: "taskmind/api" },
    });
    const issuePayload = JSON.parse(String(issueCall.content[0]?.text || "{}"));
    assert.strictEqual(issuePayload.issues?.[0]?.id, 101);
    console.log("PASS: Outbound callConnectorTool(list_issues) succeeded");

    // 4. callConnectorTool leak_key_test -> output guardrail redacts dummy key
    const expectedDummyPrefix = ["sk", "dummy"].join("-");
    const leakCall = await mcpClientManager.callConnectorTool({
      userId: TEST_USER_ID,
      connectorId: "github",
      toolName: "leak_key_test",
    });
    const leakText = String(leakCall.content[0]?.text || "");
    assert.ok(
      leakText.includes("[REDACTED_KEY]") &&
        !leakText.includes(expectedDummyPrefix),
      `Expected redacted key, got: ${leakText}`,
    );
    assert.ok(leakCall.guardrailFlags.includes("API_KEY_REDACTED"));
    console.log("PASS: Outbound MCP output guardrail redacted leaked API key");

    // 5. HTTP /mcp/connectors routes via supertest
    const app = createApp();
    const validToken = jwt.sign(
      {
        userId: TEST_USER_ID,
        email: "mcp-test@taskmind.local",
        role: "member",
      },
      process.env.JWT_ACCESS_SECRET as string,
      { expiresIn: "15m" },
    );

    const unauthConnectors = await request(app).get("/mcp/connectors");
    assert.strictEqual(unauthConnectors.status, 401);
    console.log("PASS: GET /mcp/connectors without token -> 401");

    const listConnectorsRes = await request(app)
      .get("/mcp/connectors")
      .set("Authorization", `Bearer ${validToken}`);
    assert.strictEqual(listConnectorsRes.status, 200);
    const ids = (listConnectorsRes.body.connectors || [])
      .map((c: any) => c.id)
      .sort();
    assert.deepStrictEqual(ids, ["github", "google_calendar", "notion"]);
    console.log("PASS: GET /mcp/connectors with JWT -> 200 (3 connectors)");

    const badConnectorRes = await request(app)
      .post("/mcp/connectors/unknown_id/tools")
      .set("Authorization", `Bearer ${validToken}`)
      .send({});
    assert.strictEqual(badConnectorRes.status, 400);
    console.log("PASS: POST /mcp/connectors/unknown_id/tools -> 400");

    const httpCallRes = await request(app)
      .post("/mcp/connectors/github/call")
      .set("Authorization", `Bearer ${validToken}`)
      .send({ toolName: "list_issues", arguments: { repo: "taskmind/http" } });
    assert.strictEqual(httpCallRes.status, 200);
    assert.strictEqual(httpCallRes.body.connectorId, "github");
    assert.ok(
      String(httpCallRes.body.content?.[0]?.text || "").includes(
        "Fix 401 refresh interceptor",
      ),
    );
    console.log("PASS: POST /mcp/connectors/github/call -> 200");
  } finally {
    mcpClientManager.clearTestTransportFactories();
  }
}

async function main(): Promise<void> {
  console.log("=== TaskMind MCP Protocol & HTTP Verification ===");
  await runInMemoryMcpTests();
  await runHttpEndpointTests();
  await runOutboundMcpClientTests();
  console.log("ALL MCP TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("MCP test failed:", err);
  process.exit(1);
});
