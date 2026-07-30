/**
 * web_search — web search via the Parallel AI Search API.
 *
 * PROVENANCE
 * ported from bdsqqq/dots `user/pi/packages/extensions/web-search/index.ts`
 * (MIT, commit e04b620). the implementation is his; adapted to our layout:
 *   - `@bds_pi/*` imports  -> our `./lib/*`
 *   - `typebox`            -> `@sinclair/typebox`
 *   - `@earendil-works/*`  -> `@mariozechner/*` (our alias convention)
 *   - his standalone-extension wrapper + default export dropped; we expose
 *     `createWebSearchTool()` and register it centrally in `index.ts`, matching
 *     how every other tool here is wired.
 *
 * WHY PARALLEL AI
 * this replaces the `pi-web-access` package removed 2026-07-30, whose
 * `web_search` was dead on all three providers at once (OpenAI rejected the
 * model for ChatGPT-account Codex auth, Exa hit its free rate limit, the
 * Perplexity key was invalid). Parallel is a single dedicated search API:
 * one key, one endpoint, no LLM-provider coupling.
 *
 * TRANSPORT
 * requests go out via `curl` rather than fetch/an SDK. that is deliberate
 * upstream (his extensions run in a nix build where adding an npm dep needs a
 * rebuild) and harmless here, so it is kept rather than rewritten.
 *
 * AUTH
 * `PARALLEL_API_KEY` from the environment (set in ~/.zshrc, never committed).
 * without it the tool returns a clear setup error instead of failing silently.
 *
 * COST
 * derived from the API response's own `usage` array, not hardcoded guesses.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	boxRendererWindowed,
	osc8Link,
	type BoxSection,
	type Excerpt,
} from "./lib/box-format";
import { getEnabledExtensionConfig, type ExtensionConfigSchema } from "./lib/config";
import { withPromptPatch } from "./lib/prompt-patch";
import type { ToolCostDetails } from "./lib/tool-cost";

/*
 * SEARCH MODES — and why these names differ from Parallel's published docs.
 *
 * parallel.ai's pricing page and the "Search Turbo" blog document
 * `turbo` / `basic` / `advanced`, which belong to the **v1** endpoint. we call
 * **v1beta**, which accepts an older set of names and rejects the new ones:
 *
 *   Invalid search mode: 'turbo'. Please use one of: 'agentic', 'fast', 'one-shot'
 *
 * we stay on v1beta deliberately: **v1 forbids `max_results` and `excerpts`**
 * (verified — it answers `extra_forbidden` for both), so it always returns 10
 * results with uncapped excerpts. measured on one query, v1 payloads ran
 * 9k-33k characters against ~4k for v1beta. for an agent paying context for
 * every character, losing excerpt control is a worse deal than any price
 * difference — especially as the free tier (5,000 requests/month) already
 * covers our usage at any mode.
 *
 * measured, same query and excerpt caps:
 *
 *   ours (v1beta)        v1 analogue    latency    excerpt chars
 *   fast                 turbo            979ms      940
 *   one-shot (default)   basic           1553ms     3001
 *   agentic              advanced        2251ms     2895
 *
 * `one-shot` is the default because it reproduces what this tool already did
 * when no mode was sent — the choice becomes deliberate without silently
 * changing behaviour, and we stop inheriting server-side default changes.
 */
const SEARCH_MODES = ["fast", "one-shot", "agentic"] as const;
type SearchMode = (typeof SEARCH_MODES)[number];

type WebSearchExtConfig = {
  defaultMaxResults: number;
  endpoint: string;
  curlTimeoutSecs: number;
  defaultMode: SearchMode;
};

const CONFIG_DEFAULTS: WebSearchExtConfig = {
  defaultMaxResults: 10,
  endpoint: "https://api.parallel.ai/v1beta/search",
  curlTimeoutSecs: 30,
  defaultMode: "one-shot",
};

function isWebSearchConfig(
  value: Record<string, unknown>,
): value is WebSearchExtConfig {
  return (
    typeof value.defaultMaxResults === "number" &&
    Number.isInteger(value.defaultMaxResults) &&
    value.defaultMaxResults >= 1 &&
    typeof value.endpoint === "string" &&
    value.endpoint.trim().length > 0 &&
    typeof value.curlTimeoutSecs === "number" &&
    Number.isInteger(value.curlTimeoutSecs) &&
    value.curlTimeoutSecs >= 1 &&
    // reject an unknown mode at config load rather than on every search:
    // v1beta answers a hard error for names it does not know (e.g. "turbo").
    typeof value.defaultMode === "string" &&
    (SEARCH_MODES as readonly string[]).includes(value.defaultMode)
    );
    }

const WEB_SEARCH_CONFIG_SCHEMA: ExtensionConfigSchema<WebSearchExtConfig> = {
  validate: isWebSearchConfig,
};

/** per-result excerpts for collapsed display — first 5 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 5 }];

interface SearchResult {
  url: string;
  title: string;
  publish_date?: string;
  excerpts: string[];
}

/**
 * usage line item from the API response.
 * schema: https://docs.parallel.ai/public-openapi.json → UsageItem
 */
interface UsageItem {
  name: string;
  count: number;
}

/** per-unit pricing by SKU name ($/unit). ref: https://docs.parallel.ai/pricing */
const SKU_UNIT_COST: Record<string, number> = {
  sku_search: 0.005,
  sku_search_additional_results: 0.001,
};

/** falls back to base search cost when API omits usage (e.g., older API versions). */
function costFromUsage(usage: UsageItem[] | undefined): number {
  if (!usage?.length) return SKU_UNIT_COST.sku_search ?? 0;
  let total = 0;
  for (const item of usage) {
    total += (SKU_UNIT_COST[item.name] ?? 0) * item.count;
  }
  return total;
}

interface SearchResponse {
  search_id?: string;
  results: SearchResult[];
  warnings?: string[];
  usage?: UsageItem[];
}

function searchParallel(
  apiKey: string,
  body: Record<string, unknown>,
  endpoint: string,
  curlTimeoutSecs: number,
  signal?: AbortSignal,
): Promise<{ data?: SearchResponse; error?: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);

    const args = [
      "-sL",
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      `x-api-key: ${apiKey}`,
      "-H",
      "parallel-beta: search-extract-2025-10-10",
      "-m",
      String(curlTimeoutSecs),
      "-d",
      payload,
      endpoint,
    ];

    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ error: `curl error: ${err.message}` });
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        resolve({ error: "search aborted" });
        return;
      }
      if (code !== 0) {
        resolve({
          error: `search failed: ${stderr.trim() || `curl exited with code ${code}`}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as SearchResponse;
        resolve({ data: parsed });
      } catch {
        resolve({
          error: `invalid response from Parallel API: ${stdout.slice(0, 200)}`,
        });
      }
    });
  });
}

function formatResults(results: SearchResult[]): {
  text: string;
  headerLineIndices: number[];
} {
  if (results.length === 0)
    return { text: "(no results found)", headerLineIndices: [] };

  const lines: string[] = [];
  const headerLineIndices: number[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    headerLineIndices.push(lines.length);
    lines.push(`### ${r.title || "(untitled)"}`);
    lines.push(r.url!);
    if (r.publish_date) lines.push(`*${r.publish_date}*`);
    if (r.excerpts?.length) {
      lines.push("");
      for (let j = 0; j < r.excerpts.length; j++) {
        const excerptLines = r.excerpts[j]!.split("\n");
        lines.push(...excerptLines);
        if (j < r.excerpts.length - 1) lines.push("");
      }
    }

    if (i < results.length - 1) {
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  return { text: lines.join("\n"), headerLineIndices };
}

/** convert raw SearchResult[] into BoxSection[] for box-format rendering. */
function resultsToSections(results: SearchResult[]): BoxSection[] {
  return results.map((r) => {
    const lines = [];
    lines.push({ text: osc8Link(r.url, r.url), highlight: true });
    if (r.publish_date) lines.push({ text: r.publish_date, highlight: true });
    if (r.excerpts?.length) {
      lines.push({ text: "", highlight: false });
      for (let j = 0; j < r.excerpts.length; j++) {
        for (const l of r.excerpts[j]!.split("\n")) {
          lines.push({ text: l, highlight: false });
        }
        if (j < r.excerpts.length - 1)
          lines.push({ text: "", highlight: false });
      }
    }
    return {
      header: r.title || "(untitled)",
      blocks: [{ lines }],
    };
  });
}

interface WebSearchParams {
  objective: string;
  search_queries?: string[];
  max_results?: number;
}

export function createWebSearchTool(
  config: WebSearchExtConfig = CONFIG_DEFAULTS,
): ToolDefinition<any> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for information relevant to a research objective.\n\n" +
      "Use when you need up-to-date or precise documentation. " +
      "Use `read_web_page` to fetch full content from a specific URL.\n\n" +
      "# Examples\n\n" +
      "Get API documentation for a specific provider\n" +
      '```json\n{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe\'s docs site."}\n```\n\n' +
      "See usage documentation for newly released library features\n" +
      '```json\n{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}\n```',

    parameters: Type.Object({
      objective: Type.String({
        description:
          "A natural-language description of the broader task or research goal, " +
          "including any source or freshness guidance.",
      }),
      search_queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional keyword queries to ensure matches for specific terms are " +
            "prioritized (recommended for best results).",
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: `The maximum number of results to return (default: ${config.defaultMaxResults}).`,
        }),
      ),
      mode: Type.Optional(
        Type.Union(
          SEARCH_MODES.map((m) => Type.Literal(m)),
          {
            description:
              `Retrieval depth (default: ${config.defaultMode}). ` +
              "'fast' ~1s, shallowest excerpts — use for a single fact: a version number, " +
              "a release date, whether an API still exists. English and Japanese only. " +
              "'one-shot' ~1.5s, fuller excerpts — the sensible default for documentation lookups. " +
              "'agentic' ~2.5s, multi-hop retrieval — use when one page will not answer it, " +
              "e.g. comparing options or tracing a change across releases.",
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const p = params as WebSearchParams;
      const apiKey = process.env.PARALLEL_API_KEY;
      if (!apiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "PARALLEL_API_KEY not set. add `export PARALLEL_API_KEY=\"...\"` to ~/.zshrc " +
                "and start a new shell. get a key at https://platform.parallel.ai",
            },
          ],
          isError: true,
        } as any;
      }

      const body: Record<string, unknown> = {
        objective: p.objective,
        max_results: p.max_results ?? config.defaultMaxResults,
        excerpts: { max_chars_per_result: 2000 },
        // always explicit: never inherit whatever the server default happens
        // to be on a given day.
        mode: p.mode ?? config.defaultMode,
      };
      if (p.search_queries?.length) {
        body.search_queries = p.search_queries;
      }

      const { data, error } = await searchParallel(
        apiKey,
        body,
        config.endpoint,
        config.curlTimeoutSecs,
        signal,
      );

      if (error) {
        return {
          content: [{ type: "text" as const, text: error }],
          isError: true,
        } as any;
      }

      if (!data?.results) {
        return {
          content: [{ type: "text" as const, text: "(no results)" }],
        } as any;
      }

      const { text, headerLineIndices } = formatResults(data.results);
      let output = text;

      if (data.warnings?.length) {
        output += `\n\n**Warnings:** ${data.warnings.join("; ")}`;
      }

      const resultSections = resultsToSections(data.results);
      const details: ToolCostDetails & {
        matchLineIndices?: number[];
        resultSections?: BoxSection[];
      } = {
        cost: costFromUsage(data.usage),
        matchLineIndices: headerLineIndices,
        resultSections,
      };
      return { content: [{ type: "text" as const, text: output }], details };
    },

    renderCall(args: any, theme: any) {
      const objective = args.objective || "...";
      const short =
        objective.length > 70 ? `${objective.slice(0, 70)}...` : objective;
      let text =
        theme.fg("toolTitle", theme.bold("web_search ")) +
        theme.fg("dim", short);
      if (args.search_queries?.length) {
        text += theme.fg("muted", ` [${args.search_queries.join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: any,
      { expanded }: { expanded: boolean },
      _theme: any,
    ) {
      const sections: BoxSection[] | undefined = result.details?.resultSections;
      if (!sections?.length) {
        const text = result.content?.[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }
      return boxRendererWindowed(
        () => sections,
        {
          collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
          expanded: {},
        },
        undefined,
        expanded,
      );
    },
  };
}

/**
 * build the tool as it should be registered: config resolved
 * (defaults -> global -> project) and prompt-patched.
 *
 * returns null when disabled via config, so index.ts can skip registration
 * entirely rather than advertising a tool that will not run.
 */
export function createConfiguredWebSearchTool(): ToolDefinition<any> | null {
  const { enabled, config } = getEnabledExtensionConfig(
    "web-search",
    CONFIG_DEFAULTS,
    { schema: WEB_SEARCH_CONFIG_SCHEMA },
  );
  if (!enabled) return null;
  return withPromptPatch(createWebSearchTool(config));
}
