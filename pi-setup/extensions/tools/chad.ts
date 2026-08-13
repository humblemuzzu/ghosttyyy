/**
 * chad — a read-only deep research sub-agent, pinned to deepseek-v4-flash.
 *
 * WHAT IT IS FOR
 *
 * research at swarm scale. five or eight chads go out in one message, each on
 * its own question, and each returns a structured report instead of a pile of
 * file contents. the parent keeps its context for the work.
 *
 * WHY IT IS PINNED (and why that needed a change in pi-spawn)
 *
 * deepseek-v4-flash is $0.14/$0.28 per M with a 1M window. that is what makes a
 * swarm affordable — roughly 35x cheaper on input than opus — so the model is
 * not an implementation detail here, it IS the tool. `pinModel` exists for
 * exactly that: piSpawn otherwise copies the parent's model whenever the parent
 * is not anthropic, which would silently turn a chad launched from a kimi or
 * sakana session into a kimi or sakana agent.
 *
 * WHY IT IS READ-ONLY
 *
 * two reasons, and the second is the one that shaped the tool surface.
 *
 * first: research is what a swarm is good at. six agents reading in parallel
 * compose; six agents writing in parallel need coordination our locks cannot
 * provide, because `lib/mutex.ts` is a module-level Map and every sub-agent is
 * a separate OS process.
 *
 * second: dropping `apply_patch` is only half a constraint. bash writes. so the
 * child also runs under the read-only bash policy (lib/read-only-bash.ts),
 * enforced in its own process, not requested in its prompt.
 *
 * NOT INHERITED FROM delegate
 *
 * `collectSubAgentImages` is deliberately absent. deepseek is text-only
 * (`input: ["text"]`), so a chad that opens a PNG sees a placeholder — pi-ai
 * downgrades it. the pixels would still be sitting in the child's messages and
 * would land in the PARENT's context, which can see them: an expensive image
 * arriving with no comment on it, because the agent that fetched it was blind.
 * a chad returns prose.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { requireParam, resolveParam } from "./lib/params";
import { piSpawn, resolveAliases, zeroUsage, SUB_AGENT_SESSION_DIR } from "./lib/pi-spawn";
import {
	applySessionMeta,
	getFinalOutput,
	renderAgentTree,
	subAgentResult,
	type SingleResult,
} from "./lib/sub-agent-render";

/**
 * provider-qualified on purpose. `pinModel` passes this through untouched, so a
 * bare id would hit pi 0.84's "ambiguous across providers" error (#7327)
 * instead of quietly resolving somewhere else.
 */
const MODEL = "deepseek/deepseek-v4-flash";
const THINKING = "high";
/** the env var that carries this provider's auth. checked before spawning. */
const API_KEY_ENV = "DEEPSEEK_API_KEY";

/*
 * NO mutation tool of any kind: no apply_patch, no format_file, no undo_edit.
 * `bash` is present but runs under the read-only policy (readOnlyBash below).
 *
 * `screenshot` is out because deepseek has no vision. `oracle`, `finder` and
 * `librarian` are out because piSpawn hands a child the parent's model when the
 * parent is not anthropic — inside a chad they would all be deepseek, and a
 * deepseek "opus" is not an oracle. the seven github tools are here directly
 * for the same reason: nesting a librarian would spawn a whole extra process to
 * reach tools chad can just call. `chad` and `delegate` are out because a
 * swarm that can spawn swarms is a fork bomb.
 */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash"];
const EXTENSION_TOOLS = [
	"read", "grep", "find", "ls", "bash", "skill",
	"web_search", "read_web_page",
	"read_github", "search_github", "list_directory_github",
	"list_repositories", "glob_github", "commit_search", "diff",
];

/**
 * the merged, deduped, alias-resolved allowlist piSpawn turns into `--tools`
 * and exports to the child as its tool list. exported so tests can pin the
 * exact surface a chad child receives — testing the raw constants alone would
 * drift from what the child gets, since aliasing (glob -> find) and dedupe
 * happen at the spawn seam.
 */
export function chadAllowlist(): string[] {
	return resolveAliases([...BUILTIN_TOOLS, ...EXTENSION_TOOLS]);
}

/** parameter names models actually reach for, canonical first. */
const PROMPT_PARAMS = ["prompt", "task", "query", "question", "instructions"] as const;
const DESCRIPTION_PARAMS = ["description", "title", "summary"] as const;

/** first line of the prompt, as a stand-in when no description was given. */
function deriveDescription(prompt: string): string {
	const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
	if (!firstLine) return "research task";
	return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

/**
 * append the handle needed to resume this child.
 *
 * the model only learns a child is resumable if the id is in the text it reads,
 * so this is part of the result rather than details-only metadata.
 */
function withRoutingMetadata(text: string, result: SingleResult): string {
	const lines: string[] = [];
	if (result.continueId) lines.push(`continueId: ${result.continueId}`);
	if (result.sessionId && result.sessionId !== result.continueId) {
		lines.push(`sessionId: ${result.sessionId}`);
	}
	return lines.length > 0 ? `${text}\n\n---\nrouting:\n${lines.join("\n")}` : text;
}

export interface ChadConfig {
	systemPrompt?: string;
}

export function createChadTool(config: ChadConfig = {}): ToolDefinition {
	return {
		name: "chad",
		label: "Chad",
		description:
			"Deep read-only research agent. Runs on a cheap 1M-context model, so several " +
			"can be launched at once for genuinely parallel research.\n\n" +
			"Tools: read, grep, find, ls, bash (read-only), skill, web_search, read_web_page, " +
			"and the seven GitHub tools.\n\n" +
			"IT CANNOT CHANGE ANYTHING. There is no apply_patch and bash is restricted to " +
			"read-only commands. Use it to find out; use delegate to do.\n\n" +
			"When to use chad:\n" +
			"- A question that needs a lot of reading to answer properly\n" +
			"- Several independent questions at once — issue one call per question, in a single message\n" +
			"- Research whose intermediate reading would flood your context but whose conclusion is small\n" +
			"- Tracing how something works across many files, repos, or the web\n\n" +
			"When NOT to use chad:\n" +
			"- Anything that must change a file (use delegate, or do it yourself)\n" +
			"- A single lookup you can do with read or grep\n" +
			"- A search for one symbol or exact string (use grep or finder)\n" +
			"- Architecture judgement or an expert second opinion (use oracle)\n\n" +
			"How to use chad:\n" +
			"- Give each chad ONE question and everything it needs to answer it: the working " +
			"directory, the files or repos to start from, and what a complete answer looks like.\n" +
			"- It shares none of your context. Do not refer to earlier conversation.\n" +
			"- It reports back as Answer / Evidence / Verified vs inferred / Gaps, with path:line " +
			"citations you can check.\n" +
			"- To push the same chad further, pass `continueId` from its result rather than " +
			"starting a new one — it keeps its full history.\n\n" +
			'Example: chad({ prompt: "In /repo, how does the session file get written and what names it? Start from src/session/. Answer with the exact function and path:line.", description: "session file naming" })',

		parameters: Type.Object({
			// required in the schema, which is what models actually trust.
			// requireParam() below stays as a safety net for providers that do not
			// enforce the schema and for models that guess an alias name.
			prompt: Type.String({
				description:
					"The research question. The agent shares none of your context, so include the " +
					"working directory, where to start looking, and what a complete answer looks like. " +
					"(Also accepted: task, query, question, instructions.)",
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
						"Resume a previous chad by the continueId returned in its result. The agent keeps its full conversation history.",
				}),
			),
		}),

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const prompt = requireParam(params, PROMPT_PARAMS, "chad");
			if ("error" in prompt) return prompt.error as any;

			/*
			 * preflight the credential rather than spawning into an auth failure.
			 * a swarm makes this worth doing: eight children each taking ~10s to
			 * die on the same missing key is eight confusing errors instead of one
			 * clear one, and the pi-side message reads like a model problem.
			 */
			if (!process.env[API_KEY_ENV]?.trim()) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`chad runs on ${MODEL}, and ${API_KEY_ENV} is not set in this environment.\n\n` +
								`Export it (it lives in ~/.zshrc alongside the other provider keys) and start a ` +
								`new session, or use delegate, which inherits your own model.`,
						},
					],
					isError: true,
				} as any;
			}

			const description =
				resolveParam(params, DESCRIPTION_PARAMS) ?? deriveDescription(prompt.value);
			const continueId = resolveParam(params, ["continueId", "continue_id", "sessionId"]);

			let sessionId = "";
			try {
				sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
			} catch {
				/* graceful — provenance only */
			}

			const singleResult: SingleResult = {
				agent: "chad",
				task: description,
				exitCode: -1,
				messages: [],
				usage: zeroUsage(),
			};

			const result = await piSpawn({
				cwd: ctx.cwd,
				task: prompt.value,
				model: MODEL,
				// pinned: NOT parentModel. see PiSpawnConfig.pinModel — inheriting
				// here would make a chad launched from kimi or sakana that model.
				pinModel: true,
				thinkingLevel: THINKING,
				readOnlyBash: true,
				builtinTools: BUILTIN_TOOLS,
				extensionTools: EXTENSION_TOOLS,
				systemPromptBody: config.systemPrompt,
				signal,
				sessionId,
				// persist so a chad can be pushed further on the same findings, but
				// in the sub-agent directory so these never clutter /resume.
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
								{ type: "text", text: getFinalOutput(partial.messages) || "(researching...)" },
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

			return subAgentResult(withRoutingMetadata(output, singleResult), singleResult, false);
		},

		renderCall(args: any, theme: any, context: any) {
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const raw =
				args?.description ||
				(typeof args?.prompt === "string" ? deriveDescription(args.prompt) : "") ||
				"...";
			const preview = raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
			// a resumed chad is visually distinct from a fresh one
			const marker = args?.continueId ? "Chad ↻ " : "Chad ";
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
				label: "Chad",
				header: "statusOnly",
			});
			return container;
		},
	};
}
