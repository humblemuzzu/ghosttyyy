/**
 * v3: cheerio HTML→markdown + LLM Q&A + pagination + raw mode.
 *
 * cheerio strips chrome (nav, footer, scripts), finds main content area,
 * converts to clean markdown. ~95% size reduction on typical pages.
 *
 * `prompt` spawns a sub-agent that receives page content
 * and returns AI-generated prose (36/1202 calls use this pattern).
 * `start_index`/`max_length` provide character-level pagination (~16 calls).
 * `raw` skips conversion entirely (1 call).
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { htmlToMarkdown } from "./lib/html-to-md";
import { emptyAgentModels, modelParams, resolveRoute, type AgentModels, type ModelRoute } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { OutputBuffer, headTailChars } from "./lib/output-buffer";
import { osc8Link } from "./lib/box-format";

const HEAD_LINES = 500;
const TAIL_LINES = 500;
const MAX_CHARS = 64_000;
const CURL_TIMEOUT_SECS = 30;
const MAX_REDIRECTS = 5;

const DEFAULT_PROMPT_SYSTEM = `Analyze web page content and answer questions. Be concise, answer from provided content only. No filler.`;

function fetchUrl(url: string, signal?: AbortSignal): Promise<{ html: string; error?: string }> {
	return new Promise((resolve) => {
		const args = [
			"-sL",
			"-H", "Accept: text/markdown, text/html;q=0.9",
			"-m", String(CURL_TIMEOUT_SECS),
			"--max-redirs", String(MAX_REDIRECTS),
			"-A", "Mozilla/5.0 (compatible; pi-agent/1.0)",
			url,
		];

		const child = spawn("curl", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
		let stderr = "";
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			if (!child.killed) child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) { onAbort(); }
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout?.on("data", (data: Buffer) => {
			output.add(data.toString("utf-8"));
		});

		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf-8");
		});

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ html: "", error: `curl error: ${err.message}` });
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (aborted) { resolve({ html: "", error: "fetch aborted" }); return; }
			if (code !== 0) {
				resolve({ html: "", error: `fetch failed: ${stderr.trim() || `curl exited with code ${code}`}` });
				return;
			}
			const { text } = output.format();
			resolve({ html: text });
		});
	});
}

export interface ReadWebPageConfig {
	systemPrompt?: string;
	models?: AgentModels;
}

export function createReadWebPageTool(config: ReadWebPageConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
	return {
		name: "read_web_page",
		label: "Read Web Page",
		description:
			"Read the contents of a web page at a given URL.\n\n" +
			"Returns the page content converted to Markdown.\n\n" +
			"When an objective is provided, it returns excerpts relevant to that objective.\n\n" +
			"Do NOT use for localhost or local URLs — use `curl` via Bash instead.",

		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to read.",
			}),
			objective: Type.Optional(
				Type.String({
					description:
						"A natural-language description of the research goal. " +
						"If set, only relevant excerpts will be returned. If not set, the full content is returned.",
				}),
			),
			prompt: Type.Optional(
				Type.String({
					description:
						"A question to answer about the page content. " +
						"Spawns an AI sub-agent that reads the page and returns a prose answer.",
				}),
			),
			start_index: Type.Optional(
				Type.Number({
					description: "Character offset to start from in the converted content (for pagination).",
				}),
			),
			max_length: Type.Optional(
				Type.Number({
					description: "Maximum number of characters to return (for pagination).",
				}),
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Return raw HTML instead of converting to Markdown.",
				}),
			),
			forceRefetch: Type.Optional(
				Type.Boolean({
					description: "Force a live fetch (no caching). Currently always fetches live.",
				}),
			),
			...modelParams(models, "read_web_page"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const url = params.url;

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return toolError(`invalid URL: "${url}" — must start with http:// or https://`);
			}

			let route: ModelRoute = {};
			if (params.prompt) {
				const resolved = resolveRoute(models, "read_web_page", params, ctx.modelRegistry);
				if ("error" in resolved) return toolError(resolved.error);
				route = resolved;
			}

			const { html, error } = await fetchUrl(url, signal);
			if (error) return toolError(error);

			if (!html.trim()) {
				return {
					content: [{ type: "text" as const, text: "(empty response)" }],
				} as any;
			}

			// raw mode: skip conversion entirely
			if (params.raw) {
				const content = headTailChars(`Raw HTML content as requested:\n${html}`, MAX_CHARS).text;
				return { content: [{ type: "text" as const, text: content }] } as any;
			}

			const md = htmlToMarkdown(html);
			let content = md ?? html;

			// pagination: slice before truncation so offsets are stable
			if (params.start_index !== undefined || params.max_length !== undefined) {
				const total = content.length;
				const start = params.start_index ?? 0;
				const end = params.max_length !== undefined ? start + params.max_length : total;
				content = content.slice(start, end);
				content += `\n\n[${start}–${Math.min(end, total)} of ${total} characters]`;
			}

			content = headTailChars(content, MAX_CHARS).text;

			if (params.objective) {
				content = `Objective: ${params.objective}\n\n---\n\n${content}`;
			}

			if (params.prompt) {
				return runSubAgent({
					agent: "read_web_page",
					label: params.prompt,
					working: "(analyzing...)",
					ctx,
					signal,
					onUpdate,
					spawn: {
						task: `Here is the content of ${url}:\n\n${content}\n\n---\n\nAnswer this question: ${params.prompt}`,
						model: route.model,
						thinkingLevel: route.thinking,
						builtinTools: ["read"],
						extensionTools: [],
						systemPromptBody: config.systemPrompt || DEFAULT_PROMPT_SYSTEM,
					},
				});
			}

			return { content: [{ type: "text" as const, text: content }] } as any;
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const url = args.url || "...";
			const displayUrl = clip(url, 60);
			const linkedUrl = url.startsWith("http") ? osc8Link(url, displayUrl) : displayUrl;
			let label = theme.fg("toolTitle", theme.bold("read_web_page ")) + theme.fg("dim", linkedUrl);
			const promptLabel = args.prompt || args.objective;
			if (promptLabel) label += theme.fg("muted", ` — ${clip(promptLabel, 40)}`);
			text.setText(label);
			return text;
		},

		renderResult: renderSubAgentResult("read_web_page"),
	};
}
