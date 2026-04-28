/**
 * opencode-zen.ts — Override pi's built-in opencode provider
 *
 * The built-in opencode provider dumps 50+ models with no labels,
 * includes Claude/Gemini duplicates, and doesn't mark free models.
 *
 * This extension overrides it with a curated list:
 * - Free models labeled with 🆓
 * - Claude/Gemini filtered out (already available via native providers)
 * - Cost tiers labeled (💸 cheap, 💰 mid, 💎 expensive)
 * - 5-hour file cache to avoid hitting models.dev on every pi start
 *
 * Registers as provider "opencode" to replace the built-in.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────

interface ModelsDevModel {
  id: string;
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  attachment?: boolean;
  modalities?: { input?: string[] };
  cost: { input: number; output: number };
  limit: { context: number; output: number };
}

interface ModelsDevProvider {
  id: string;
  name: string;
  api: string;
  models: Record<string, ModelsDevModel>;
}

// ── Compat flags ───────────────────────────────────────────────────────

const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens" as const,
  thinkingFormat: "openai" as const,
};

// ── Cache (5-hour TTL) ─────────────────────────────────────────────────

const CACHE_DIR = join(process.env.HOME ?? "/tmp", ".pi", "cache");
const CACHE_TTL = 5 * 60 * 60 * 1000;

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

// ── Build model list from models.dev catalog ───────────────────────────

function buildModels(provider: ModelsDevProvider, hasApiKey: boolean) {
  const models: any[] = [];

  for (const [id, m] of Object.entries(provider.models)) {
    const isFree = m.cost.input === 0 && m.cost.output === 0;

    // Skip paid models if no API key
    if (!isFree && !hasApiKey) continue;

    // Skip Claude/Gemini — already available via native providers
    if (id.startsWith("claude-") || id.startsWith("gemini-")) continue;

    const inputMods: ("text" | "image")[] = ["text"];
    if (m.modalities?.input?.includes("image") || m.attachment) {
      inputMods.push("image");
    }

    let prefix: string;
    if (isFree) prefix = "🆓";
    else if (m.cost.input <= 0.5) prefix = "💸";
    else if (m.cost.input <= 2.0) prefix = "💰";
    else prefix = "💎";

    const costTag = isFree ? "free" : `$${m.cost.input}/$${m.cost.output} per M`;
    const ctxTag = m.limit.context >= 1000000
      ? `${(m.limit.context / 1000000).toFixed(0)}M ctx`
      : `${Math.round(m.limit.context / 1000)}K ctx`;

    models.push({
      id,
      name: `${prefix} ${m.name || id} — ${costTag}, ${ctxTag}`,
      reasoning: m.reasoning,
      input: inputMods,
      contextWindow: m.limit.context,
      maxTokens: m.limit.output,
      cost: { input: m.cost.input, output: m.cost.output, cacheRead: 0, cacheWrite: 0 },
      compat: COMPAT,
    });
  }

  // Free first, then by cost
  models.sort((a, b) => {
    const af = a.cost.input === 0 && a.cost.output === 0;
    const bf = b.cost.input === 0 && b.cost.output === 0;
    if (af && !bf) return -1;
    if (!af && bf) return 1;
    return a.cost.input - b.cost.input;
  });

  return models;
}

// ── Hardcoded fallback (last synced 2026-04-28) ────────────────────────

function fallbackModels(hasApiKey: boolean) {
  const all = [
    { id: "big-pickle", name: "🆓 Big Pickle — free, 200K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 200000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "qwen3.6-plus-free", name: "🆓 Qwen 3.6 Plus — free, 1M ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 1048576, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "mimo-v2-pro-free", name: "🆓 MiMo V2 Pro — free, 1M ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 1048576, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "gpt-5-nano", name: "🆓 GPT-5 Nano — free, 400K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 400000, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "kimi-k2.5-free", name: "🆓 Kimi K2.5 — free, 262K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 262144, maxTokens: 262144, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "grok-code", name: "🆓 Grok Code — free, 256K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 256000, maxTokens: 256000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "mimo-v2-flash-free", name: "🆓 MiMo V2 Flash — free, 262K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 262144, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "minimax-m2.5-free", name: "🆓 MiniMax M2.5 — free, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "glm-5-free", name: "🆓 GLM-5 — free, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "glm-4.7-free", name: "🆓 GLM-4.7 — free, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "nemotron-3-super-free", name: "🆓 Nemotron 3 Super — free, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 128000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "trinity-large-preview-free", name: "🆓 Trinity Large — free, 131K ctx", reasoning: false, input: ["text"] as ("text"|"image")[], contextWindow: 131072, maxTokens: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    // Cheap paid
    { id: "qwen3.5-plus", name: "💸 Qwen 3.5 Plus — $0.20/$1.20, 262K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 262144, maxTokens: 65536, cost: { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "minimax-m2.7", name: "💸 MiniMax M2.7 — $0.30/$1.20, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 131072, cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "kimi-k2.5", name: "💰 Kimi K2.5 — $0.60/$3.00, 262K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 262144, maxTokens: 65536, cost: { input: 0.6, output: 3.0, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "glm-5", name: "💰 GLM-5 — $1.00/$3.20, 204K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 204800, maxTokens: 131072, cost: { input: 1.0, output: 3.2, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
    { id: "glm-5.1", name: "💰 GLM-5.1 — $1.40/$4.40, 202K ctx", reasoning: true, input: ["text"] as ("text"|"image")[], contextWindow: 202752, maxTokens: 32768, cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 }, compat: COMPAT },
  ];

  return hasApiKey ? all : all.filter(m => m.cost.input === 0 && m.cost.output === 0);
}

// ── Extension entry point ──────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const hasApiKey = !!process.env.OPENCODE_API_KEY;
  const apiKeyValue = hasApiKey ? "OPENCODE_API_KEY" : "public";

  let models: any[];

  // Try cache first, then fetch, then fallback
  const cached = readCache("opencode-catalog");
  let catalog: Record<string, ModelsDevProvider> | null = null;

  if (cached) {
    catalog = cached;
  } else {
    try {
      const response = await fetch("https://models.dev/api.json", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
      catalog = await response.json() as Record<string, ModelsDevProvider>;
      writeCache("opencode-catalog", catalog);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[opencode-zen] Failed to fetch model catalog: ${error}`);
    }
  }

  if (catalog?.["opencode"]?.models) {
    models = buildModels(catalog["opencode"], hasApiKey);

    // Cross-reference with live API to filter unlaunched models
    let liveIds: Set<string> | null = null;
    const cachedIds = readCache("opencode-live-ids");

    if (cachedIds) {
      liveIds = new Set(cachedIds);
    } else {
      try {
        const response = await fetch("https://opencode.ai/zen/v1/models", {
          headers: { Authorization: `Bearer ${hasApiKey ? process.env.OPENCODE_API_KEY! : "public"}` },
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          const data = await response.json() as { data?: Array<{ id: string }> };
          const ids = (data.data || []).map((m) => m.id);
          writeCache("opencode-live-ids", ids);
          liveIds = new Set(ids);
        }
      } catch {}
    }

    if (liveIds && liveIds.size > 0) {
      const before = models.length;
      models = models.filter((m) => liveIds!.has(m.id));
      const removed = before - models.length;
      if (removed > 0) {
        console.error(`[opencode-zen] Filtered ${removed} models not on live API`);
      }
    }

    if (models.length === 0) {
      models = fallbackModels(hasApiKey);
    }
  } else {
    console.error(`[opencode-zen] Using hardcoded fallback models`);
    models = fallbackModels(hasApiKey);
  }

  // Override the built-in opencode provider with our curated list
  pi.registerProvider("opencode", {
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: apiKeyValue,
    api: "openai-completions",
    models,
  });

  const freeCount = models.filter(m => m.cost.input === 0 && m.cost.output === 0).length;
  const paidCount = models.length - freeCount;

  console.error(
    `[opencode-zen] Registered ${models.length} models (${freeCount} free, ${paidCount} paid)` +
      (hasApiKey ? "" : " — set OPENCODE_API_KEY for paid models")
  );
}
