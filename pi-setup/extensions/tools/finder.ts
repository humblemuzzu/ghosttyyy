/**
 * finder tool — fast parallel code search via a sub-agent.
 *
 * replaces the generic subagent(agent: "finder", task: ...) pattern
 * with a dedicated tool. the model calls
 * finder(query: "...") instead of routing through the dispatcher.
 *
 * spawns `pi --mode json` constrained to read-only tools
 * (read, grep, find, ls). the finder agent
 * maximizes parallelism (8+ tool calls per turn) and completes
 * within ~3 turns.
 *
 * system prompt loaded from agents/agent.amp.finder.md at init time.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveAliases } from "./lib/pi-spawn";
import { emptyAgentModels, modelParams, resolveRoute, type AgentModels } from "./lib/agent-models";
import { runSubAgent, toolError } from "./lib/run-sub-agent";
import { clip, renderSubAgentResult } from "./lib/sub-agent-render";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const FINDER_PARAM_NAMES = ["query", "task", "prompt", "description", "search"] as const;

const BUILTIN_TOOLS = ["read", "grep", "find", "ls"];
const EXTENSION_TOOLS = ["read", "grep", "find", "ls"];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a finder child receives — testing the raw constants alone
 * would drift from what the child gets, since aliasing and dedupe happen at
 * the spawn seam.
 */
export function finderAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

export interface FinderConfig {
	systemPrompt?: string;
	models?: AgentModels;
}

export function createFinderTool(config: FinderConfig = {}): ToolDefinition {
	const models = config.models ?? emptyAgentModels();
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
			"- When looking for specific symbols or exact strings - use find or Grep\n" +
			"- When you need to create, modify files, or run terminal commands\n\n" +
			"USAGE GUIDELINES:\n" +
			"1. Always spawn multiple search agents in parallel to maximise speed.\n" +
			"2. Formulate your query as a precise engineering request.\n" +
			"3. Name concrete artifacts, patterns, or APIs to narrow scope.\n" +
			"4. State explicit success criteria so the agent knows when to stop.\n" +
			"5. Never issue vague or exploratory commands.\n\n" +
			'Example: finder({ query: "where is the session JSONL written to disk, and what names the file?" })',

		parameters: Type.Object({
			query: Type.String({
				description:
					"The search query describing what to find. Be specific and include " +
					"technical terms, file types, or expected code patterns. " +
					"(Also accepted: task, prompt, question, description.)",
			}),
			...modelParams(models, "finder"),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, FINDER_PARAM_NAMES, "finder");
			if ("error" in resolved) return resolved.error;
			const route = resolveRoute(models, "finder", params, ctx.modelRegistry);
			if ("error" in route) return toolError(route.error);

			return runSubAgent({
				agent: "finder",
				label: resolved.value,
				working: "(searching...)",
				ctx,
				signal,
				onUpdate,
				spawn: {
					task: resolved.value,
					model: route.model,
					thinkingLevel: route.thinking,
					builtinTools: BUILTIN_TOOLS,
					extensionTools: EXTENSION_TOOLS,
					systemPromptBody: config.systemPrompt,
				},
			});
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("finder ")) + theme.fg("dim", args.query ? clip(args.query, 80) : "..."));
			return text;
		},

		renderResult: renderSubAgentResult("finder"),
	};
}
