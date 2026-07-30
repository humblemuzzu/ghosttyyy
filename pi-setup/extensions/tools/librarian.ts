/**
 * librarian tool — cross-repo codebase understanding via haiku sub-agent.
 *
 * replaces the generic subagent pattern with a dedicated tool. the model
 * calls librarian(query: "...", repository?: [...], context?: "...") directly.
 *
 * SCHEMA IS THE CONTRACT. `query` is genuinely required and `repository` is a
 * real field, because the previous shape lied: the schema marked everything
 * optional while the prose said "REQUIRED", and the description talked about
 * "what repositories you want to understand" when no repository parameter
 * existed. a model asked to explore two specific repos could not trust the
 * spec, so it read this file to find the argument shape. see the tool-contract
 * invariants in tool-contract.test.ts, which now fail if that regresses.
 *
 * spawns `pi --mode json` with claude haiku, constrained to the 7
 * github tools (read_github, search_github, list_directory_github,
 * list_repositories, glob_github, commit_search, diff). the librarian
 * explores repos thoroughly before providing comprehensive answers.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "./lib/pi-spawn";
import { getFinalOutput, renderAgentTree, subAgentResult, type SingleResult } from "./lib/sub-agent-render";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const LIBRARIAN_PARAM_NAMES = ["query", "task", "prompt", "question", "description"] as const;

/**
 * accept what models actually send for `repository`.
 *
 * the schema asks for an array, but a model given a single repo frequently
 * sends a bare string, and some providers deliver arrays JSON-stringified
 * (the exact failure that made pi-tasks' array params unusable). tolerating
 * both here is cheaper than a validation error the model has to guess its way
 * out of.
 */
export function normalizeRepositories(input: unknown): string[] {
	if (input == null) return [];
	let value = input;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				value = JSON.parse(trimmed);
			} catch {
				return trimmed ? [trimmed] : [];
			}
		} else {
			return trimmed ? [trimmed] : [];
		}
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((r): r is string => typeof r === "string")
		.map((r) => r.trim())
		.filter((r) => r.length > 0);
}

const MODEL = "claude-haiku-4-5";

export interface LibrarianConfig {
	systemPrompt?: string;
}

/** github tools are extension tools, not builtins. */
const BUILTIN_TOOLS: string[] = [];
const EXTENSION_TOOLS = [
	"read_github",
	"search_github",
	"list_directory_github",
	"list_repositories",
	"glob_github",
	"commit_search",
	"diff",
];

export function createLibrarianTool(config: LibrarianConfig = {}): ToolDefinition {
	return {
		name: "librarian",
		label: "Librarian",
		description:
			"The Librarian — a specialized codebase understanding agent that helps answer " +
			"questions about large, complex codebases across GitHub repositories.\n\n" +
			"The Librarian reads from GitHub — it can see public repositories and private " +
			"repositories you have access to via `gh` CLI auth.\n\n" +
			"WHEN TO USE THE LIBRARIAN:\n" +
			"- Understanding complex multi-repository codebases\n" +
			"- Exploring relationships between different repositories\n" +
			"- Analyzing architectural patterns across projects\n" +
			"- Finding specific implementations across codebases\n" +
			"- Understanding code evolution and commit history\n" +
			"- Getting comprehensive explanations of how features work\n\n" +
			"WHEN NOT TO USE THE LIBRARIAN:\n" +
			"- Simple local file reading (use Read directly)\n" +
			"- Local codebase searches (use finder)\n" +
			"- Code modifications (use other tools)\n\n" +
			"USAGE GUIDELINES:\n" +
			"- Name the repositories in `repository` (as owner/repo or a full URL)\n" +
			"- Provide context about what you're trying to achieve\n" +
			"- The Librarian explores thoroughly before providing comprehensive answers\n" +
			"- When getting an answer from the Librarian, show it to the user in full, do not summarize it.\n\n" +
			'Example: librarian({ repository: ["xai-org/grok-build"], query: "how are sub-agent results rendered in the TUI?" })',

		parameters: Type.Object({
			// required in the schema, which is what models actually trust.
			// requireParam() below stays as a safety net for providers that do not
			// enforce the schema and for models that guess an alias name.
			query: Type.String({
				description:
					"Your question about the codebase. Be specific about what you want to understand. " +
					"(Also accepted: task, prompt, question, description.)",
			}),
			repository: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Repositories to explore, each as 'owner/repo' or a full GitHub URL. " +
						"Pass several to compare across repos. Omit only if the query itself names them.",
				}),
			),
			context: Type.Optional(
				Type.String({
					description: "Optional context about what you're trying to achieve or background information.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, LIBRARIAN_PARAM_NAMES, "librarian");
			if ("error" in resolved) return resolved.error;
			const queryText = resolved.value;

			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch { /* graceful */ }

			const parts: string[] = [queryText];
			// repository is structured input; the sub-agent only reads prose, so
			// surface it explicitly rather than hoping the query mentions it.
			const repos = normalizeRepositories(params.repository);
			if (repos.length > 0) {
				parts.push(`\nRepositories to explore:\n${repos.map((r) => `- ${r}`).join("\n")}`);
			}
			if (params.context) parts.push(`\nContext: ${params.context}`);
			const fullTask = parts.join("\n");

			const singleResult: SingleResult = {
				agent: "librarian",
				task: queryText,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: fullTask,
				model: MODEL,
				parentModel: `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				systemPromptBody: config.systemPrompt,
				signal,
				sessionId,
				onUpdate: (partial) => {
					singleResult.messages = partial.messages;
					singleResult.usage = partial.usage;
					singleResult.model = partial.model;
					singleResult.stopReason = partial.stopReason;
					singleResult.errorMessage = partial.errorMessage;
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(exploring...)" }],
							details: singleResult,
						} as any);
					}
				},
			});

			singleResult.exitCode = result.exitCode;
			singleResult.messages = result.messages;
			singleResult.usage = result.usage;
			singleResult.model = result.model;
			singleResult.stopReason = result.stopReason;
			singleResult.errorMessage = result.errorMessage;

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			const output = getFinalOutput(result.messages) || "(no output)";

			if (isError) {
				return subAgentResult(result.errorMessage || result.stderr || output, singleResult, true);
			}

			return subAgentResult(output, singleResult);
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const preview = args.query
				? (args.query.length > 80 ? `${args.query.slice(0, 80)}...` : args.query)
				: "...";
			text.setText(theme.fg("toolTitle", theme.bold("librarian ")) + theme.fg("dim", preview));
			return text;
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content[0];
				container.addChild(new Text(text?.type === "text" ? text.text : "(no output)", 0, 0));
				return container;
			}
			renderAgentTree(details, container, expanded, theme, { label: "librarian", header: "statusOnly" });
			return container;
		},
	};
}
