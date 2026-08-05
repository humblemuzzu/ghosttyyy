/**
 * oracle tool — expert technical advisor via gpt-5.2 sub-agent.
 *
 * replaces the generic subagent(agent: "oracle", task: ...) pattern
 * with a dedicated tool. the model calls
 * oracle(task: "...", context?: "...", files?: [...]) directly.
 *
 * the oracle operates zero-shot: no follow-up questions, makes its
 * final message comprehensive. only the last assistant message is
 * returned to the parent agent.
 *
 * system prompt loaded from sops-decrypted prompts at init time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { piSpawn, zeroUsage } from "./lib/pi-spawn";
import {
	collectSubAgentImages,
	getFinalOutput,
	renderAgentTree,
	subAgentResult,
	type SingleResult,
} from "./lib/sub-agent-render";
import { requireParam } from "./lib/params";

/** canonical name first; the rest are what models actually guess (see lib/params.ts). */
const ORACLE_PARAM_NAMES = ["task", "query", "prompt", "question", "description"] as const;

const MODEL = "claude-opus-4-6";
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
/*
 * `screenshot` is here so the oracle can look at a rendering bug rather than
 * reason about it blind. NOTE: what comes back to the parent is the oracle's
 * PROSE about the image — `getFinalOutput` keeps text parts only, so the pixels
 * stay inside the child. To see a screenshot yourself, call the tool directly.
 */
const EXTENSION_TOOLS = ["read", "grep", "find", "ls", "bash", "screenshot"];

export interface OracleConfig {
	systemPrompt?: string;
}

export function createOracleTool(config: OracleConfig = {}): ToolDefinition {
	return {
		name: "oracle",
		label: "Oracle",
		description:
			"Consult the oracle - an AI advisor powered by a reasoning model " +
			"that can plan, review, and provide expert guidance.\n\n" +
			"The oracle has access to tools: Read, Grep, glob, ls, Bash.\n\n" +
			"You should consult the oracle for:\n" +
			"- Code reviews and architecture feedback\n" +
			"- Finding difficult bugs across many files\n" +
			"- Planning complex implementations or refactors\n" +
			"- Answering complex technical questions requiring deep reasoning\n" +
			"- Providing an alternative point of view\n\n" +
			"You should NOT consult the oracle for:\n" +
			"- File reads or simple keyword searches (use Read or Grep directly)\n" +
			"- Codebase searches (use finder)\n" +
			"- Basic code modifications (do it yourself or use Task)\n\n" +
			"Usage guidelines:\n" +
			"- Be specific about what you want reviewed, planned, or debugged\n" +
			"- Provide relevant context. If you know which files are involved, list them.\n\n" +
			'Example: oracle({ task: "is this retry loop correct under concurrent writes?", files: ["src/queue.ts"] })',

		parameters: Type.Object({
			// required in the schema, which is what models actually trust.
			// requireParam() below stays as a safety net for providers that do not
			// enforce the schema and for models that guess an alias name.
			task: Type.String({
				description:
					"The task or question for the oracle. Be specific about what guidance you need. " +
					"(Also accepted: query, prompt, question, description.)",
			}),
			context: Type.Optional(
				Type.String({
					description: "Optional context about the current situation or background information.",
				}),
			),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional file paths the oracle should examine.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = requireParam(params as Record<string, unknown>, ORACLE_PARAM_NAMES, "oracle");
			if ("error" in resolved) return resolved.error;
			const taskText = resolved.value;

			let sessionId = "";
			try { sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch { /* graceful */ }

			// compose task with context and inline file contents
			const parts: string[] = [taskText];
			if (params.context) parts.push(`\nContext: ${params.context}`);
			if (params.files && params.files.length > 0) {
				for (const filePath of params.files) {
					const resolved = path.isAbsolute(filePath)
						? filePath
						: path.resolve(ctx.cwd, filePath);
					try {
						const content = fs.readFileSync(resolved, "utf-8");
						parts.push(`\nFile: ${filePath}\n\`\`\`\n${content}\n\`\`\``);
					} catch {
						parts.push(`\nFile: ${filePath} (could not read)`);
					}
				}
			}
			const fullTask = parts.join("\n");

			const singleResult: SingleResult = {
				agent: "oracle",
				task: taskText,
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
							content: [{ type: "text", text: getFinalOutput(partial.messages) || "(thinking...)" }],
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

			// The oracle can screenshot; hand back what it actually looked at so the
			// caller is not taking its word for what was on screen.
			return subAgentResult(output, singleResult, false, collectSubAgentImages(result.messages));
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const preview = args.task
				? (args.task.length > 80 ? `${args.task.slice(0, 80)}...` : args.task)
				: "...";
			let label = theme.fg("toolTitle", theme.bold("oracle ")) + theme.fg("dim", preview);
			if (args.files?.length) {
				label += theme.fg("muted", ` (${args.files.length} file${args.files.length > 1 ? "s" : ""})`);
			}
			text.setText(label);
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
			renderAgentTree(details, container, expanded, theme, { label: "oracle", header: "statusOnly" });
			return container;
		},
	};
}
