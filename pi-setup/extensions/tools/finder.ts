/**
 * finder tool — fast parallel code search via gemini flash sub-agent.
 *
 * replaces the generic subagent(agent: "finder", task: ...) pattern
 * with a dedicated tool. the model calls
 * finder(query: "...") instead of routing through the dispatcher.
 *
 * spawns `pi --mode json` with gemini flash, constrained to
 * read-only tools (read, grep, find, ls, glob). the finder agent
 * maximizes parallelism (8+ tool calls per turn) and completes
 * within ~3 turns.
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
const FINDER_PARAM_NAMES = ["query", "task", "prompt", "description", "search"] as const;

const MODEL = "claude-haiku-4-5";
const BUILTIN_TOOLS = ["read", "grep", "find", "ls"];
const EXTENSION_TOOLS = ["read", "grep", "find", "ls"];

export interface FinderConfig {
	systemPrompt?: string;
}

export function createFinderTool(config: FinderConfig = {}): ToolDefinition {
	return {
		name: "finder",
		label: "Finder",
		description:
			"Intelligently search your codebase: Use it for complex, multi-step search tasks " +
			"where you need to find code based on functionality or concepts rather than exact matches. " +
			"Anytime you want to chain multiple grep calls you should use this tool.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- You must locate code by behavior or concept\n" +
			"- You need to run multiple greps in sequence\n" +
			"- You must correlate or look for connection between several areas of the codebase\n" +
			"- You must filter broad terms by context\n" +
			"- You need answers to questions like \"Where do we validate JWT headers?\"\n\n" +
			"WHEN NOT TO USE THIS TOOL:\n" +
			"- When you know the exact file path - use Read directly\n" +
			"- When looking for specific symbols or exact strings - use glob or Grep\n" +
			"- When you need to create, modify files, or run terminal commands\n\n" +
			"USAGE GUIDELINES:\n" +
			"1. Always spawn multiple search agents in parallel to maximise speed.\n" +
			"2. Formulate your query as a precise engineering request.\n" +
			"3. Name concrete artifacts, patterns, or APIs to narrow scope.\n" +
			"4. State explicit success criteria so the agent knows when to stop.\n" +
			"5. Never issue vague or exploratory commands.\n\n" +
			'Example: finder({ query: "where is the session JSONL written to disk, and what names the file?" })',

		parameters: Type.Object({
			// required in the schema, which is what models actually trust.
			// requireParam() below stays as a safety net for providers that do not
			// enforce the schema and for models that guess an alias name.
			query: Type.String({
				description:
					"The search query describing what to find. Be specific and include " +
					"technical terms, file types, or expected code patterns. " +
					"(Also accepted: task, prompt, question, description.)",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, FINDER_PARAM_NAMES, "finder");
			if ("error" in resolved) return resolved.error;
			const queryText = resolved.value;

			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch { /* graceful */ }

			const singleResult: SingleResult = {
				agent: "finder",
				task: queryText,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: queryText,
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
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(searching...)" }],
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
			text.setText(theme.fg("toolTitle", theme.bold("finder ")) + theme.fg("dim", preview));
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
			renderAgentTree(details, container, expanded, theme, { label: "finder", header: "statusOnly" });
			return container;
		},
	};
}
