/**
 * bash tool — replaces pi's built-in with enhanced command execution.
 *
 * differences from pi's built-in:
 * - `cmd` + `cwd` params (model-compatible interface, not pi's `command`)
 * - auto-splits `cd dir && cmd` into cwd + command (fallback for models)
 * - strips trailing `&` (prevents background processes)
 * - git commit trailer injection (session ID)
 * - git lock serialization via withFileLock (prevents concurrent git ops)
 * - SIGTERM → SIGKILL fallback on cancel/timeout (pi goes straight to SIGKILL)
 * - output truncation with head + tail (first/last N lines, not just tail)
 * - constant memory via OutputBuffer (no unbounded string growth)
 * - permission rules from ~/.pi/agent/permissions.json (allow/reject)
 * - streaming render: compact tail preview (5 lines) with elapsed time,
 *   reuses component via context.lastComponent to prevent clearOnShrink thrashing
 * - final render: box format with proper expanded/collapsed via closure capture
 *   (TUI calls render(width), not render(width, expanded))
 *
 * shadows pi's built-in `bash` tool via same-name registration.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { formatBoxesWindowed, normalizeForDisplay, type BoxSection, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { evaluateReadOnlyCommand, isReadOnlyBash, readOnlyRefusal } from "./lib/read-only-bash";
import { resolveToAbsolute } from "./read";
import { OutputBuffer } from "./lib/output-buffer";
import { loadSecrets } from "./lib/psst";
import { watchdogTickMs, watchdogVerdict } from "./lib/watchdog";
import { sampleGroupCpuSeconds } from "./lib/proc-cpu";

const HEAD_LINES = 50;
const TAIL_LINES = 50;
const SIGKILL_DELAY_MS = 3000;
const STREAM_UPDATE_INTERVAL_MS = 150;

// --- time bounds ---

/*
 * WHY EVERY COMMAND IS BOUNDED, AND WHY SILENCE IS THE TRIGGER
 *
 * measured, 18,681 bash calls across 325 sub-agent sessions: 87.6% finish in
 * under 5s, 0.20% exceed 300s, and 0.064% exceed 600s. one call ran for
 * 8,555 SECONDS -- 2h22m -- inside a delegate that ran unattended overnight.
 *
 * that call was not slow. it was dead. the test suite it ran finished in
 * milliseconds and printed its complete summary; vitest then failed to exit
 * because something held the event loop open (a pg pool, an undici agent, a
 * timer). 100% of the useful output existed at t+3s and the remaining 8,552
 * seconds produced nothing and never would. vitest cannot rescue itself here:
 * its own `teardownTimeout` watchdog is armed inside `ctx.exit()`, which the
 * CLI only reaches after `startVitest()` returns -- and `startVitest()` awaits
 * `close()`, so a hang INSIDE close never arms it. upstream's own answer to
 * this class is "wrap it in an external hard timeout". that is us.
 *
 * so there are two bounds, and they measure different things:
 *
 *   1. `timeout` (REQUIRED, 1..MAX) -- the caller declares a wall-clock budget.
 *      required rather than defaulted because a default is a number nobody can
 *      justify, and because an optional-with-hidden-default field is a
 *      contradiction a model cannot resolve from the spec (see delegate.ts's
 *      `prompt` for the same decision and the same reasoning). required fails
 *      CLOSED: there is no path by which a command runs unbounded.
 *
 *   2. IDLE KILL -- kills only a command that is PROVABLY doing nothing:
 *      no output AND no CPU for N seconds, regardless of the declared budget.
 *      this is the layer that matters, because a model that writes
 *      `timeout: 600` on a corpse has satisfied bound 1 and still hangs for ten
 *      minutes. duration is not the defect; being DEAD is.
 *
 * why two signals, not just output. stdout-silence alone is too blunt: a
 * command can do real work while printing nothing -- a silent compile, an
 * upload, or (the case that actually bites) a producer behind `| tail`, where
 * `tail` buffers everything until the command exits so we see zero bytes for
 * the whole run. measured, ΔCPU over a 4s window:
 *
 *      sleep 30              0.00s   quiet   (idle / hung)
 *      yes >/dev/null        4.03s   WORKING (silent to us)
 *      yes | tail -1000000   4.03s   WORKING (the `| tail` shape)
 *      node print-then-hang  0.00s   quiet   (the vitest bug)
 *
 * so CPU across the process group tells alive-but-quiet from dead. the CPU
 * check can only ever mark a command ALIVE -- it never causes a kill -- so if
 * `ps` is missing or a parse fails (sampleGroupCpuSeconds returns undefined)
 * the guard degrades to stdout-only, i.e. exactly the previous behaviour. it
 * is a Pareto improvement: strictly fewer false kills, no new ones. see
 * lib/proc-cpu.ts.
 *
 * the idle timer runs from t=0 rather than arming after first output. that
 * refinement was designed, then killed by measurement: piping through
 * `grep`/`tail` block-buffers everything until the upstream closes (verified:
 * `(echo A; sleep 4; echo B) | grep .` emits BOTH lines at t+4s, not t+0s).
 *
 * residuals, stated rather than hidden -- both bounded by the declared timeout,
 * and NEITHER made worse than the old stdout-only guard:
 *   - 0-CPU remote work (`ssh host 'long-job'`, work runs remotely, local
 *     process just holds a socket): looks idle locally, indistinguishable from
 *     a hung ssh. killed at the idle window unless it prints.
 *   - a busy-LOOP hang (spinning at 100% CPU forever): reads as alive, so the
 *     wall-clock declared timeout catches it, not the idle kill.
 */
const MIN_TIMEOUT_SEC = 1;
const DEFAULT_MAX_TIMEOUT_SEC = 600;
const DEFAULT_IDLE_KILL_SEC = 300;

/**
 * a process group counts as ALIVE for a tick if it consumed CPU at more than
 * this fraction of one core since the last sample. scale-invariant on purpose:
 * threshold = elapsed_seconds * this, so it works identically at a 10s
 * production tick and a sub-second test tick. 5% of a core clears real work
 * (compiles, uploads, `yes` all peg or near-peg a core) while ignoring the
 * millisecond-scale CPU a silent poll loop spends between sleeps.
 */
const CPU_ALIVE_CORE_FRACTION = 0.05;

/**
 * how often the idle watchdog wakes. coarse on purpose: one interval plus a
 * timestamp comparison, rather than clearTimeout/setTimeout on every output
 * chunk (which would be thousands of timer-heap operations on a chatty
 * command). measured cost of an idle interval at this cadence: 0.001% of one
 * core. the real tick is min(this, idle/3) so a short window is still observed
 * promptly.
 */
const IDLE_TICK_MS = 10_000;

/**
 * one tick observing this much wall time means the MACHINE SLEPT, not that the
 * command went quiet -- macOS suspends timers with the lid closed, and on wake a
 * single tick would otherwise see hours of "silence" and kill a healthy process
 * at the exact moment the user is watching. absolute rather than a multiple of
 * the tick: no scheduler delay is a minute, and any real suspend is minutes.
 * the failure direction is deliberate -- a spurious reset grants one more idle
 * window, never a wrong kill.
 */
const SLEEP_JUMP_MS = 60_000;

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.floor(parsed);
}

/**
 * CPU liveness is on unless explicitly disabled. off falls back to the
 * stdout-only idle guard -- useful for a machine without a usable `ps`, or to
 * isolate behaviour in a test.
 */
function cpuLivenessEnabled(): boolean {
	return process.env.PI_BASH_CPU_LIVENESS !== "0";
}

/**
 * ceiling on a declared timeout. read at TOOL CONSTRUCTION because it goes into
 * the schema the model reads, and `piSpawn` sets a child's env before spawn --
 * exactly like `isReadOnlyBash()`.
 */
export function maxTimeoutSec(): number {
	const value = envInt("PI_BASH_MAX_TIMEOUT_SEC", DEFAULT_MAX_TIMEOUT_SEC);
	return Math.max(MIN_TIMEOUT_SEC, value);
}

/**
 * idle window. read per CALL rather than at construction so a test can vary it
 * without rebuilding the tool, and so `0` (disable) can be toggled by an
 * operator debugging a genuinely long silent command.
 */
export function idleKillSec(): number {
	return envInt("PI_BASH_IDLE_KILL_SEC", DEFAULT_IDLE_KILL_SEC);
}

// --- shell config ---

/**
 * pi's getShellConfig() lives in utils/shell.js, not re-exported
 * from the main package. reimplemented here — on macOS (our target)
 * this is always /bin/bash.
 */
function getShell(): { shell: string; args: string[] } {
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: "sh", args: ["-c"] };
}

// --- command preprocessing ---

/**
 * models sometimes emit `cd dir && cmd` despite the system prompt
 * discouraging it. split into cwd + command so the cd takes effect
 * in the spawn call rather than being lost between invocations.
 */
function splitCdCommand(cmd: string): { cwd: string; command: string } | null {
	const match = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s);
	if (!match) return null;
	const dir = match[1] ?? match[2] ?? match[3];
	return { cwd: dir, command: match[4] };
}

function stripBackground(cmd: string): string {
	return cmd.replace(/\s*&\s*$/, "");
}

function isGitCommand(cmd: string): boolean {
	return /\bgit\s+/.test(cmd);
}

/**
 * inject session ID trailer into git commit commands so commits
 * are traceable back to the pi session that authored them.
 * skips if trailers are already present (model added them manually).
 */
function injectGitTrailers(cmd: string, sessionId: string): string {
	if (!/\bgit\s+commit\b/.test(cmd)) return cmd;
	if (/--trailer/.test(cmd)) return cmd;
	return cmd.replace(
		/\bgit\s+commit\b/,
		`git commit --trailer "Session-Id: ${sessionId}"`,
	);
}

// --- process management ---

/**
 * SIGTERM the process group first, escalate to SIGKILL after delay.
 * pi's built-in goes straight to SIGKILL via killProcessTree().
 * graceful fallback so processes can clean up.
 */
function killGracefully(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return;
	}

	setTimeout(() => {
		try {
			process.kill(-pid, 0);
			process.kill(-pid, "SIGKILL");
		} catch {
			// already dead
		}
	}, SIGKILL_DELAY_MS);
}

/** per-block excerpts for collapsed display — head 3 + tail 5 = 8 visual lines */
const COLLAPSED_EXCERPTS: Excerpt[] = [
	{ focus: "head" as const, context: 3 },
	{ focus: "tail" as const, context: 5 },
];

// --- output sanitization ---

/**
 * strip terminal control sequences from tool output for safe TUI rendering.
 *
 * SSH, remote commands, and interactive programs can emit ANSI escape sequences
 * (cursor movement, screen clearing, terminal mode changes) that leak through
 * our rendered output into the TUI's terminal write buffer. these execute as
 * real terminal commands, desynchronizing the TUI's cursor position tracking
 * and causing content to render at wrong positions ("leaking" below the footer).
 *
 * the most destructive are DEC private mode sequences that SSH emits on
 * connection: \x1b[?1049h (alternate screen buffer), \x1b[?25l (hide cursor),
 * \x1b[?2004h (bracketed paste). these contain a '?' prefix that the previous
 * regex [0-9;]* didn't match, so they passed through and executed as real
 * terminal commands. zoom in/out fixed it because SIGWINCH triggers a full
 * TUI redraw.
 *
 * now uses ECMA-48 byte ranges for CSI parameter bytes (0x30-0x3f includes
 * ? > = < : ; digits) so all CSI variants are caught.
 *
 * the built-in BashExecutionComponent (user bash) does this via strip-ansi.
 * we do it inline to avoid the ESM-only strip-ansi dependency.
 */
function sanitizeForDisplay(text: string): string {
	return text
		// CSI sequences (full ECMA-48): \x1b[ + parameter bytes (0x30-0x3f)
		// + intermediate bytes (0x20-0x2f) + final byte (0x40-0x7e).
		// covers SGR colors, cursor movement, DEC private mode (?25h, ?1049h,
		// ?2004h), screen clearing, xterm modifiers (>4;2m), etc.
		.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
		// OSC sequences: \x1b] ... BEL or \x1b] ... ST
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*\x1b\\/g, "")
		// DCS sequences: \x1bP ... ST (\x1b\\ or \x07)
		.replace(/\x1bP[^\x07]*\x07/g, "")
		.replace(/\x1bP[^\x1b]*\x1b\\/g, "")
		// APC/PM/SOS sequences: \x1b_ / \x1b^ / \x1bX ... ST
		.replace(/\x1b[_^X][^\x1b]*\x1b\\/g, "")
		.replace(/\x1b[_^X][^\x07]*\x07/g, "")
		// charset selection, cursor save/restore, keypad modes
		.replace(/\x1b[()][0-9A-B]/g, "")
		.replace(/\x1b[78=>]/g, "")
		// normalize line endings (SSH sends \r\n; raw \r overwrites line start)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		// strip remaining control chars (except \n newline and \t tab)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function hasCompleteEscapeSequence(text: string): boolean {
	return /^(?:\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1bP[^\x07]*(?:\x07|\x1b\\)|\x1b[_^X][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[78=>])/.test(text);
}

function splitIncompleteEscape(text: string): { display: string; carry: string } {
	const lastEsc = text.lastIndexOf("\x1b");
	if (lastEsc === -1) return { display: text, carry: "" };

	const suffix = text.slice(lastEsc);
	if (hasCompleteEscapeSequence(suffix) || suffix.length > 1024) {
		return { display: text, carry: "" };
	}

	return { display: text.slice(0, lastEsc), carry: suffix };
}

// --- tool factory ---

export function createBashTool(): ToolDefinition {
	/*
	 * a read-only session must SAY so in the description, not only refuse at
	 * call time. the tool spec is what the model plans against — learning the
	 * constraint from a rejection costs a turn, and a model that discovers a
	 * refusal tends to try a second spelling of the same write.
	 *
	 * read at construction because piSpawn sets the env var for the whole child
	 * process; it never changes mid-session.
	 */
	const readOnly = isReadOnlyBash();
	/*
	 * ceiling is fixed for the life of the tool: it goes into the schema the
	 * model plans against, so it must not vary between the description it reads
	 * and the validator that judges the call.
	 */
	const maxTimeout = maxTimeoutSec();
	/*
	 * captured ONCE, for the same reason as `maxTimeout`: this number appears in
	 * the description the model reads AND governs the kill, and the two must not
	 * be able to disagree. it is threaded into `runCommand` rather than re-read
	 * there, so there is exactly one source for both.
	 */
	const idleSec = idleKillSec();
	/*
	 * the escape hatch for legitimately-silent work. teaches the agent, UP FRONT,
	 * that a quiet command can be stopped and how to opt out -- so it does not
	 * have to learn this from a kill. the remote-deploy case is named explicitly
	 * because that is the one the CPU signal cannot cover: the work (and the CPU)
	 * is on the server, so a local `ssh`/`push` that hides its output looks
	 * exactly like a hang.
	 */
	const idleNote = idleSec > 0
		? `\n- A command that produces NO output AND uses NO CPU for ${idleSec}s is stopped — ` +
			"a hung process looks exactly like this. Real work is either printing or burning CPU, " +
			"so normal commands are safe. But if a command is MEANT to be quiet for a while " +
			"(a deploy pushing to a remote server over ssh, a slow silent build — the work is on " +
			"the OTHER machine, so this machine sees no output and no CPU), pass `may_run_silent: true` " +
			"and ONLY your `timeout` will bound it."
		: "";
	const readOnlyNote = readOnly
		? "\n\nREAD-ONLY SESSION. Only read-only commands run here. No redirection to a file " +
			"(`>`, `>>`; `>/dev/null` and `2>&1` are fine), no rm/mv/cp/mkdir/touch/chmod, no " +
			"`sed -i`, no `find -exec`, no interpreters (`node -e`, `python3 -c`), no installs, " +
			"and only git's read subcommands (log, show, diff, status, blame, ls-files, rev-parse, " +
			"grep, ...). Anything else is refused. Report the command you wanted instead of " +
			"looking for another way to run it."
		: "";

	return {
		name: "bash",
		label: "Bash",
		description:
			"Executes the given shell command using bash.\n\n" +
			"- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead\n" +
			"- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
			`- Output shows first ${HEAD_LINES} and last ${TAIL_LINES} lines; middle is truncated for large outputs\n` +
			"- Do NOT pipe to `tail`/`head`/`grep` just to shorten output — this tool already truncates. " +
			"Piping buffers everything until the command ends, which hides progress and makes a working command look hung\n" +
			"- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
			"- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
			"- ALWAYS quote file paths: `cat \"path with spaces/file.txt\"`\n" +
			"- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
			"- Only run `git commit` and `git push` if explicitly instructed by the user." +
			idleNote +
			readOnlyNote,

		parameters: Type.Object({
			cmd: Type.Optional(Type.String({
				description: "The shell command to execute.",
			})),
			command: Type.Optional(Type.String({
				description: "The shell command to execute (alias for cmd).",
			})),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the command (absolute path). Defaults to workspace root.",
				}),
			),
			/*
			 * the per-command way to say "I expect this to be quiet, be patient".
			 * disables the idle kill for this command so ONLY the wall-clock timeout
			 * bounds it -- the honest signal for legitimately-silent work (a remote
			 * deploy, a quiet build) that the CPU liveness check cannot see because
			 * the work is on another machine. optional, so it never affects the
			 * "timeout is the only required property" contract.
			 */
			may_run_silent: Type.Optional(
				Type.Boolean({
					description:
						"Set true for a command you EXPECT to be silent for a long time — a deploy " +
						"pushing to a remote server over ssh, or a quiet build where the work happens " +
						"elsewhere. Then ONLY your `timeout` bounds it and it will NOT be stopped for " +
						`producing no output. Leave unset for normal commands (stopped if silent AND ` +
						`using no CPU for ${idleSec}s, which means the process has hung).`,
				}),
			),
			/*
			 * REQUIRED, and bounded by the schema rather than clamped at runtime.
			 *
			 * pi validates arguments before execute() (agent-loop.js prepareToolCall
			 * -> validateToolArguments), and a failure comes back as an ordinary
			 * isError tool result that the loop carries on from -- so a missing or
			 * out-of-range timeout costs one turn and self-corrects, it does not
			 * abort anything. bounds live here so `timeout: 0` and `timeout: 99999`
			 * become messages the model can learn from instead of silent clamps.
			 *
			 * TypeBox `default` is deliberately NOT used: pi fills no defaults
			 * (Value.Convert coerces types only), so a default here would be
			 * decorative and the field would still arrive undefined.
			 */
			timeout: Type.Number({
				minimum: MIN_TIMEOUT_SEC,
				maximum: maxTimeout,
				description:
					`Required. Max seconds this command may run (${MIN_TIMEOUT_SEC}-${maxTimeout}). ` +
					"read/grep/git status 10 · typecheck/lint/unit tests 120 · build/install 300 · e2e/deploy 600. " +
					// only claim the idle kill when it is actually armed: with it
					// disabled this read "prints NOTHING for 0s is killed", which is
					// both false and unparseable.
					(idleSec > 0
						? `A command that prints NOTHING for ${idleSec}s is killed regardless of this value, ` +
							"UNLESS you pass may_run_silent:true (for a command you expect to be quiet, " +
							"like a remote deploy). "
						: "") +
					`If it needs more than ${maxTimeout}s, split it or run it outside the agent.`,
			}),
		}, {
			// at least one of cmd/command must be present
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			// reuse component to prevent render churn — same object every call
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const cmd = args.cmd || args.command || "...";
			const timeout = args.timeout;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			// show first line only for multiline commands
			// normalizeForDisplay: commands can contain graphemes whose terminal
			// width disagrees with pi-tui's measure — same desync class as output
			const lines = cmd.split("\n");
			const firstLine = normalizeForDisplay(lines[0]);
			const multiSuffix = lines.length > 1 ? theme.fg("muted", " …") : "";
			text.setText(
				theme.fg("toolTitle", theme.bold(`$ ${firstLine}`)) + multiSuffix + timeoutSuffix,
			);
			return text;
		},

		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
			const Text = getText();

			const Container = getContainer();

			// REUSE: same container every call for final expanded/collapsed rerenders
			const container = context?.lastComponent ?? new Container();
			container.clear();

			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text(theme.fg("dim", "(no output)"), 0, 0));
				return container;
			}

			// strip `$ command\n\n` prefix — renderCall already shows it
			let text: string = content.text;
			if (text.startsWith("$ ")) {
				const sep = text.indexOf("\n\n");
				if (sep !== -1) {
					text = text.slice(sep + 2);
				}
			}

			// safety net: sanitize again in case any sequences survived handleData
			text = sanitizeForDisplay(text);

			if (!text || text === "(no output)") {
				container.addChild(new Text(theme.fg("dim", "(no output)"), 0, 0));
				return container;
			}

			// --- elapsed time tracking via persistent context.state ---
			const state = context?.state ?? {};
			if (context?.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
			}
			state.endedAt ??= Date.now();

			// --- FINAL: box format with proper expanded state ---
			const { expanded } = options;
			const outputLines = text.split("\n");

			const buildSections = (): BoxSection[] => [{
				blocks: [{ lines: outputLines.map((l) => ({ text: theme.fg("toolOutput", l), highlight: true })) }],
			}];

			let notices: string[] | undefined;
			if (state.startedAt && state.endedAt) {
				const elapsed = ((state.endedAt - state.startedAt) / 1000).toFixed(1);
				notices = [`took ${elapsed}s`];
			}

			// capture expanded in closure
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			container.addChild({
				render(width: number): string[] {
					if (cachedLines !== undefined && cachedWidth === width) {
						return cachedLines;
					}
					const sections = buildSections();
					const visual = formatBoxesWindowed(
						sections,
						expanded ? {} : { excerpts: COLLAPSED_EXCERPTS },
						notices,
						width,
					);
					cachedLines = visual.split("\n");
					cachedWidth = width;
					return cachedLines;
				},
				invalidate() {
					cachedLines = undefined;
					cachedWidth = undefined;
				},
			});

			return container;
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			/*
			 * well-formedness before semantics: a call missing its budget is not a
			 * command yet, so it is rejected before the permission engine, the
			 * secret vault, or anything that costs work.
			 *
			 * the schema already enforces this for every provider that honours it
			 * (validation runs before execute()); this is the net for the ones that
			 * do not. `Value.Convert` coerces a numeric string, so a model sending
			 * "120" has already become 120 by the time we look.
			 */
			const timeoutSec = params.timeout;
			if (
				typeof timeoutSec !== "number" ||
				!Number.isFinite(timeoutSec) ||
				timeoutSec < MIN_TIMEOUT_SEC ||
				timeoutSec > maxTimeout
			) {
				return {
					content: [{
						type: "text" as const,
						text:
							`timeout required: seconds, ${MIN_TIMEOUT_SEC}-${maxTimeout}. ` +
							"read 10 · test 120 · build 300 · e2e 600.",
					}],
					isError: true,
				} as any;
			}

			// accept both `cmd` (our schema) and `command` (pi default / Claude convention)
			let command = stripBackground(params.cmd ?? params.command);
			let effectiveCwd = params.cwd
				? resolveToAbsolute(params.cwd, ctx.cwd)
				: ctx.cwd;

			const cdSplit = splitCdCommand(command);
			if (cdSplit) {
				effectiveCwd = resolveToAbsolute(cdSplit.cwd, effectiveCwd);
				command = cdSplit.command;
			}

			if (!existsSync(effectiveCwd)) {
				return {
					content: [{ type: "text" as const, text: `working directory does not exist: ${effectiveCwd}` }],
					isError: true,
				} as any;
			}

			/*
			 * read-only gate first, so its message is the one a research sub-agent
			 * reads. it is checked AFTER the `cd x && cmd` split above, so the guard
			 * sees the command that will actually run rather than the wrapper.
			 */
			if (readOnly) {
				const readOnlyVerdict = evaluateReadOnlyCommand(command);
				if (!readOnlyVerdict.allowed) {
					return {
						content: [
							{ type: "text" as const, text: readOnlyRefusal(readOnlyVerdict.reason, command) },
						],
						isError: true,
					} as any;
				}
			}

			const verdict = evaluatePermission("Bash", { cmd: command }, loadPermissions());
			if (verdict.action === "reject") {
				const msg = verdict.message
					? `command rejected: ${verdict.message}`
					: `command rejected by permission rule. command: ${command}`;
				return {
					content: [{ type: "text" as const, text: msg }],
					isError: true,
				} as any;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			command = injectGitTrailers(command, sessionId);

			// inject psst vault secrets into subprocess environment
			const secrets = await loadSecrets();
			const secretEnv: Record<string, string> = {};
			for (const secret of secrets) {
				secretEnv[secret.name] = secret.value;
			}

			// may_run_silent opts a command out of the idle kill: the agent is
			// declaring it EXPECTS no output for a while (a remote deploy, a quiet
			// build). only the wall-clock timeout then bounds it. accept a couple of
			// spellings a model might reach for.
			const mayRunSilent =
				params.may_run_silent === true ||
				params.mayRunSilent === true ||
				params.expect_silent === true;
			const effectiveIdleSec = mayRunSilent ? 0 : idleSec;
			const run = () => runCommand(command, effectiveCwd, timeoutSec, effectiveIdleSec, signal, onUpdate, secretEnv);

			if (isGitCommand(command)) {
				const gitLockKey = path.join(effectiveCwd, ".git", "__pi_git_lock__");
				return withFileLock(gitLockKey, run);
			}

			return run();
		},
	};
}

// --- execution ---

async function runCommand(
	command: string,
	cwd: string,
	timeout: number,
	idleSec: number,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
	secretEnv: Record<string, string> = {},
): Promise<any> {
	const { shell, args } = getShell();

	// merge secrets into process env — values available as $NAME in commands
	const env = { ...process.env, ...secretEnv };

	return new Promise((resolve) => {
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const output = new OutputBuffer(HEAD_LINES, TAIL_LINES);
		let timedOut = false;
		let idledOut = false;
		let aborted = false;
		let controlCarry = "";
		let lastUpdateAt = 0;
		let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
		// per-stream decoders: Buffer.toString("utf-8") on a chunk that splits a
		// multibyte character mid-sequence produces permanent U+FFFD corruption.
		// StringDecoder carries the partial sequence to the next chunk.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (timeout && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killGracefully(child.pid);
			}, timeout * 1000);
		}

		/*
		 * IDLE WATCHDOG -- kills a command that has stopped producing output,
		 * whatever wall-clock budget was declared. see the rationale block at the
		 * top of this file: this is the layer that bounds a corpse whose caller
		 * asked for ten minutes of patience.
		 *
		 * `lastOutputAt` is stamped on RAW chunk arrival (see handleData), not on
		 * displayable text, so a command emitting only control sequences -- a
		 * progress bar redrawing one line -- counts as alive and is bounded by the
		 * wall clock instead. false-positive direction, on purpose.
		 *
		 * `lastOutputAt` is ALSO bumped when the process group's CPU advances (see
		 * the CPU block below), so a command doing real work while printing nothing
		 * -- a silent compile, or a producer behind `| tail` -- counts as alive
		 * too. output and CPU are OR'd; the kill fires only when BOTH are quiet.
		 */
		const idleMs = idleSec * 1000;
		let lastOutputAt = Date.now();
		let lastIdleTickAt = Date.now();
		// CPU liveness state. `child.pid` is the process-GROUP id because the child
		// is spawned `detached` (the same fact `killGracefully(-pid)` relies on).
		const cpuOn = cpuLivenessEnabled() && idleMs > 0;
		let lastCpuSecs = cpuOn && child.pid ? sampleGroupCpuSeconds(child.pid) : undefined;
		let lastCpuSampleAt = Date.now();
		let idleHandle: ReturnType<typeof setInterval> | undefined;
		if (idleMs > 0) {
			idleHandle = setInterval(() => {
				// one kill only. after the first tick fires, `lastOutputAt` can never
				// advance again (the process is dying and producing nothing), so every
				// later tick would re-issue SIGTERM and queue another 3s SIGKILL timer
				// against a process that is already on its way out.
				if (idledOut) return;
				const now = Date.now();
				/*
				 * CPU liveness, first: a command burning CPU is alive even if it has
				 * printed nothing. this can only ever bump `lastOutputAt` (keep the
				 * command running); it never kills. a sample of `undefined` (ps
				 * failed, or the group is gone) is treated as no signal -- the guard
				 * falls back to output-only, exactly the old behaviour.
				 */
				if (cpuOn && child.pid) {
					const cpuNow = sampleGroupCpuSeconds(child.pid);
					// only advance the sample state on a REAL reading: a failed `ps`
					// (undefined) leaves last{CpuSecs,SampleAt} untouched, so the next
					// success measures the true rate across the gap rather than a
					// short interval against a stale baseline.
					if (cpuNow !== undefined) {
						if (lastCpuSecs !== undefined) {
							const elapsedSec = (now - lastCpuSampleAt) / 1000;
							// threshold scales with elapsed wall time, so it is identical at
							// a 10s production tick and a sub-second test tick. abs(): a
							// child exiting drops the group total, and that drop is activity
							// too. this only ever BUMPS lastOutputAt (keeps the command
							// alive) — it can never cause a kill.
							const threshold = Math.max(elapsedSec, 0) * CPU_ALIVE_CORE_FRACTION;
							if (Math.abs(cpuNow - lastCpuSecs) > threshold) lastOutputAt = now;
						}
						lastCpuSecs = cpuNow;
						lastCpuSampleAt = now;
					}
				}
				const verdict = watchdogVerdict(now, lastIdleTickAt, lastOutputAt, idleMs, SLEEP_JUMP_MS);
				lastIdleTickAt = now;
				// machine slept: forgive the gap rather than kill a process that was
				// frozen along with everything else.
				if (verdict === "slept") { lastOutputAt = now; return; }
				if (verdict === "wait") return;
				idledOut = true;
				if (child.pid) killGracefully(child.pid);
			}, watchdogTickMs(idleMs, IDLE_TICK_MS));
		}

		const onAbort = () => {
			aborted = true;
			if (child.pid) killGracefully(child.pid);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const sendUpdate = () => {
			pendingUpdate = undefined;
			lastUpdateAt = Date.now();
			const { text } = output.preview();
			onUpdate?.({ content: [{ type: "text", text }] });
		};

		const scheduleUpdate = () => {
			if (!onUpdate || pendingUpdate) return;
			const elapsed = Date.now() - lastUpdateAt;
			if (elapsed >= STREAM_UPDATE_INTERVAL_MS) {
				sendUpdate();
				return;
			}
			pendingUpdate = setTimeout(sendUpdate, STREAM_UPDATE_INTERVAL_MS - elapsed);
		};

		const handleData = (decoder: StringDecoder) => (data: Buffer) => {
			// liveness is stamped on RAW arrival, before sanitization: bytes that
			// sanitize to nothing (a redrawing progress bar) still prove the process
			// is running. counting only displayable text would kill it.
			lastOutputAt = Date.now();
			// sanitize at source — strip terminal control sequences before they
			// enter the buffer or reach onUpdate. prevents escape sequences from
			// ever flowing through the TUI pipeline (even briefly via onUpdate).
			// keep incomplete escape sequences across chunks so high-volume SSH
			// output cannot leak a split CSI/OSC sequence as printable garbage.
			const raw = controlCarry + decoder.write(data);
			const { display, carry } = splitIncompleteEscape(raw);
			controlCarry = carry;
			const sanitized = sanitizeForDisplay(display);
			if (sanitized) output.add(sanitized);
			scheduleUpdate();
		};

		child.stdout?.on("data", handleData(stdoutDecoder));
		child.stderr?.on("data", handleData(stderrDecoder));

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (idleHandle) clearInterval(idleHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				content: [{ type: "text" as const, text: `command error: ${err.message}` }],
				isError: true,
			} as any);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (idleHandle) clearInterval(idleHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);

			const finalCarry = sanitizeForDisplay(controlCarry + stdoutDecoder.end() + stderrDecoder.end());
			if (finalCarry) output.add(finalCarry);
			controlCarry = "";
			const { text: outputText } = output.format();

			if (aborted) {
				const text = outputText ? `${outputText}\n\ncommand aborted` : "command aborted";
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			/*
			 * before the wall-clock branch: the two are mutually exclusive in
			 * practice (idle fires only after `idleSec` of silence, the wall clock
			 * only at the declared budget), but if a kill raced them the idle
			 * diagnosis is the more useful one -- it tells the caller the output
			 * above is complete, which "timed out" does not.
			 */
			if (idledOut) {
				const text =
					`${outputText || "(no output)"}\n\n` +
					`killed: no output and no CPU activity for ${idleSec}s — the process was doing ` +
					"nothing on this machine. Output above is everything it printed. A process that " +
					"finishes its work and fails to exit looks exactly like this — check the output " +
					"first; it may be complete. If this command was LEGITIMATELY quiet (a deploy or " +
					"build whose work runs on a remote server, so this machine sees no output and no " +
					"CPU), re-run it with may_run_silent: true — a longer timeout will NOT help, the " +
					"idle check ignores it.";
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			if (timedOut) {
				const notice =
					`command timed out after ${timeout} seconds (your declared timeout). ` +
					`Raise it, up to ${maxTimeoutSec()}s, if the command legitimately needs longer.`;
				const text = outputText ? `${outputText}\n\n${notice}` : notice;
				resolve({
					content: [{ type: "text" as const, text }],
					isError: true,
				} as any);
				return;
			}

			// format result with command header
			let result = `$ ${command}\n\n${outputText || "(no output)"}`;

			if (code !== 0 && code !== null) {
				result += `\n\nexit code ${code}`;
				resolve({
					content: [{ type: "text" as const, text: result }],
					isError: true,
					details: { command },
				} as any);
			} else {
				resolve({
					content: [{ type: "text" as const, text: result }],
					details: { command },
				} as any);
			}
		});
	});
}
