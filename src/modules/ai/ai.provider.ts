import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type AiChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

export type AiChatPurpose = "chat" | "breakdown" | "schedule" | "generic";

export type AiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AiToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type AiChatInput = {
  messages: AiChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Logical purpose of this call, used to route to the best provider:
   * - "chat": realtime chat → prefers Groq (fast)
   * - "breakdown": task planning/reasoning → prefers Gemini (smarter)
   * - "schedule"/"generic": default routing
   */
  purpose?: AiChatPurpose;
  /** Force JSON output (supported by Groq/OpenAI-compatible APIs) */
  responseFormat?: "json_object" | "text";
  /** Optional tool definitions exposed to the LLM (Groq/OpenAI tool-calling). */
  tools?: AiToolDefinition[];
  /** Tool choice hint for tool-enabled requests. */
  toolChoice?: "auto" | "required" | "none";
};

export type AiChatResult = {
  content: string;
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  toolCalls?: AiToolCall[];
};

export type AiChatStreamChunk = {
  type: "delta";
  delta: string;
};

export type AiChatStreamMeta = {
  type: "meta";
  conversationId: string;
};

export type AiChatStreamDone = {
  type: "done";
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

export type AiChatStreamEvent =
  | AiChatStreamMeta
  | AiChatStreamChunk
  | AiChatStreamDone;

export type AiProvider = {
  chat: (input: AiChatInput) => Promise<AiChatResult>;
  chatStream: (input: AiChatInput) => AsyncGenerator<AiChatStreamEvent>;
  chatWithTools: (input: AiChatInput) => Promise<AiChatResult>;
};

const resolveOpenAiModel = (inputModel?: string): string => {
  const candidate = (inputModel || "").trim();
  const lower = candidate.toLowerCase();
  if (
    candidate &&
    !lower.includes("gemini") &&
    !lower.includes("llama") &&
    !lower.includes("groq") &&
    !lower.includes("openai/")
  ) {
    return candidate;
  }
  return (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
};

const resolveGroqModel = (inputModel?: string): string => {
  const candidate = (inputModel || "").trim();
  const lower = candidate.toLowerCase();
  if (
    candidate &&
    !lower.includes("gpt-") &&
    !lower.includes("gemini")
  ) {
    return candidate;
  }
  return (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();
};

const groqChat = async (input: AiChatInput): Promise<AiChatResult> => {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) throw new Error("GROQ_API_KEY_MISSING");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });

  const model = resolveGroqModel(input.model);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      ...(input.responseFormat === "json_object"
        ? { response_format: { type: "json_object" as const } }
        : {}),
    });
    const content = response.choices?.[0]?.message?.content ?? "";
    return {
      content,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: (response.usage as any).prompt_tokens,
            completionTokens: (response.usage as any).completion_tokens,
            totalTokens: (response.usage as any).total_tokens,
          }
        : undefined,
    };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("GROQ_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("GROQ_UNAUTHORIZED");
    throw err;
  }
};

const groqChatStream = async function* (
  input: AiChatInput,
): AsyncGenerator<AiChatStreamEvent> {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) throw new Error("GROQ_API_KEY_MISSING");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });

  const model = resolveGroqModel(input.model);

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      stream: true,
    });

    for await (const chunk of stream as any) {
      const delta =
        chunk?.choices?.[0]?.delta?.content !== undefined
          ? String(chunk.choices[0].delta.content)
          : "";
      if (delta) yield { type: "delta", delta };
    }
    yield { type: "done", model };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("GROQ_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("GROQ_UNAUTHORIZED");
    throw err;
  }
};

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const buildGeminiChatPayload = (input: AiChatInput) => {
  let systemInstruction = "";
  const rawTurns: { role: "user" | "model"; text: string }[] = [];

  for (const m of input.messages) {
    if (m.role === "system") {
      if (m.content) systemInstruction += m.content + "\n";
      continue;
    }

    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    let text =
      m.role === "tool"
        ? `[TOOL RESULT] ${m.content}`
        : String(m.content ?? "");

    if (!text.trim() && m.tool_calls?.length) {
      text = `[TOOL CALL] ${m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ")}`;
    }
    if (!text.trim()) continue;

    if (rawTurns.length > 0 && rawTurns[rawTurns.length - 1].role === role) {
      rawTurns[rawTurns.length - 1].text += `\n${text}`;
    } else {
      rawTurns.push({ role, text });
    }
  }

  // Gemini requires chat history to start with a "user" turn
  while (rawTurns.length > 1 && rawTurns[0].role === "model") {
    rawTurns.shift();
  }

  let history = rawTurns.slice(0, -1).map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));
  let msg =
    rawTurns.length > 0 ? rawTurns[rawTurns.length - 1].text : "";

  if (rawTurns.length > 0 && rawTurns[rawTurns.length - 1].role === "model") {
    history = rawTurns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
    msg = "Tiếp tục.";
  }

  const requestedModel = (input.model || "").trim();
  const modelName = requestedModel.toLowerCase().includes("gemini")
    ? requestedModel
    : (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();

  return {
    modelName,
    systemInstruction: systemInstruction.trim(),
    history,
    msg,
    generationConfig: {
      ...(input.temperature !== undefined && {
        temperature: input.temperature,
      }),
      // gemini-2.5-flash counts internal thinking tokens toward maxOutputTokens,
      // so add headroom when callers pass small OpenAI-style maxTokens caps.
      ...(input.maxTokens !== undefined && {
        maxOutputTokens: Math.max(input.maxTokens + 512, 1024),
      }),
      ...(input.responseFormat === "json_object" && {
        responseMimeType: "application/json",
      }),
    },
  };
};

const geminiChat = async (input: AiChatInput): Promise<AiChatResult> => {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const genAI = new GoogleGenerativeAI(apiKey);
  const { modelName, systemInstruction, history, msg, generationConfig } =
    buildGeminiChatPayload(input);

  const model = genAI.getGenerativeModel({
    model: modelName,
    ...(systemInstruction && { systemInstruction }),
    generationConfig,
  });

  const chat = model.startChat({ history });

  try {
    const result = await chat.sendMessage(msg);
    const meta = (result.response as any)?.usageMetadata;
    return {
      content: result.response.text(),
      model: modelName,
      usage: meta
        ? {
            promptTokens: meta.promptTokenCount,
            completionTokens: meta.candidatesTokenCount,
            totalTokens: meta.totalTokenCount,
          }
        : undefined,
    };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const errMsg = String(err?.message || "").toLowerCase();
    if (
      status === 429 ||
      errMsg.includes("429") ||
      errMsg.includes("resource_exhausted") ||
      errMsg.includes("resource has been exhausted") ||
      errMsg.includes("quota") ||
      errMsg.includes("rate limit")
    )
      throw new Error("GEMINI_RATE_LIMIT");
    if (
      status === 401 ||
      status === 403 ||
      errMsg.includes("permission_denied") ||
      errMsg.includes("api key not valid")
    )
      throw new Error("GEMINI_UNAUTHORIZED");
    throw err;
  }
};

const geminiChatStream = async function* (
  input: AiChatInput,
): AsyncGenerator<AiChatStreamEvent> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY_MISSING");

  const genAI = new GoogleGenerativeAI(apiKey);
  const { modelName, systemInstruction, history, msg, generationConfig } =
    buildGeminiChatPayload(input);

  const model = genAI.getGenerativeModel({
    model: modelName,
    ...(systemInstruction && { systemInstruction }),
    generationConfig,
  });

  const chat = model.startChat({ history });

  try {
    const result = await chat.sendMessageStream(msg);
    for await (const chunk of result.stream) {
      if (chunk.text()) {
        yield { type: "delta", delta: chunk.text() };
      }
    }
    let usage: AiChatResult["usage"];
    try {
      const finalResp = await result.response;
      const meta = (finalResp as any)?.usageMetadata;
      if (meta) {
        usage = {
          promptTokens: meta.promptTokenCount,
          completionTokens: meta.candidatesTokenCount,
          totalTokens: meta.totalTokenCount,
        };
      }
    } catch {
      // Optional usage metadata
    }
    yield { type: "done", model: modelName, usage };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const errMsg = String(err?.message || "").toLowerCase();
    if (
      status === 429 ||
      errMsg.includes("429") ||
      errMsg.includes("resource_exhausted") ||
      errMsg.includes("resource has been exhausted") ||
      errMsg.includes("quota") ||
      errMsg.includes("rate limit")
    )
      throw new Error("GEMINI_RATE_LIMIT");
    if (
      status === 401 ||
      status === 403 ||
      errMsg.includes("permission_denied") ||
      errMsg.includes("api key not valid")
    )
      throw new Error("GEMINI_UNAUTHORIZED");
    throw err;
  }
};

const hasOpenAiKey = (): boolean => !!(process.env.OPENAI_API_KEY || "").trim();

const openaiChat = async (input: AiChatInput): Promise<AiChatResult> => {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

  const client = new OpenAI({ apiKey });
  const model = resolveOpenAiModel(input.model);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
      ...(input.responseFormat === "json_object"
        ? { response_format: { type: "json_object" as const } }
        : {}),
    });
    const content = response.choices?.[0]?.message?.content ?? "";
    return {
      content,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: (response.usage as any).prompt_tokens,
            completionTokens: (response.usage as any).completion_tokens,
            totalTokens: (response.usage as any).total_tokens,
          }
        : undefined,
    };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("OPENAI_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("OPENAI_UNAUTHORIZED");
    throw err;
  }
};

const openaiChatStream = async function* (
  input: AiChatInput,
): AsyncGenerator<AiChatStreamEvent> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

  const client = new OpenAI({ apiKey });
  const model = resolveOpenAiModel(input.model);

  try {
    const stream = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
      stream: true,
    });

    for await (const chunk of stream as any) {
      const delta =
        chunk?.choices?.[0]?.delta?.content !== undefined
          ? String(chunk.choices[0].delta.content)
          : "";
      if (delta) yield { type: "delta", delta };
    }
    yield { type: "done", model };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("OPENAI_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("OPENAI_UNAUTHORIZED");
    throw err;
  }
};

const openaiChatWithTools = async (
  input: AiChatInput,
): Promise<AiChatResult> => {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

  const client = new OpenAI({ apiKey });
  const model = resolveOpenAiModel(input.model);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
      ...(input.tools && input.tools.length
        ? { tools: input.tools as any, tool_choice: input.toolChoice ?? "auto" }
        : {}),
    });

    const choice = response.choices?.[0]?.message;
    const content = choice?.content ?? "";
    const rawToolCalls = (choice as any)?.tool_calls as
      | {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }[]
      | undefined;

    const toolCalls: AiToolCall[] | undefined =
      rawToolCalls && rawToolCalls.length
        ? rawToolCalls
            .filter((c) => c.type === "function" && c.function?.name)
            .map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: c.function.arguments || "{}",
            }))
        : undefined;

    return {
      content,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: (response.usage as any).prompt_tokens,
            completionTokens: (response.usage as any).completion_tokens,
            totalTokens: (response.usage as any).total_tokens,
          }
        : undefined,
      toolCalls,
    };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("OPENAI_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("OPENAI_UNAUTHORIZED");
    throw err;
  }
};

type ProviderName = "openai" | "groq" | "gemini";

const hasGroqKey = (): boolean => !!(process.env.GROQ_API_KEY || "").trim();
const hasGeminiKey = (): boolean => !!(process.env.GEMINI_API_KEY || "").trim();

/**
 * Provider order: prefer OpenAI (gpt-4o-mini), then Groq, then Gemini.
 */
const resolveProviderOrder = (_purpose?: AiChatPurpose): ProviderName[] => {
  const order: ProviderName[] = [];
  if (hasOpenAiKey()) order.push("openai");
  if (hasGroqKey()) order.push("groq");
  if (hasGeminiKey()) order.push("gemini");
  return order;
};

const runChat = async (
  provider: ProviderName,
  input: AiChatInput,
): Promise<AiChatResult> => {
  if (provider === "openai") return openaiChat(input);
  if (provider === "groq") return groqChat(input);
  return geminiChat(input);
};

const runChatStream = async function* (
  provider: ProviderName,
  input: AiChatInput,
): AsyncGenerator<AiChatStreamEvent> {
  if (provider === "openai") {
    yield* openaiChatStream(input);
    return;
  }
  if (provider === "groq") {
    yield* groqChatStream(input);
    return;
  }
  yield* geminiChatStream(input);
};

const runChatWithTools = async (
  provider: ProviderName,
  input: AiChatInput,
): Promise<AiChatResult> => {
  if (provider === "openai") return openaiChatWithTools(input);
  if (provider === "groq") return groqChatWithTools(input);
  return geminiChat(input);
};

const isRetriableError = (err: any): boolean => {
  const msg = String(err?.message || "");
  if (
    msg.includes("RATE_LIMIT") ||
    msg.includes("UNAUTHORIZED") ||
    msg.includes("API_KEY_MISSING")
  )
    return true;
  const lower = msg.toLowerCase();
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource has been exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("permission_denied") ||
    lower.includes("api key not valid") ||
    lower.includes("connection error") ||
    lower.includes("fetch failed") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("enotfound")
  )
    return true;
  const status = err?.status ?? err?.response?.status;
  return status === 429 || status === 500 || status === 502 || status === 503;
};

const groqChatWithTools = async (input: AiChatInput): Promise<AiChatResult> => {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) throw new Error("GROQ_API_KEY_MISSING");

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  });

  // gpt-oss-20b on Groq emits proper OpenAI tool_calls reliably; Llama models
  // frequently regress to `<function=NAME(...)></function>` text. Prefer OSS.
  const model = (
    input.model ||
    process.env.GROQ_TOOL_MODEL ||
    "openai/gpt-oss-20b"
  ).trim();

  try {
    const response = await client.chat.completions.create({
      model,
      messages: input.messages as any,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      ...(input.tools && input.tools.length
        ? { tools: input.tools as any, tool_choice: input.toolChoice ?? "auto" }
        : {}),
    });

    const choice = response.choices?.[0]?.message;
    const content = choice?.content ?? "";
    const rawToolCalls = (choice as any)?.tool_calls as
      | {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }[]
      | undefined;

    const toolCalls: AiToolCall[] | undefined =
      rawToolCalls && rawToolCalls.length
        ? rawToolCalls
            .filter((c) => c.type === "function" && c.function?.name)
            .map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: c.function.arguments || "{}",
            }))
        : undefined;

    return {
      content,
      model: response.model,
      usage: response.usage
        ? {
            promptTokens: (response.usage as any).prompt_tokens,
            completionTokens: (response.usage as any).completion_tokens,
            totalTokens: (response.usage as any).total_tokens,
          }
        : undefined,
      toolCalls,
    };
  } catch (err: any) {
    if (err?.status === 429) throw new Error("GROQ_RATE_LIMIT");
    if (err?.status === 401 || err?.status === 403)
      throw new Error("GROQ_UNAUTHORIZED");

    // Groq sometimes rejects malformed tool calls (Llama models occasionally
    // emit `<function=NAME({...})</function>` text instead of structured
    // tool_calls). Salvage the call from `failed_generation` so the upstream
    // loop can still execute the tool.
    const code = err?.code || err?.error?.code;
    const failedGen: string | undefined =
      err?.error?.failed_generation ||
      err?.response?.data?.error?.failed_generation;
    if (code === "tool_use_failed" && typeof failedGen === "string") {
      const salvaged = salvageMalformedToolCall(failedGen);
      if (salvaged) {
        return {
          content: "",
          model,
          toolCalls: [salvaged],
        };
      }
    }

    throw err;
  }
};

/**
 * Parse Llama "tool_use_failed" generations into an AiToolCall. Groq returns
 * different malformations:
 *   - `<function=NAME({"a":1})</function>`     (with parens)
 *   - `<function=NAME {"a":1}</function>`      (no parens, just whitespace)
 *   - `<function=NAME({"a":1})>`               (no close tag)
 *   - `<|python_tag|>NAME.call({"a":1})`       (rare)
 * The JSON arguments are always usable; only the wrapper differs.
 */
const salvageMalformedToolCall = (raw: string): AiToolCall | null => {
  // 1) `<function=NAME` then `(...)` or whitespace, then JSON, optionally
  //    closed by `)` and `</function>` or `>`.
  const re =
    /<function\s*=\s*([a-zA-Z_][\w]*)\s*\(?\s*(\{[\s\S]*\})\s*\)?\s*<\/?function\s*>?/;
  const m = raw.match(re);
  if (m) {
    const name = m[1];
    const args = m[2];
    try {
      JSON.parse(args);
    } catch {
      return null;
    }
    return {
      id: `call_salvaged_${Date.now()}`,
      name,
      arguments: args,
    };
  }

  // 2) Fallback: any "NAME({...})" pattern in the raw text.
  const fallback = raw.match(/([a-zA-Z_][\w]*)\s*\(\s*(\{[\s\S]*\})\s*\)/);
  if (fallback) {
    const name = fallback[1];
    const args = fallback[2];
    try {
      JSON.parse(args);
    } catch {
      return null;
    }
    return {
      id: `call_salvaged_${Date.now()}`,
      name,
      arguments: args,
    };
  }

  return null;
};

export const aiProvider: AiProvider = {
  chat: async (input) => {
    const order = resolveProviderOrder(input.purpose);
    if (!order.length) throw new Error("OPENAI_API_KEY_MISSING");
    let lastErr: any;
    for (const p of order) {
      try {
        return await runChat(p, input);
      } catch (err) {
        lastErr = err;
        if (!isRetriableError(err)) throw err;
        console.warn(`[aiProvider] ${p} failed (${(err as any)?.message}).`);
      }
    }
    console.error(
      `[aiProvider] All providers failed. Order: ${order.join(" → ")}. Last error: ${(lastErr as any)?.message}`,
    );
    throw lastErr ?? new Error("AI_PROVIDER_FAILED");
  },
  chatStream: async function* (input) {
    const order = resolveProviderOrder(input.purpose);
    if (!order.length) throw new Error("OPENAI_API_KEY_MISSING");
    let lastErr: any;
    for (const p of order) {
      let emittedAnyDelta = false;
      try {
        for await (const ev of runChatStream(p, input)) {
          if (ev.type === "delta") emittedAnyDelta = true;
          yield ev;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (emittedAnyDelta || !isRetriableError(err)) throw err;
        console.warn(
          `[aiProvider] stream ${p} failed (${(err as any)?.message}).`,
        );
      }
    }
    throw lastErr ?? new Error("AI_PROVIDER_FAILED");
  },
  chatWithTools: async (input) => {
    const order = resolveProviderOrder(input.purpose);
    if (!order.length) throw new Error("OPENAI_API_KEY_MISSING");
    let lastErr: any;
    for (const p of order) {
      try {
        return await runChatWithTools(p, input);
      } catch (err) {
        lastErr = err;
        if (!isRetriableError(err)) throw err;
        console.warn(
          `[aiProvider] chatWithTools ${p} failed (${(err as any)?.message}).`,
        );
      }
    }
    throw lastErr ?? new Error("AI_PROVIDER_FAILED");
  },
};
