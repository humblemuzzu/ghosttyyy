/**
 * web_search tool — routes through OpenAI's Responses API web search.
 *
 * reads openai-codex OAuth credentials from ~/.pi/agent/auth.json.
 * refreshes the access token if expired (same flow pi uses internally).
 * sends a Responses API request with `{ type: "web_search" }` as a
 * native tool, parses the SSE stream, extracts sources + model answer.
 *
 * works regardless of which model/provider is currently active in pi —
 * Claude, DeepSeek, local, whatever. the search always goes to OpenAI.
 *
 * refs:
 *   codex CLI: https://github.com/openai/codex (web_search native tool)
 *   responses API: https://platform.openai.com/docs/guides/tools-web-search
 *   pi auth: ~/.pi/agent/auth.json (openai-codex OAuth entry)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { boxRendererWindowed, osc8Link, type BoxSection, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";

let keyHint: ((action: string, label: string) => string) | null = null;
try {
	// resolve pi's keybinding hint helper for expand hint
	const mod = await import("@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js" as any);
	keyHint = mod.keyHint ?? null;
} catch { /* not available — skip hint */ }

// ── constants ────────────────────────────────────────────────

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_CLAIM = "https://api.openai.com/auth";

/** model for the search request — spark is ultra-fast, no reasoning overhead. */
const SEARCH_MODEL = "gpt-5.3-codex-spark";

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 3 }];

// ── types ────────────────────────────────────────────────────

interface OAuthEntry {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
}

interface AuthFile {
	"openai-codex"?: OAuthEntry;
	[k: string]: unknown;
}

interface Source {
	title: string;
	url: string;
	snippet?: string;
}

interface SearchResult {
	queries: string[];
	sources: Source[];
	answer: string;
}

// ── auth ─────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, any> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
	} catch {
		return null;
	}
}

function extractAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token);
	const id = payload?.[JWT_CLAIM]?.chatgpt_account_id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

function readAuthFile(): AuthFile {
	return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
}

function writeAuthFile(data: AuthFile): void {
	writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

async function refreshAccessToken(
	refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number; accountId: string }> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`token refresh failed (${res.status}): ${text.slice(0, 200)}`);
	}
	const json = (await res.json()) as Record<string, any>;
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error("refresh response missing required fields");
	}
	const accountId = extractAccountId(json.access_token);
	if (!accountId) throw new Error("no accountId in refreshed token");
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		accountId,
	};
}

async function getCredentials(): Promise<{ token: string; accountId: string }> {
	const data = readAuthFile();
	const cred = data["openai-codex"];
	if (!cred || cred.type !== "oauth") {
		throw new Error("openai-codex not configured — run /login openai-codex in pi");
	}

	if (Date.now() < cred.expires) {
		return { token: cred.access, accountId: cred.accountId };
	}

	// expired — refresh and persist so pi also sees the new token
	const refreshed = await refreshAccessToken(cred.refresh);
	data["openai-codex"] = { type: "oauth", ...refreshed };
	writeAuthFile(data);
	return { token: refreshed.access, accountId: refreshed.accountId };
}

// ── SSE parsing ──────────────────────────────────────────────

async function* parseSSE(response: Response): AsyncIterable<Record<string, any>> {
	const body = response.body;
	if (!body) return;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());

				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data);
						} catch {
							// skip malformed events
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}
}

// ── codex web search ─────────────────────────────────────────

async function codexSearch(query: string, signal?: AbortSignal): Promise<SearchResult> {
	const { token, accountId } = await getCredentials();

	const body = {
		model: SEARCH_MODEL,
		store: false,
		stream: true,
		instructions: "Search the web for the user's query. Return a thorough, factual answer with sources.",
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [{ type: "web_search", external_web_access: true, search_content_types: ["text"] }],
		include: ["web_search_call.action.sources", "web_search_call.results"],
		text: { verbosity: "medium" },
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "low" },
	};

	const res = await fetch(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountId,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`codex API ${res.status}: ${text.slice(0, 300)}`);
	}

	const sources: Source[] = [];
	const queries: string[] = [];
	let answer = "";

	for await (const event of parseSSE(res)) {
		const type = event.type as string;

		// web_search_call completed — extract sources
		if (type === "response.output_item.done" && event.item?.type === "web_search_call") {
			const item = event.item;
			// action may contain query/queries
			if (item.action?.type === "search") {
				if (item.action.query) queries.push(item.action.query);
				if (Array.isArray(item.action.queries)) queries.push(...item.action.queries);
			}
			// sources array
			if (Array.isArray(item.action?.sources)) {
				for (const s of item.action.sources) {
					if (s.url) sources.push({ title: s.title || "", url: s.url, snippet: s.snippet });
				}
			}
		}

		// collect text deltas for the model's answer
		if (type === "response.output_text.delta" && typeof event.delta === "string") {
			answer += event.delta;
		}

		// also catch completed text
		if (type === "response.output_text.done" && typeof event.text === "string") {
			answer = event.text;
		}
	}

	return { queries, sources, answer: answer.trim() };
}

// ── formatting ───────────────────────────────────────────────

function formatForModel(result: SearchResult): string {
	const lines: string[] = [];

	if (result.sources.length > 0) {
		lines.push("## Sources\n");
		for (const s of result.sources) {
			lines.push(`- [${s.title || s.url}](${s.url})`);
		}
		lines.push("");
	}

	if (result.answer) {
		lines.push("## Answer\n");
		lines.push(result.answer);
	}

	if (result.queries.length > 0) {
		lines.push(`\n*Searched: ${result.queries.join(", ")}*`);
	}

	return lines.join("\n") || "(no results)";
}

function resultToSections(result: SearchResult): BoxSection[] {
	const sections: BoxSection[] = [];

	if (result.sources.length > 0) {
		sections.push({
			header: `${result.sources.length} sources`,
			blocks: [
				{
					lines: result.sources.map((s) => ({
						text: osc8Link(s.url, s.title || s.url),
						highlight: true,
					})),
				},
			],
		});
	}

	if (result.answer) {
		const answerLines = result.answer.split("\n");
		sections.push({
			header: "Answer",
			blocks: [
				{
					lines: answerLines.map((l) => ({ text: l, highlight: false })),
				},
			],
		});
	}

	return sections;
}

// ── tool definition ──────────────────────────────────────────

export function createWebSearchTool(): ToolDefinition {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for up-to-date information. Routes through OpenAI's server-side " +
			"web search regardless of active model.\n\n" +
			"Use `read_web_page` for fetching a specific URL.\n\n" +
			"# Examples\n\n" +
			'```json\n{"queries":["stripe billing API create customer"]}\n```\n\n' +
			'```json\n{"queries":["sveltekit remote functions","svelte 5 new features 2026"]}\n```',

		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",

		parameters: Type.Object({
			queries: Type.Array(Type.String(), {
				description:
					"Search queries. Use 2-4 varied angles for broader coverage. " +
					"Each query is combined into a single search request.",
			}),
		}),

		async execute(_toolCallId, params, signal) {
			const queryText = params.queries.join("\n");
			if (!queryText.trim()) {
				return { content: [{ type: "text" as const, text: "no queries provided" }], isError: true } as any;
			}

			try {
				const result = await codexSearch(queryText, signal);
				const text = formatForModel(result);
				const sections = resultToSections(result);
				return { content: [{ type: "text" as const, text }], details: { resultSections: sections } };
			} catch (err: any) {
				const msg = err?.message || String(err);
				return { content: [{ type: "text" as const, text: `web search failed: ${msg}` }], isError: true } as any;
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const TextCtor = getText();
			const text = context?.lastComponent ?? new TextCtor("", 0, 0);
			const q = Array.isArray(args.queries) ? args.queries.join(", ") : "...";
			const short = q.length > 70 ? `${q.slice(0, 70)}...` : q;
			text.setText(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", short));
			return text;
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const sections: BoxSection[] | undefined = result.details?.resultSections;
			if (!sections?.length) {
				const block = result.content?.[0];
				container.addChild(new Text(block?.type === "text" ? block.text : "(no output)", 0, 0));
				return container;
			}
			const renderer = boxRendererWindowed(
				() => sections,
				{
					collapsed: { maxSections: 3, excerpts: COLLAPSED_EXCERPTS },
					expanded: {},
				},
				undefined,
				expanded,
			);
			container.addChild(renderer);

			// expand hint when collapsed
			if (!expanded) {
				const hint = keyHint
					? `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
					: theme.fg("muted", "(Ctrl+O to expand)");
				container.addChild(new Text(hint, 0, 0));
			}

			return container;
		},
	};
}
