/**
 * commandcode.ts — CommandCode subscription provider for pi
 *
 * CommandCode's public provider API is plan-gated, but the paid CLI/subscription
 * path uses /alpha/generate. This extension registers that path as one pi
 * provider: cmd.
 *
 * Auth priority:
 * 1. COMMAND_CODE_API_KEY env var
 * 2. ~/.commandcode/auth.json apiKey written by `cmd login`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

type InputModality = "text" | "image";

interface CommandCodeModel {
  id: string;
  name?: string;
  context_window?: number;
  contextWindow?: number;
  max_tokens?: number;
  maxTokens?: number;
  input_modalities?: string[];
  modalities?: { input?: string[] };
  pricing?: {
    input?: number | string;
    prompt?: number | string;
    output?: number | string;
    completion?: number | string;
    cache_read?: number | string;
    cacheRead?: number | string;
    cache_write?: number | string;
    cacheWrite?: number | string;
  };
}

const ALPHA_URL = "https://api.commandcode.ai/alpha/generate";
const COMMAND_CODE_VERSION = "0.26.21";
const CACHE_DIR = join(process.env.HOME ?? "/tmp", ".pi", "cache");
const CACHE_TTL = 6 * 60 * 60 * 1000;

const API_KEY_COMMAND =
  "!node -e \"const fs=require('fs'); const p=(process.env.HOME||'')+'/.commandcode/auth.json'; const env=process.env.COMMAND_CODE_API_KEY; if(env){process.stdout.write(env); process.exit(0)} try{const j=JSON.parse(fs.readFileSync(p,'utf8')); if(j.apiKey){process.stdout.write(j.apiKey); process.exit(0)}}catch{} process.exit(1)\"";

const REASONING_THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

function hasAuth(): boolean {
  if (process.env.COMMAND_CODE_API_KEY) return true;
  try {
    const raw = readFileSync(join(process.env.HOME ?? "", ".commandcode", "auth.json"), "utf8");
    return !!JSON.parse(raw).apiKey;
  } catch {
    return false;
  }
}

function readCache(key: string): any | null {
  try {
    const path = join(CACHE_DIR, `${key}.json`);
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key: string, data: any): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(data));
  } catch {}
}

function numeric(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isReasoningModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes("opus") ||
    lower.includes("sonnet") ||
    lower.includes("gpt-5") ||
    lower.includes("deepseek") ||
    lower.includes("glm-5") ||
    lower.includes("qwen") ||
    lower.includes("kimi") ||
    lower.includes("minimax")
  );
}

function inputModalities(model: CommandCodeModel): InputModality[] {
  const raw = model.input_modalities ?? model.modalities?.input ?? [];
  return raw.includes("image") ? ["text", "image"] : ["text"];
}

function cost(model: CommandCodeModel) {
  const pricing = model.pricing ?? {};
  return {
    input: numeric(pricing.input ?? pricing.prompt, 0),
    output: numeric(pricing.output ?? pricing.completion, 0),
    cacheRead: numeric(pricing.cacheRead ?? pricing.cache_read, 0),
    cacheWrite: numeric(pricing.cacheWrite ?? pricing.cache_write, 0),
  };
}

function displayName(id: string, prefix: string): string {
  return `${prefix} ${id}`;
}

const FALLBACK_BY_ID = new Map(fallbackCatalog().map((model) => [model.id, model]));

function withFallbackMetadata(model: CommandCodeModel): CommandCodeModel {
  return { ...(FALLBACK_BY_ID.get(model.id) ?? {}), ...model };
}

function normalizeModel(rawModel: CommandCodeModel) {
  const model = withFallbackMetadata(rawModel);
  const id = model.id;
  const reasoning = isReasoningModel(id);
  return {
    id,
    name: model.name ?? displayName(id, "CommandCode"),
    reasoning,
    input: inputModalities(model),
    contextWindow: model.contextWindow ?? model.context_window ?? 262144,
    maxTokens: model.maxTokens ?? model.max_tokens ?? 65536,
    cost: cost(model),
    ...(reasoning ? { thinkingLevelMap: REASONING_THINKING_LEVEL_MAP } : {}),
  };
}

function fallbackCatalog(): CommandCodeModel[] {
  return [
    { id: "claude-sonnet-4-6", context_window: 200000, max_tokens: 64000, input_modalities: ["text", "image"] },
    { id: "claude-opus-4-7", context_window: 200000, max_tokens: 32000, input_modalities: ["text", "image"] },
    { id: "claude-opus-4-6", context_window: 200000, max_tokens: 32000, input_modalities: ["text", "image"] },
    { id: "claude-haiku-4-5-20251001", context_window: 200000, max_tokens: 32000, input_modalities: ["text", "image"] },
    { id: "gpt-5.5", context_window: 400000, max_tokens: 128000 },
    { id: "gpt-5.4", context_window: 400000, max_tokens: 128000 },
    { id: "gpt-5.3-codex", context_window: 400000, max_tokens: 128000 },
    { id: "gpt-5.4-mini", context_window: 400000, max_tokens: 128000 },
    { id: "google/gemini-3.5-flash", context_window: 1048576, max_tokens: 65536, input_modalities: ["text", "image"] },
    { id: "google/gemini-3.1-flash-lite", context_window: 1048576, max_tokens: 65536, input_modalities: ["text", "image"] },
    { id: "moonshotai/Kimi-K2.6", context_window: 262144, max_tokens: 65536 },
    { id: "moonshotai/Kimi-K2.5", context_window: 262144, max_tokens: 65536 },
    { id: "zai-org/GLM-5.1", context_window: 202752, max_tokens: 32768 },
    { id: "zai-org/GLM-5", context_window: 202752, max_tokens: 32768 },
    { id: "MiniMaxAI/MiniMax-M2.7", context_window: 204800, max_tokens: 65536 },
    { id: "MiniMaxAI/MiniMax-M2.5", context_window: 204800, max_tokens: 65536 },
    { id: "deepseek/deepseek-v4-pro", context_window: 1048576, max_tokens: 128000 },
    { id: "deepseek/deepseek-v4-flash", context_window: 1048576, max_tokens: 128000 },
    { id: "Qwen/Qwen3.6-Max-Preview", context_window: 262144, max_tokens: 65536 },
    { id: "Qwen/Qwen3.6-Plus", context_window: 262144, max_tokens: 65536 },
    { id: "Qwen/Qwen3.7-Max", context_window: 262144, max_tokens: 65536 },
    { id: "stepfun/Step-3.5-Flash", context_window: 262144, max_tokens: 65536 },
  ];
}

function readApiKey(): string {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY;
  const raw = readFileSync(join(process.env.HOME ?? "", ".commandcode", "auth.json"), "utf8");
  const parsed = JSON.parse(raw) as { apiKey?: string };
  if (!parsed.apiKey) throw new Error("Missing CommandCode auth. Run `cmd login` or set COMMAND_CODE_API_KEY.");
  return parsed.apiKey;
}

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function textFromContent(content: string | (TextContent | ImageContent)[]): any[] {
  if (typeof content === "string") return [{ type: "text", text: sanitizeSurrogates(content) }];
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: sanitizeSurrogates(block.text) };
    return { type: "image", image: `data:${block.mimeType};base64,${block.data}` };
  });
}

function convertMessages(messages: Message[]): any[] {
  const out: any[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: textFromContent(message.content as any) });
    } else if (message.role === "assistant") {
      const content = (message.content ?? [])
        .filter((block) => block.type === "text" || block.type === "thinking" || block.type === "toolCall")
        .map((block) => {
          if (block.type === "text") return { type: "text", text: sanitizeSurrogates(block.text) };
          if (block.type === "thinking") return { type: "text", text: sanitizeSurrogates(block.thinking) };
          return { type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments };
        });
      if (content.length) out.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: {
              type: "text",
              value: (message.content ?? []).map((item) => (item.type === "text" ? item.text : `[image:${item.mimeType}]`)).join("\n"),
            },
          },
        ],
      });
    }
  }
  return out;
}

function convertTools(tools?: Tool[]): any[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? (tool as any).inputSchema ?? (tool as any).input_schema,
  }));
}

function projectSlug(): string {
  return (process.cwd() || "pi")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "pi";
}

function streamCommandCodeAlpha(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let activeTextIndex = -1;
    let activeThinkingIndex = -1;
    const toolPartToContentIndex = new Map<string, number>();
    const toolJson = new Map<string, string>();
    const emittedToolCalls = new Set<string>();

    try {
      stream.push({ type: "start", partial: output });

      const prompt = convertMessages(context.messages);

      const body = {
        config: {
          workingDir: process.cwd(),
          date: new Date().toISOString().slice(0, 10),
          environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
          structure: [],
          isGitRepo: false,
          currentBranch: "",
          mainBranch: "",
          gitStatus: "",
          recentCommits: [],
        },
        memory: "",
        taste: null,
        skills: "",
        params: {
          tools: convertTools(context.tools),
          stream: true,
          max_tokens: options?.maxTokens ?? Math.min(model.maxTokens, 64000),
          temperature: 0.3,
          messages: prompt,
          model: model.id,
        },
        threadId: crypto.randomUUID(),
      };

      const response = await fetch(ALPHA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options?.apiKey ?? readApiKey()}`,
          "Content-Type": "application/json",
          "x-cli-environment": "production",
          "x-co-flag": "false",
          "x-command-code-version": COMMAND_CODE_VERSION,
          "x-project-slug": projectSlug(),
          "x-taste-learning": "false",
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok || !response.body) throw new Error(`CommandCode /alpha/generate failed: ${response.status} ${await response.text()}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (event: any) => {
        if (event.type === "reasoning-start") {
          output.content.push({ type: "thinking", thinking: "" } as any);
          activeThinkingIndex = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
        } else if (event.type === "reasoning-delta" && activeThinkingIndex >= 0) {
          const block = output.content[activeThinkingIndex] as any;
          block.thinking += event.text ?? "";
          stream.push({ type: "thinking_delta", contentIndex: activeThinkingIndex, delta: event.text ?? "", partial: output });
        } else if (event.type === "reasoning-end" && activeThinkingIndex >= 0) {
          const block = output.content[activeThinkingIndex] as any;
          stream.push({ type: "thinking_end", contentIndex: activeThinkingIndex, content: block.thinking, partial: output });
          activeThinkingIndex = -1;
        } else if (event.type === "text-start") {
          output.content.push({ type: "text", text: "" });
          activeTextIndex = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
        } else if (event.type === "text-delta") {
          if (activeTextIndex < 0) {
            output.content.push({ type: "text", text: "" });
            activeTextIndex = output.content.length - 1;
            stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
          }
          const block = output.content[activeTextIndex] as TextContent;
          block.text += event.text ?? "";
          stream.push({ type: "text_delta", contentIndex: activeTextIndex, delta: event.text ?? "", partial: output });
        } else if (event.type === "text-end" && activeTextIndex >= 0) {
          const block = output.content[activeTextIndex] as TextContent;
          stream.push({ type: "text_end", contentIndex: activeTextIndex, content: block.text, partial: output });
          activeTextIndex = -1;
        } else if (event.type === "tool-call") {
          const id = event.toolCallId ?? event.id ?? crypto.randomUUID();
          const existingIdx = toolPartToContentIndex.get(String(id));
          if (existingIdx != null) {
            (output.content[existingIdx] as ToolCall).arguments = event.input ?? (output.content[existingIdx] as ToolCall).arguments;
            if (!emittedToolCalls.has(String(id))) {
              emittedToolCalls.add(String(id));
              stream.push({ type: "toolcall_end", contentIndex: existingIdx, toolCall: output.content[existingIdx] as ToolCall, partial: output });
            }
            return;
          }
          output.content.push({ type: "toolCall", id, name: event.toolName ?? event.name, arguments: event.input ?? {} } as ToolCall);
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          emittedToolCalls.add(String(id));
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: output.content[idx] as ToolCall, partial: output });
        } else if (event.type === "tool-input-start") {
          const id = event.id ?? event.toolCallId ?? crypto.randomUUID();
          output.content.push({ type: "toolCall", id, name: event.toolName ?? event.name, arguments: {} } as ToolCall);
          const idx = output.content.length - 1;
          toolPartToContentIndex.set(String(event.id ?? id), idx);
          toolJson.set(String(event.id ?? id), "");
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
        } else if (event.type === "tool-input-delta") {
          const key = String(event.id ?? event.toolCallId ?? "");
          const idx = toolPartToContentIndex.get(key);
          if (idx == null) return;
          const delta = event.delta ?? event.text ?? "";
          const next = (toolJson.get(key) ?? "") + delta;
          toolJson.set(key, next);
          try {
            (output.content[idx] as ToolCall).arguments = JSON.parse(next);
          } catch {}
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta, partial: output });
        } else if (event.type === "tool-input-end") {
          const key = String(event.id ?? event.toolCallId ?? "");
          const idx = toolPartToContentIndex.get(key);
          if (idx == null) return;
          try {
            (output.content[idx] as ToolCall).arguments = JSON.parse(toolJson.get(key) ?? "{}");
          } catch {}
          emittedToolCalls.add(key);
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: output.content[idx] as ToolCall, partial: output });
        } else if (event.type === "finish-step" || event.type === "finish") {
          const usage = event.usage ?? event.totalUsage;
          if (usage) {
            output.usage.input = usage.inputTokens ?? 0;
            output.usage.output = usage.outputTokens ?? 0;
            output.usage.cacheRead = usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0;
            output.usage.cacheWrite = usage.inputTokenDetails?.cacheCreationTokens ?? 0;
            output.usage.totalTokens = usage.totalTokens ?? output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
          output.stopReason = event.finishReason === "tool-calls" ? "toolUse" : event.finishReason === "length" ? "length" : "stop";
        } else if (event.type === "error") {
          throw new Error(event.error?.message ?? event.message ?? JSON.stringify(event));
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;
          handleEvent(JSON.parse(trimmed));
        }
      }
      if (buffer.trim().startsWith("{")) handleEvent(JSON.parse(buffer.trim()));

      stream.push({ type: "done", reason: output.stopReason as any, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

async function fetchCatalog(): Promise<CommandCodeModel[]> {
  const cached = readCache("commandcode-models");
  if (cached?.length) return cached;

  const models = fallbackCatalog();
  writeCache("commandcode-models", models);
  return models;
}

export default async function (pi: ExtensionAPI) {
  const catalog = await fetchCatalog();
  const models = catalog.map((model) => normalizeModel(model));

  pi.registerProvider("cmd", {
    name: "CommandCode",
    baseUrl: "https://api.commandcode.ai/alpha",
    apiKey: API_KEY_COMMAND,
    api: "commandcode-alpha" as Api,
    streamSimple: streamCommandCodeAlpha,
    models,
  });

  console.error(
    `[cmd] Registered ${catalog.length} CommandCode subscription models` +
      (hasAuth() ? "" : " — run `cmd login` or set COMMAND_CODE_API_KEY before use")
  );
}
