/**
 * delegate — spawn a sub-agent for an independent chunk of work.
 *
 * PROVENANCE
 * ported from bdsqqq/dots `user/pi/packages/extensions/delegate/index.ts`
 * (MIT, commit e04b620), replacing our `task.ts`. adapted:
 *   - `@bds_pi/*` -> `./lib/*`, `typebox` -> `@sinclair/typebox`,
 *     `@earendil-works/*` -> `@mariozechner/*`
 *   - his DI wrapper / config plumbing dropped; tool lists are consts here,
 *     matching how finder/oracle/librarian are written in this repo
 *   - OUR model inheritance is KEPT and his omission fixed (see MODEL below)
 *   - `description` is optional with a derived fallback (see PARAMS below)
 *
 * WHAT IT ADDS OVER `Task`
 * continuation. a delegate child can be resumed by passing back the
 * `continueId` from its result, so a follow-up question costs one more turn
 * instead of re-establishing the entire context. `Task` always ran
 * `--no-session`, so every child was a dead end.
 *
 * MODEL
 * upstream passes no model at all, which on our setup would silently fall back
 * to settings' defaultProvider rather than the model the parent is actually
 * using. we pass `parentModel` so the child inherits the parent's
 * provider+auth route (see pi-spawn's resolution block).
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { requireParam, resolveParam } from "./lib/params";
import { piSpawn, resolveAliases, zeroUsage, SUB_AGENT_SESSION_DIR } from "./lib/pi-spawn";
import {
	applySessionMeta,
	collectSubAgentImages,
	getFinalOutput,
	renderAgentTree,
	subAgentResult,
	type SingleResult,
} from "./lib/sub-agent-render";

/*
 * `apply_patch` rather than edit/write: those tools no longer exist, and pi's
 * natives are hidden at session_start, so naming them would leave the child
 * unable to modify anything.
 */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "apply_patch"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash",
	"apply_patch", "format_file", "skill", "finder",
	"web_search", "read_web_page", "screenshot",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`.
 * exported so tests can pin the exact tool surface a child actually receives —
 * testing the raw constants alone would drift from what the child gets, since
 * aliasing (glob -> find) and dedupe happen at the spawn seam.
 */
export function delegateAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

/** parameter names models actually reach for, canonical first. */
const PROMPT_PARAMS = ["prompt", "task", "instructions"] as const;
const DESCRIPTION_PARAMS = ["description", "title", "summary"] as const;

/**
 * append the handles needed to resume this child.
 *
 * the model only learns a child is resumable if the id is in the text it
 * reads, so this is part of the result rather than details-only metadata.
 */
function withRoutingMetadata(text: string, result: SingleResult): string {
	const lines: string[] = [];
	if (result.continueId) lines.push(`continueId: ${result.continueId}`);
	if (result.sessionId && result.sessionId !== result.continueId) {
		lines.push(`sessionId: ${result.sessionId}`);
	}
	return lines.length > 0 ? `${text}\n\n---\nrouting:\n${lines.join("\n")}` : text;
}

/** first line of the prompt, as a stand-in when no description was given. */
function deriveDescription(prompt: string): string {
	const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) return "delegated task";
	return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

export function createDelegateTool(): ToolDefinition {
	return {
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a sub-task to a sub-agent that has access to the following tools: " +
			"read, grep, find, ls, bash, apply_patch, format_file, skill, finder, " +
			"web_search, read_web_page, screenshot.\n\n" +
			"When to use delegate:\n" +
			"- Complex multi-step tasks that are independent of your current thread\n" +
			"- Work whose intermediate output would flood your context but is not needed afterwards\n" +
			"- Changes across many layers, once you have already planned them\n" +
			'- When the user asks you to launch an "agent" or "subagent"\n\n' +
			"When NOT to use delegate:\n" +
			"- A single logical task you can do yourself in a few tool calls\n" +
			"- Reading one file (use read), one search (use grep), one edit (use apply_patch)\n" +
			"- When you are not yet sure what changes you want\n\n" +
			"How to use delegate:\n" +
			"- Run several delegates concurrently for independent work by issuing multiple tool calls in one message.\n" +
			"- The sub-agent shares no context with you: put everything it needs in `prompt`.\n" +
			"- Tell it how to verify its own work.\n" +
			"- To ask a follow-up of the SAME sub-agent, pass `continueId` from its previous result " +
			"instead of starting a new delegate — it keeps its full history.\n\n" +
			'Example: delegate({ prompt: "In /repo, convert src/auth/*.ts to strict mode. Run `bun test` and report failures.", description: "auth strict mode" })',

		parameters: Type.Object({
			/*
			 * `prompt` is required in the SCHEMA, and required in practice.
			 *
			 * it was Optional, to let requireParam() rescue an aliased call like
			 * {task: "..."} — pi validates before execute(), so a required
			 * property turns that near-miss into a bare "must have required
			 * properties prompt" and burns a turn (measured with haiku).
			 *
			 * that trade was wrong. Optional means the wire schema says
			 * `required: []` while this description said "REQUIRED", and a model
			 * cannot resolve that contradiction from the spec — so it reads this
			 * file to find the argument shape, in EVERY fresh session. The alias
			 * miss is rare and self-correcting (the schema error names the exact
			 * property); the contradiction tax was constant. So: required.
			 *
			 * requireParam() below is kept as a safety net — not every provider
			 * enforces the schema, and it still resolves PROMPT_PARAMS aliases
			 * wherever validation is lenient.
			 *
			 * grammar sampling is NOT a concern: it is opt-in via a tool's
			 * `constrainedSampling` field (pi-ai resolveGrammarConstrainedSampling
			 * returns early when absent), and delegate does not declare one. The
			 * "exactly one required string property" rule binds apply_patch only.
			 */
			prompt: Type.String({
				description:
					"The task for the sub-agent. It shares none of your context, so include the working " +
					"directory, the goal, the files involved, and how to verify success. " +
					"(Also accepted: task, query, question, description.)",
			}),
			description: Type.Optional(
				Type.String({
					description:
						"Short label for the task, shown to the user. Defaults to the first line of the prompt.",
				}),
			),
			continueId: Type.Optional(
				Type.String({
					description:
						"Resume a previous delegate child by the continueId returned in its result. The child keeps its full conversation history.",
				}),
			),
		}),

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const prompt = requireParam(params, PROMPT_PARAMS, "delegate");
			if ("error" in prompt) return prompt.error as any;

			const description =
				resolveParam(params, DESCRIPTION_PARAMS) ?? deriveDescription(prompt.value);
			const continueId = resolveParam(params, ["continueId", "continue_id", "sessionId"]);

			let sessionId = "";
			try {
				sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
			} catch {
				/* graceful — provenance only */
			}

			// inherit the parent's model so the child uses the same provider and
			// auth route rather than settings' defaultProvider.
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			const singleResult: SingleResult = {
				agent: "delegate",
				task: description,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: prompt.value,
				model: parentModel,
				parentModel,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				signal,
				sessionId,
				// persist so the child can be resumed, but in the sub-agent session
				// directory so these never clutter pi's /resume picker.
				session: { id: continueId, persist: true, dir: SUB_AGENT_SESSION_DIR },
				onUpdate: (partial) => {
					singleResult.messages = partial.messages;
					singleResult.usage = partial.usage;
					singleResult.model = partial.model;
					singleResult.stopReason = partial.stopReason;
					singleResult.errorMessage = partial.errorMessage;
					applySessionMeta(singleResult, partial.session);
					if (onUpdate) {
						onUpdate({
							content: [
								{ type: "text", text: getFinalOutput(partial.messages) || "(working...)" },
							],
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
			applySessionMeta(singleResult, result.session);

			const isError =
				result.exitCode !== 0 ||
				result.stopReason === "error" ||
				result.stopReason === "aborted";
			const output = getFinalOutput(result.messages) || "(no output)";

			if (isError) {
				return subAgentResult(
					withRoutingMetadata(result.errorMessage || result.stderr || output, singleResult),
					singleResult,
					true,
				);
			}

			return subAgentResult(
				withRoutingMetadata(output, singleResult),
				singleResult,
				false,
				collectSubAgentImages(result.messages),
			);
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const raw =
				args?.description ||
				(typeof args?.prompt === "string" ? deriveDescription(args.prompt) : "") ||
				"...";
			const preview = raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
			// a resumed child is visually distinct from a fresh one
			const marker = args?.continueId ? "Delegate ↻ " : "Delegate ";
			text.setText(theme.fg("toolTitle", theme.bold(marker)) + theme.fg("dim", preview));
			return text;
		},

		renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const details = result.details as SingleResult | undefined;
			if (!details) {
				const text = result.content?.[0];
				container.addChild(new Text(text?.type === "text" ? text.text : "(no output)", 0, 0));
				return container;
			}
			renderAgentTree(details, container, expanded, theme, {
				label: "Delegate",
				header: "statusOnly",
			});
			return container;
		},
	};
}
