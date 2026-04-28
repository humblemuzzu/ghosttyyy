/**
 * crof.ts — CrofAI provider for pi
 *
 * Registers crof.ai's self-hosted OSS model catalog as a pi provider.
 * Budget inference with quantized open-source models (DeepSeek, GLM, Qwen,
 * Kimi, Gemma, MiniMax). Includes 2 free models.
 *
 * API: OpenAI Chat Completions at https://crof.ai/v1
 * Auth: CROF_API_KEY env var (Bearer token)
 * Model metadata: fetched from https://crof.ai/v1/models at startup
 *
 * Reasoning models use DeepSeek-style reasoning_content in streaming deltas,
 * which pi's openai-completions provider already parses natively.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";

// ── Types for /v1/models response ──────────────────────────────────────

interface CrofModel {
  id: string;
  context_length: number;
  max_output?: number;
  max_completion_tokens?: number;
  custom_reasoning?: boolean;
  quantization?: string;
  speed?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    cache_prompt?: string;
  };
}

// ── Compat flags ───────────────────────────────────────────────────────

const CROF_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens" as const,
  thinkingFormat: "deepseek" as const,
  reasoningEffortMap: {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
  } as Record<string, string>,
};

// ── Hardcoded fallback (if /v1/models fetch fails) ─────────────────────
// Last synced: 2026-04-28 from https://crof.ai/v1/models

function fallbackModels() {
  return [
    // ── Free models ──
    {
      id: "glm-4.7-flash",
      name: "🆓 GLM-4.7 Flash — fp8, 202K ctx, free",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 202752,
      maxTokens: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "qwen3.5-9b",
      name: "🆓 Qwen 3.5 9B — fp8, 262K ctx, free, reasoning",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    // ── Cheap paid models ──
    {
      id: "qwen3.5-9b-chat",
      name: "💸 Qwen 3.5 9B Chat — $0.04/$0.15, 262K ctx, reasoning",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.04, output: 0.15, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "gemma-4-31b-it",
      name: "💸 Gemma 4 31B — Q4_0, $0.10/$0.30, 262K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.10, output: 0.30, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "minimax-m2.5",
      name: "💸 MiniMax M2.5 — awq, $0.11/$0.95, 204K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 204800,
      maxTokens: 131072,
      cost: { input: 0.11, output: 0.95, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "deepseek-v4-flash",
      name: "💸 DeepSeek V4 Flash — Q4_0, $0.12/$0.21, 1M ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 0.12, output: 0.21, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "qwen3.6-27b",
      name: "💸 Qwen 3.6 27B — Q4_0, $0.20/$1.50, 262K ctx, reasoning",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.20, output: 1.50, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "glm-4.7",
      name: "💸 GLM-4.7 — Q8_0, $0.25/$1.10, 202K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 202752,
      maxTokens: 202752,
      cost: { input: 0.25, output: 1.10, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "deepseek-v3.2",
      name: "💸 DeepSeek V3.2 — Q4_0, $0.28/$0.38, 163K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 163840,
      maxTokens: 163840,
      cost: { input: 0.28, output: 0.38, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "greg",
      name: "💸 Greg — $0.30/$0.30, 200K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 200000,
      maxTokens: 200000,
      cost: { input: 0.30, output: 0.30, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "kimi-k2.5",
      name: "💸 Kimi K2.5 — Q4_K_M, $0.35/$1.70, 262K ctx, vision",
      reasoning: false,
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.35, output: 1.70, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "qwen3.5-397b-a17b",
      name: "💸 Qwen 3.5 397B MoE — Q4_0, $0.35/$1.75, 262K ctx, reasoning",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.35, output: 1.75, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "glm-5.1",
      name: "💰 GLM-5.1 — Q6_K, $0.45/$2.10, 202K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 202752,
      maxTokens: 202752,
      cost: { input: 0.45, output: 2.10, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "glm-5",
      name: "💰 GLM-5 — Q4_0, $0.48/$1.90, 202K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 202752,
      maxTokens: 202752,
      cost: { input: 0.48, output: 1.90, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "kimi-k2.6",
      name: "💰 Kimi K2.6 — Q3_K_L, $0.50/$1.99, 262K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.50, output: 1.99, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "kimi-k2.6-precision",
      name: "💰 Kimi K2.6 Precision — int4, $0.55/$2.70, 262K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.55, output: 2.70, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "glm-5.1-precision",
      name: "💰 GLM-5.1 Precision — Q8_0, $0.80/$2.90, 202K ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 202752,
      maxTokens: 202752,
      cost: { input: 0.80, output: 2.90, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "deepseek-v4-pro",
      name: "💰 DeepSeek V4 Pro — Q4_0, $1.00/$2.15, 1M ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 1.00, output: 2.15, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "kimi-k2.5-lightning",
      name: "💰 Kimi K2.5 Lightning — 530b-int4, $1.00/$3.00, 131K ctx, reasoning, 1238 tok/s",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 131072,
      maxTokens: 32768,
      cost: { input: 1.00, output: 3.00, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
    {
      id: "deepseek-v4-pro-precision",
      name: "💰 DeepSeek V4 Pro Precision — Q8_0, $1.25/$3.00, 1M ctx",
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 1000000,
      maxTokens: 131072,
      cost: { input: 1.25, output: 3.00, cacheRead: 0, cacheWrite: 0 },
      compat: CROF_COMPAT,
    },
  ];
}

// ── Build model list from /v1/models response ──────────────────────────

function buildModelsFromApi(apiModels: CrofModel[]) {
  const models: any[] = [];

  for (const m of apiModels) {
    const maxOut = m.max_output ?? m.max_completion_tokens ?? 16384;

    // Parse pricing (API returns per-token strings like "0.00000100")
    const promptPrice = parseFloat(m.pricing?.prompt ?? "0");
    const compPrice = parseFloat(m.pricing?.completion ?? "0");
    // Convert per-token to per-million-tokens
    const inputCost = promptPrice * 1_000_000;
    const outputCost = compPrice * 1_000_000;
    const isFree = inputCost === 0 && outputCost === 0;

    // Cache pricing
    const cachePrice = parseFloat(m.pricing?.cache_prompt ?? "0");
    const cacheReadCost = cachePrice * 1_000_000;

    // Display name
    let prefix: string;
    if (isFree) {
      prefix = "🆓";
    } else if (inputCost <= 0.5) {
      prefix = "💸";
    } else if (inputCost <= 2.0) {
      prefix = "💰";
    } else {
      prefix = "💎";
    }

    const costTag = isFree
      ? "free"
      : `$${inputCost.toFixed(2)}/$${outputCost.toFixed(2)} per M`;
    const ctxTag = m.context_length >= 1000000
      ? `${(m.context_length / 1000000).toFixed(0)}M ctx`
      : `${Math.round(m.context_length / 1000)}K ctx`;
    const quantTag = m.quantization ? `, ${m.quantization}` : "";
    const reasonTag = m.custom_reasoning ? ", reasoning" : "";
    const speedTag = m.speed ? `, ${m.speed} tok/s` : "";

    const displayName = `${prefix} ${m.id} — ${costTag}, ${ctxTag}${quantTag}${reasonTag}${speedTag}`;

    // Only kimi-k2.5 supports vision on crof's quantized deployments
    const supportsVision = m.id === "kimi-k2.5";
    const inputMods: ("text" | "image")[] = supportsVision
      ? ["text", "image"]
      : ["text"];

    models.push({
      id: m.id,
      name: displayName,
      reasoning: !!m.custom_reasoning,
      input: inputMods,
      contextWindow: m.context_length,
      maxTokens: maxOut,
      cost: {
        input: inputCost,
        output: outputCost,
        cacheRead: cacheReadCost,
        cacheWrite: 0,
      },
      compat: CROF_COMPAT,
    });
  }

  // Sort: free first, then by input cost ascending
  models.sort((a, b) => {
    const aFree = a.cost.input === 0 && a.cost.output === 0;
    const bFree = b.cost.input === 0 && b.cost.output === 0;
    if (aFree && !bFree) return -1;
    if (!aFree && bFree) return 1;
    return a.cost.input - b.cost.input;
  });

  return models;
}

// ── Cached fetch (5-hour TTL, file-based) ──────────────────────────────

const CACHE_DIR = join(process.env.HOME ?? "/tmp", ".pi", "cache");
const CACHE_TTL = 5 * 60 * 60 * 1000; // 5 hours

function readCache(key: string): any | null {
  try {
    const path = join(CACHE_DIR, `${key}.json`);
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
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

// ── Extension entry point ──────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const hasApiKey = !!process.env.CROF_API_KEY;

  if (!hasApiKey) {
    console.error(`[crof] CROF_API_KEY not set — skipping provider registration`);
    return;
  }

  let models: any[];

  // Check cache first
  const cached = readCache("crof-models");
  if (cached) {
    models = buildModelsFromApi(cached);
  } else {
    try {
      const response = await fetch("https://crof.ai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.CROF_API_KEY}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`/v1/models returned ${response.status}`);
      }

      const data = (await response.json()) as { data?: CrofModel[] };
      const apiModels = data.data ?? [];

      if (apiModels.length === 0) {
        throw new Error("Empty model list from API");
      }

      writeCache("crof-models", apiModels);
      models = buildModelsFromApi(apiModels);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[crof] Failed to fetch models: ${error}, using fallback`);
      models = fallbackModels();
    }
  }

  pi.registerProvider("crof", {
    baseUrl: "https://crof.ai/v1",
    apiKey: "CROF_API_KEY",
    api: "openai-completions",
    models,
  });

  const freeCount = models.filter(
    (m) => m.cost.input === 0 && m.cost.output === 0
  ).length;

  console.error(
    `[crof] Registered ${models.length} models (${freeCount} free, ${models.length - freeCount} paid)`
  );
}
