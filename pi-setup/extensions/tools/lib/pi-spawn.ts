/**
 * shared pi process spawning for dedicated sub-agent tools.
 *
 * extracts the spawn-parse-collect loop from the generic subagent
 * extension into a reusable function. each dedicated tool (finder,
 * oracle, code_review, delegate, chad, librarian) calls piSpawn() with its own config.
 *
 * uses shared interpolation from ./interpolate for template variables
 * ({cwd}, {roots}, {date}, etc.) in system prompts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { interpolatePromptVars, type InterpolateContext } from "./interpolate";
import { SUB_AGENT_TOOLS_ENV } from "./sub-agent-prompt";
import { READ_ONLY_BASH_ENV } from "./read-only-bash";
import { watchdogTickMs, watchdogVerdict } from "./watchdog";

// --- stall watchdog ---

/*
 * WHY A SUB-AGENT NEEDS A WATCHDOG AND AN INTERACTIVE SESSION DOES NOT
 *
 * pi has no deadline on a tool call or an agent turn anywhere (verified: zero
 * setTimeout in agent-loop.js). that is defensible for the TUI, where the HUMAN
 * is the watchdog and Esc always works. a spawned child is headless: there is no
 * Esc, and a frozen one is indistinguishable from a busy one until someone walks
 * back to the laptop. measured consequence: a delegate sat wedged for 2h22m
 * overnight and the parent waited on `proc` the entire time.
 *
 * the signal this uses costs nothing because it already exists. pi's print mode
 * writes EVERY session event to stdout (print-mode.js: `session.subscribe(e =>
 * writeRawStdout(JSON.stringify(toJsonEvent(e))))`), and a tool's `onUpdate`
 * becomes a `tool_execution_update` event -- so a child running a command that
 * prints emits parent-side traffic at that command's own cadence. measured
 * end-to-end against a real child ticking every 5s: max gap between stdout
 * events 5.1s. a child frozen inside a hung command emits nothing at all.
 *
 * so this watches RAW BYTES on stdout/stderr rather than parsed events -- most
 * of the traffic (`tool_execution_update`, `message_update`) is deliberately
 * ignored by `processLine` below, and counting only the events we parse would
 * blind the watchdog to exactly the streaming that proves liveness.
 *
 * it is a BACKSTOP, not the primary guard. bash bounds its own commands (a
 * declared timeout, ceiling 600s, plus an idle kill at 300s), so this window
 * sits well above any legal command and can never race one. when it fires it
 * means the child froze somewhere that is not bash: a model API call, a fetch
 * with no timeout, a deadlock.
 *
 * WHY 900s AND NOT LESS -- the longest stretch a HEALTHY child can legitimately
 * stay silent, measured against pi 0.84.1's own defaults:
 *
 *   pi's HTTP idle timeout        300s   http-dispatcher.js DEFAULT_HTTP_IDLE_TIMEOUT_MS
 *   provider retry delay (cap)     60s   settings-manager getProviderRetrySettings
 *   agent-turn retry backoff        8s   maxRetries 3 x baseDelayMs 2000, and it
 *                                        emits `auto_retry_start` BEFORE sleeping,
 *                                        so the parent sees traffic either way
 *   our own bash idle kill        300s   bash.ts, bounds any silent command first
 *
 * worst realistic case is a stream idling to pi's own 300s limit and then
 * backing off: ~360s. 900s is 2.5x that. shrink this only after re-checking
 * those four numbers -- an over-eager window kills working children, which is a
 * worse failure than the one it prevents.
 */
const DEFAULT_STALL_SEC = 900;
const STALL_TICK_MS = 30_000;

/**
 * how long after a kill we still wait for `proc.on("close")` before returning
 * anyway.
 *
 * killing is not the same as being released. `close` fires when the child exits
 * AND its stdio pipes close, and a grandchild that inherited stdout holds those
 * pipes open after the child itself is gone -- so SIGKILL can succeed while the
 * parent goes on waiting forever, which is precisely the failure this watchdog
 * exists to end. found by the stall test: the watchdog fired correctly at 1s and
 * `piSpawn` still returned at 60s.
 *
 * the child is NOT spawned `detached`, deliberately: a detached child sits in
 * its own process group and would no longer receive the terminal's SIGINT, so
 * Ctrl+C would leave orphaned sub-agents burning tokens. keeping it in our group
 * and force-releasing here is the safer half of that trade.
 */
const FORCE_RELEASE_MS = 10_000;

/**
 * one tick observing this much wall time means the machine slept, not that the
 * child died. same guard, same reasoning, as bash.ts's idle watchdog: a
 * spurious reset grants one more window, a missing guard kills a healthy child
 * the moment the lid opens.
 */
const SLEEP_JUMP_MS = 60_000;

function stallSec(): number {
	const raw = process.env.PI_SPAWN_STALL_SEC;
	if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_SEC;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STALL_SEC;
	return Math.floor(parsed);
}

// --- tool name aliases ---

/**
 * alias map: requested name -> actually-registered name.
 *
 * pi has no `glob` tool (the built-in is `find`), and our edit/create tools
 * register as `edit`/`write`. callers that ask for the old/other names would
 * otherwise be silently dropped from the --tools allowlist, leaving sub-agents
 * without those capabilities.
 *
 * ported from bdsqqq's tool-harness TOOL_ALIASES, retargeted to our registered
 * names. every mutation name now resolves to apply_patch: edit-file.ts and
 * create-file.ts are gone, and pi's natives are hidden at session_start (see
 * index.ts), so a config still asking for "edit"/"write" would otherwise
 * silently grant the sub-agent NO way to change a file.
 */
const TOOL_ALIASES: Record<string, string> = {
	glob: "find",
	// every mutation name now resolves to apply_patch: edit-file.ts and
	// create-file.ts are gone, and pi's natives are hidden at session_start
	// (see index.ts), so a config still asking for "edit"/"write" would
	// otherwise silently grant the sub-agent NO way to change a file.
	edit_file: "apply_patch",
	create_file: "apply_patch",
	edit: "apply_patch",
	write: "apply_patch",
};

export function resolveAliases(names: string[]): string[] {
	return [...new Set(names.map((name) => TOOL_ALIASES[name] ?? name))];
}

// --- types ---

/**
 * where persisted SUB-AGENT conversations live.
 *
 * deliberately NOT pi's own `sessions/` directory. pi's `/resume` picker lists
 * everything it finds there, so persisting delegate children alongside your
 * real sessions buries them: ~7 delegate calls in one test run produced 7
 * entries that pushed actual work off the first screen.
 *
 * keeping them in a sibling directory means:
 *   - `/resume` shows only YOUR sessions, in every scope (folder AND all)
 *   - children stay fully resumable, because `--session-dir` is passed on
 *     resume as well as creation
 *   - they remain browsable on demand:
 *       pi --session-dir ~/.pi/agent/sessions-sub --resume
 *   - `search_sessions` can still index them (see its sessionsDirs default)
 */
export const SUB_AGENT_SESSION_DIR: string = path.join(
	os.homedir(),
	".pi",
	"agent",
	"sessions-sub",
);

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/**
 * where a sub-agent's conversation was stored, when it was persisted.
 *
 * `continueId` is the handle a caller passes back to resume the same child:
 * it is the pi session id, which `--session-id` resolves (creating the
 * session on first use, reopening it afterwards).
 */
export interface SpawnSessionMeta {
	continueId?: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
}

/**
 * how the child's conversation should be stored.
 *
 * omitted entirely (the default) means `--no-session`: sub-agents are
 * throwaway and must not litter the session list. only `delegate` opts in,
 * because resuming a child is its whole point.
 */
export interface SpawnSessionConfig {
	/** resume this session id; created if it does not exist yet. */
	id?: string;
	/** persist the conversation. false / omitted keeps the child ephemeral. */
	persist?: boolean;
	/**
	 * where to store the conversation. defaults to pi's own session directory.
	 *
	 * sub-agents set this to SUB_AGENT_SESSION_DIR so their sessions stay OUT
	 * of the `/resume` picker — a handful of delegate calls otherwise buries
	 * your real sessions under machine-generated ones.
	 */
	dir?: string;
	/** parent session file, recorded for provenance only. */
	parentSession?: string;
	/**
	 * branch leaf to continue. pi's CLI has no flag for targeting a specific
	 * leaf, so this is REJECTED rather than silently ignored — quietly
	 * continuing from the wrong branch point would corrupt the child's history.
	 */
	leafId?: string;
}

export interface PiSpawnResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	session?: SpawnSessionMeta;
}

export interface PiSpawnConfig {
	cwd: string;
	task: string;
	model?: string;
	/**
	 * the parent session's full model string (e.g. "anthropic/claude-opus-5").
	 * when set, takes priority over `model` so child processes use the same
	 * provider+auth route as the parent session.
	 */
	parentModel?: string;
	/**
	 * never inherit the parent's model — `model` is used verbatim.
	 *
	 * the inheritance rule below exists for ONE reason: finder/oracle/librarian
	 * name claude models, and a non-anthropic parent has no route to serve them,
	 * so copying the parent is the only thing that can work. that reasoning does
	 * not apply to a sub-agent pinned to a model its own provider serves
	 * regardless of the parent — `chad` and `delegate` run xai/grok-4.5, not
	 * whatever the parent happens to be on.
	 *
	 * a pinned model must already be provider-qualified ("xai/grok-4.5").
	 * it is passed through untouched, so a bare id would hit pi 0.84's ambiguity
	 * error (#7327) rather than resolving to the wrong provider silently.
	 */
	pinModel?: boolean;
	/**
	 * thinking level for the child (`--thinking`). one of pi's levels: off,
	 * minimal, low, medium, high, xhigh, max.
	 *
	 * passed as its own flag rather than as a `model:high` suffix so the pin does
	 * not live inside a string, and so an explicit level always beats whatever
	 * the child would inherit from settings.
	 */
	thinkingLevel?: string;
	/**
	 * run the child's bash tool under the read-only policy (lib/read-only-bash.ts).
	 *
	 * removing a sub-agent's mutation tools is only half a constraint — bash can
	 * write. this closes the other half, in the child's own process, rather than
	 * asking the prompt nicely.
	 */
	readOnlyBash?: boolean;
	/**
	 * tools the sub-agent may use. `builtinTools` and `extensionTools` are
	 * MERGED into a single native `--tools` allowlist (pi 0.82+ gates built-in,
	 * extension and custom tools with the same flag), then de-duplicated and
	 * alias-resolved. the split is kept only so call sites stay readable.
	 *
	 * names must match REGISTERED tool names, or go through TOOL_ALIASES.
	 * unknown names are dropped silently by pi.
	 */
	builtinTools?: string[];
	extensionTools?: string[];
	systemPromptBody?: string;
	signal?: AbortSignal;
	onUpdate?: (result: PiSpawnResult) => void;
	sessionId?: string;
	repo?: string;
	/** conversation persistence / continuation. see SpawnSessionConfig. */
	session?: SpawnSessionConfig;
	/**
	 * inject a follow-up user message after the agent's first turn.
	 *
	 * uses pi's RPC mode instead of print mode. the follow-up is queued
	 * eagerly at startup (not delivered until idle), so the agent loop's
	 * getFollowUpMessages() finds it after exploration completes. the
	 * process is killed after the second end_turn.
	 *
	 * primary use case: code_review — agent explores the diff first,
	 * then receives the report format instructions.
	 */
	followUp?: string;
}

// --- helpers ---

/**
 * pi session ids are used verbatim in the session FILENAME, so anything that
 * is not filename-safe would be mangled or could escape the session directory.
 */
function assertSafeSessionId(id: string): void {
	if (!/^[\w.-]{1,128}$/.test(id)) {
		throw new Error(
			`invalid session id ${JSON.stringify(id)}: use only letters, digits, '.', '-' or '_' (max 128 chars)`,
		);
	}
}

/**
 * translate a SpawnSessionConfig into pi CLI flags.
 *
 * `--session-id` both creates and reopens a session, which is exactly the
 * continuation semantics we need. upstream instead hand-writes a linked
 * session header file and passes `--session <file>`; using the native flag
 * means no session-file format for us to keep in sync with pi.
 */
function resolveSessionArgs(session: SpawnSessionConfig | undefined): {
	args: string[];
	meta?: SpawnSessionMeta;
} {
	if (session?.leafId) {
		throw new Error(
			"session.leafId is not supported: pi's CLI cannot target a specific branch leaf, " +
				"and continuing from the wrong leaf would corrupt the child's history",
		);
	}

	// default stays ephemeral: only an explicit opt-in persists a sub-agent.
	if (!session?.persist && !session?.id) return { args: ["--no-session"] };

	const id = session.id ?? `delegate-${randomUUID()}`;
	assertSafeSessionId(id);

	const args = ["--session-id", id];
	if (session.dir) {
		fs.mkdirSync(session.dir, { recursive: true });
		// must come BEFORE resolution of the id, and must be passed on every
		// resume too, or pi looks for the session in the default directory.
		args.unshift("--session-dir", session.dir);
	}
	return { args, meta: { continueId: id, sessionId: id, sessionDir: session.dir } };
}

function writePromptToTempFile(label: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * read an agent prompt .md file, strip frontmatter, return body.
 * looks in ~/.pi/agent/agents/{filename}.
 */
export function readAgentPrompt(filename: string): string {
	const promptPath = path.join(os.homedir(), ".pi", "agent", "agents", filename);
	try {
		const content = fs.readFileSync(promptPath, "utf-8");
		if (content.startsWith("---")) {
			const endIdx = content.indexOf("\n---", 3);
			if (endIdx !== -1) return content.slice(endIdx + 4).trim();
		}
		return content;
	} catch { return ""; }
}

// --- spawn ---

/**
 * Attach a provider prefix to a bare model id so `--model` can never be
 * ambiguous.
 *
 * pi 0.84.0 (#7327) stopped resolving a bare id to "the first catalog entry"
 * and now errors when more than one AUTHENTICATED provider offers that id.
 * With anthropic + cloudflare-ai-gateway + opencode + github-copilot all
 * authenticated here, `claude-sonnet-5` matches four providers and every
 * sub-agent spawn fails before it starts.
 *
 * Already-qualified ids ("anthropic/claude-opus-4-6") are returned untouched,
 * so a caller that knows better always wins.
 */
function qualifyModel(modelId: string, preferredProvider: string): string {
	if (modelId.includes("/")) return modelId;
	const provider = preferredProvider.trim();
	// an empty or nonsense prefix would produce "/model", which resolves to
	// nothing — anthropic is the only provider our designated models live on.
	return `${provider.length > 0 ? provider : "anthropic"}/${modelId}`;
}

export async function piSpawn(config: PiSpawnConfig): Promise<PiSpawnResult> {
	const useRpc = !!config.followUp;
	const routing = resolveSessionArgs(config.session);
	const args: string[] = useRpc
		? ["--mode", "rpc", ...routing.args]
		: ["--mode", "json", "-p", ...routing.args];

	// resolve model: use the tool's designated model when the parent provider
	// is Anthropic (can serve Claude models directly). when the parent is on a
	// non-Anthropic provider (kimi-coding, llama-local, etc), inherit the
	// parent model since Claude subagent models would require separate API access.
	if (config.model) {
		let resolvedModel = config.model;

		if (config.pinModel) {
			// used verbatim. see PiSpawnConfig.pinModel for why inheritance is wrong
			// for this class of sub-agent rather than merely unnecessary.
		} else if (config.parentModel) {
			const parentProvider = config.parentModel.split("/")[0]?.toLowerCase() ?? "";
			const anthropicProviders = ["anthropic"];
			// no provider prefix means the default provider is being used —
			// check if that's anthropic by looking at the model name
			const isClaudeModel = (id: string) =>
				id.includes("claude") || id.startsWith("opus") || id.startsWith("sonnet") || id.startsWith("haiku");
			const parentModelId = config.parentModel.split("/").slice(1).join("/") || config.parentModel;

			const isAnthropicParent = anthropicProviders.includes(parentProvider)
				|| (!parentProvider.includes("/") && isClaudeModel(parentModelId))
				|| (parentProvider === "" && isClaudeModel(parentModelId));

			// when parent is non-Anthropic (kimi-coding, llama-local, etc),
			// inherit parent model so subagents don't need separate Claude API access
			if (!isAnthropicParent) {
				resolvedModel = config.parentModel;
			} else {
				// PROVIDER-QUALIFY the designated model. pi 0.84.0 (#7327) turned a
				// bare model id shared by several AUTHENTICATED providers into a hard
				// error instead of silently taking the first catalog entry — so
				// `--model claude-opus-4-6` now dies with "ambiguous across providers:
				// anthropic/…, cloudflare-ai-gateway/…, opencode/…" and every
				// sub-agent fails to launch. The tool constants stay bare model names;
				// the provider is attached here, at the single seam they all pass
				// through. Prefer the parent's own provider (it is the one proven to
				// serve Claude in this session); fall back to plain anthropic when the
				// parent carries no usable prefix.
				resolvedModel = qualifyModel(resolvedModel, parentProvider);
			}
		} else {
			// no parent context at all — still must not emit a bare, ambiguous id
			resolvedModel = qualifyModel(resolvedModel, "");
		}

		args.push("--model", resolvedModel);
	}

	// explicit level beats the child's inherited default (pi applies --thinking
	// after every other source; see main.js buildSessionOptions).
	if (config.thinkingLevel) {
		args.push("--thinking", config.thinkingLevel);
	}
	// merge builtin + extension tool lists into ONE native --tools allowlist.
	//
	// pi 0.82+ applies --tools to built-in, extension AND custom tools, and it
	// filters the tool REGISTRY itself (agent-session.ts _refreshToolRegistry),
	// so tools that register later cannot leak in. this replaces the previous
	// PI_INCLUDE_TOOLS + tool-harness mechanism, which left the registry
	// unfiltered and let late-registering package tools (notably `mcp`)
	// auto-activate inside sub-agents — that stray `mcp` tool is what made the
	// librarian sub-agent emit fabricated <use_mcp> markup.
	//
	// never emit --no-tools: it empties the registry, so nothing can be
	// re-activated afterwards (verified: yields zero tools).
	//
	// when neither list is provided the child stays unrestricted, which matches
	// the previous behaviour. no caller requests an explicitly empty tool set.
	const requestedTools = resolveAliases([
		...(config.builtinTools ?? []),
		...(config.extensionTools ?? []),
	]);
	if (requestedTools.length > 0) {
		args.push("--tools", requestedTools.join(","));
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	/*
	 * declared OUT here, not in the try below, because `finally` cannot see a
	 * binding scoped to the try block -- and `finally` is the one place that runs
	 * after both of the promise's resolve paths (`close` and `error`), so it is
	 * where the interval has to be cleared for the timer to be unleakable.
	 */
	let watchdog: ReturnType<typeof setInterval> | undefined;
	/** see FORCE_RELEASE_MS. hoisted for the same reason as `watchdog`. */
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;

	const result: PiSpawnResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		// present only when the child was persisted; callers use
		// session.continueId to resume this exact child later.
		...(routing.meta ? { session: routing.meta } : {}),
	};

	try {
		if (config.systemPromptBody?.trim()) {
			const interpolated = interpolatePromptVars(
				config.systemPromptBody, config.cwd, { sessionId: config.sessionId, repo: config.repo },
			);
			const tmp = writePromptToTempFile("subagent", interpolated);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// in print mode, task is a CLI arg. in RPC mode, sent via stdin prompt command.
		if (!useRpc) {
			args.push(`Task: ${config.task}`);
		}

		const spawnEnv: Record<string, string | undefined> = {
			...process.env,
			PI_READ_COMPACT: "1",
			// pi-claude-code-use strips every tool whose name is not a Claude Code
			// "core" name (read/write/edit/bash/grep/glob/skill/task/...) from the
			// Anthropic payload whenever the model is anthropic + OAuth — see its
			// filterAndRemapTools() rule 6, "unknown flat-named tool". that deletes
			// ALL our custom tools from a sub-agent's request: read_github, finder,
			// oracle, librarian, find, ls, format_file, undo_edit, search_sessions...
			//
			// with no tool definitions in the request, Claude falls back to emitting
			// <function_calls> XML as plain TEXT and then fabricates the result. that
			// is precisely why the librarian "answered" with invented build.zig.zon
			// values instead of reading the file.
			//
			// proven with the package's own debug log (PI_CLAUDE_CODE_USE_DEBUG_LOG):
			//   stage=before: ['read_github', 'Read', 'Bash']
			//   stage=after:  ['Read', 'Bash']
			//
			// sub-agents exist to call our custom tools, so we opt out via the
			// package's documented escape hatch. verified: read_github then makes a
			// real tool call and returns the correct minimum_zig_version.
			//
			// only opt out when WE are supplying an explicit --tools allowlist. with
			// no allowlist the child is unrestricted, and disabling the filter too
			// would leave it ungated at both layers (every registered tool, incl.
			// `mcp`, exposed to the model).
			...(requestedTools.length > 0 ? { PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER: "1" } : {}),
			// tell the child which tools it ACTUALLY has, from the same array that
			// becomes `--tools` above. system-prompt.ts reads this and gives the
			// child a prompt naming exactly these tools instead of the parent's
			// full ~40-tool prompt, which is mostly false inside a child.
			// see lib/sub-agent-prompt.ts for the measured failure it prevents.
			...(requestedTools.length > 0
				? { [SUB_AGENT_TOOLS_ENV]: requestedTools.join(",") }
				: {}),
			// the child's own bash tool reads this at construction and both
			// advertises and enforces the read-only policy.
			...(config.readOnlyBash ? { [READ_ONLY_BASH_ENV]: "1" } : {}),
		};

		let wasAborted = false;
		/*
		 * hoisted out of the promise executor so the `finally` below can clear the
		 * interval. the promise has exactly two resolve paths -- `proc.on("close")`
		 * and `proc.on("error")` -- and `finally` runs after either, so one
		 * clearInterval covers both and the timer cannot outlive the spawn.
		 */
		let stalled = false;
		const debugEnabled = !!process.env.PI_SPAWN_DEBUG;
		const debug = (label: string, data?: Record<string, unknown>) => {
			if (!debugEnabled) return;
			const suffix = data ? ` ${JSON.stringify(data)}` : "";
			process.stderr.write(`[pi-spawn] ${label}${suffix}\n`);
		};

		// allow overriding the pi binary (testing / non-PATH installs). bdsqqq's
		// pi-spawn does the same.
		const piBin = process.env.PI_BIN || "pi";

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(piBin, args, {
				cwd: config.cwd, shell: false,
				stdio: [useRpc ? "pipe" : "ignore", "pipe", "pipe"],
				env: spawnEnv,
			});

			// RPC state: track end_turns to know when to kill
			let endTurnCount = 0;

			const stallMs = stallSec() * 1000;
			let lastActivity = Date.now();
			let lastStallTickAt = Date.now();
			/*
			 * set the moment we kill for ANY reason (stall or user abort). the
			 * watchdog then doubles as the release backstop, so no second timer is
			 * needed and `finally`'s single clearInterval still covers everything.
			 */
			let killedAt: number | undefined;
			let released = false;
			/*
			 * arm the release backstop. its own timer rather than a phase of the
			 * watchdog interval: the interval's period scales with the stall window
			 * (30s at the 15m default), so folding the grace into it made the actual
			 * release land anywhere between 10s and 40s after the kill. a dedicated
			 * timer means FORCE_RELEASE_MS means what it says.
			 *
			 * idempotent — several kill paths can fire for one child.
			 */
			const scheduleRelease = () => {
				if (releaseTimer !== undefined) return;
				releaseTimer = setTimeout(() => {
					if (released) return;
					released = true;
					debug("force_release", { afterMs: FORCE_RELEASE_MS });
					resolve(1);
				}, FORCE_RELEASE_MS);
			};
			if (stallMs > 0) {
				watchdog = setInterval(() => {
					const now = Date.now();
					// already killed by this or any other path: the release timer owns
					// what happens next, and re-killing would only queue redundant
					// signals at a process on its way out.
					if (killedAt !== undefined) return;
					const verdict = watchdogVerdict(now, lastStallTickAt, lastActivity, stallMs, SLEEP_JUMP_MS);
					lastStallTickAt = now;
					if (verdict === "slept") { lastActivity = now; return; }
					if (verdict === "wait") return;
					stalled = true;
					killedAt = now;
					debug("kill_stalled", { stallMs });
					scheduleRelease();
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
				}, watchdogTickMs(stallMs, STALL_TICK_MS));
			}

			// send initial prompt via RPC stdin, then immediately queue follow_up.
			// follow_up is queued (not delivered) until the agent is idle, so the
			// agent loop's getFollowUpMessages() will find it after exploration.
			// sending it eagerly avoids a race where the loop exits before a
			// late follow_up arrives through the cross-process stdin/stdout round-trip.
			if (useRpc && proc.stdin) {
				const promptCmd = JSON.stringify({ type: "prompt", message: `Task: ${config.task}` });
				debug("send_prompt");
				proc.stdin.write(promptCmd + "\n");

				if (config.followUp) {
					const followUpCmd = JSON.stringify({ type: "follow_up", message: config.followUp });
					debug("send_follow_up");
					proc.stdin.write(followUpCmd + "\n");
				}
			}

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch { return; }

				// skip RPC protocol responses (acks for prompt/follow_up/abort commands)
				if (event.type === "response") return;

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.model && (msg as any).model) result.model = (msg as any).model;
						if ((msg as any).stopReason) result.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;

						const stopReason = (msg as any).stopReason as string | undefined;
						const isTurnEnd = stopReason === "end_turn" || stopReason === "stop";
						const expectedTurns = config.followUp ? 2 : 1;
						debug("turn_end", { stopReason, isTurnEnd, endTurnCount, expectedTurns });

						// RPC kill logic: terminate after expected number of end_turns.
						// follow_up was already queued eagerly at startup, so we just
						// count turns and kill when done.
						if (useRpc && isTurnEnd) {
							endTurnCount++;
							if (endTurnCount >= expectedTurns) {
								debug("kill_after_turn", { endTurnCount });
								// same release grace as every other kill: a child that
								// finished normally must not hang on a stuck pipe.
								killedAt ??= Date.now();
								scheduleRelease();
								proc.kill("SIGTERM");
								setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
							}
						}

						// RPC: if agent errors, terminate immediately
						if (useRpc && (stopReason === "error" || stopReason === "aborted")) {
							debug("kill_after_error", { stopReason });
							killedAt ??= Date.now();
							scheduleRelease();
							proc.kill("SIGTERM");
							setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
						}
					}

					if (config.onUpdate) config.onUpdate({ ...result });
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					if (config.onUpdate) config.onUpdate({ ...result });
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				if (released) return;
				lastActivity = Date.now();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				if (released) return;
				lastActivity = Date.now();
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				// `released` means the promise already resolved and the caller holds
				// `result`. parsing a trailing line now would mutate an object that has
				// been handed off — the same class as the stale-ctx timer crash this
				// repo has already been bitten by once.
				if (!released && buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (config.signal) {
				const killProc = () => {
					wasAborted = true;
					// release backstop applies to a user abort too: Esc must free the
					// parent even when a grandchild is holding the child's stdout.
					killedAt ??= Date.now();
					scheduleRelease();
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (config.signal.aborted) killProc();
				else config.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
		}
		/*
		 * after `wasAborted`, so a user's Esc is never relabelled as a stall.
		 *
		 * the message says RELAUNCH, never resume, and that is not hedging: pi
		 * restores a session verbatim (sdk.js) and its only trailing-assistant trim
		 * is gated on stopReason "error"/"length", NOT "toolUse" (agent-session.js).
		 * a child killed mid-tool-call therefore leaves a `tool_use` block with no
		 * matching `tool_result`, and replaying that history is a 400 from the
		 * provider. there is no repair logic anywhere in pi. telling the model to
		 * resume would be telling it to do something that cannot work.
		 */
		if (stalled) {
			result.exitCode = 1;
			result.stopReason = "stalled";
			result.errorMessage =
				`sub-agent killed: no output for ${Math.round(stallSec() / 60)}m. ` +
				"Launch a fresh one for the remaining work — this child cannot be resumed.";
		}
		// RPC processes are killed intentionally — don't treat SIGTERM exit as error
		if (useRpc && result.exitCode !== 0 && (result.stopReason === "end_turn" || result.stopReason === "stop")) {
			result.exitCode = 0;
		}
		return result;
	} finally {
		if (watchdog) clearInterval(watchdog);
		if (releaseTimer) clearTimeout(releaseTimer);
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
