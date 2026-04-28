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
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { formatBoxesWindowed, type BoxSection, type Excerpt } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { Type } from "@sinclair/typebox";
import { withFileLock } from "./lib/mutex";
import { evaluatePermission, loadPermissions } from "./lib/permissions";
import { resolveToAbsolute } from "./read";
import { OutputBuffer } from "./lib/output-buffer";
import { loadSecrets } from "./lib/psst";

const HEAD_LINES = 50;
const TAIL_LINES = 50;
const SIGKILL_DELAY_MS = 3000;
const STREAM_UPDATE_INTERVAL_MS = 150;

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
	return {
		name: "bash",
		label: "Bash",
		description:
			"Executes the given shell command using bash.\n\n" +
			"- Do NOT chain commands with `;` or `&&` or use `&` for background processes; make separate tool calls instead\n" +
			"- Do NOT use interactive commands (REPLs, editors, password prompts)\n" +
			`- Output shows first ${HEAD_LINES} and last ${TAIL_LINES} lines; middle is truncated for large outputs\n` +
			"- Environment variables and `cd` do not persist between commands; use the `cwd` parameter instead\n" +
			"- Commands run in the workspace root by default; only use `cwd` when you need a different directory\n" +
			"- ALWAYS quote file paths: `cat \"path with spaces/file.txt\"`\n" +
			"- Use the Grep tool instead of grep, the Read tool instead of cat\n" +
			"- Only run `git commit` and `git push` if explicitly instructed by the user.",

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
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds.",
				}),
			),
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
			const lines = cmd.split("\n");
			const firstLine = lines[0];
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

			const run = () => runCommand(command, effectiveCwd, params.timeout, signal, onUpdate, secretEnv);

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
	timeout: number | undefined,
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
		let aborted = false;
		let controlCarry = "";
		let lastUpdateAt = 0;
		let pendingUpdate: ReturnType<typeof setTimeout> | undefined;

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		if (timeout && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killGracefully(child.pid);
			}, timeout * 1000);
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

		const handleData = (data: Buffer) => {
			// sanitize at source — strip terminal control sequences before they
			// enter the buffer or reach onUpdate. prevents escape sequences from
			// ever flowing through the TUI pipeline (even briefly via onUpdate).
			// keep incomplete escape sequences across chunks so high-volume SSH
			// output cannot leak a split CSI/OSC sequence as printable garbage.
			const raw = controlCarry + data.toString("utf-8");
			const { display, carry } = splitIncompleteEscape(raw);
			controlCarry = carry;
			const sanitized = sanitizeForDisplay(display);
			if (sanitized) output.add(sanitized);
			scheduleUpdate();
		};

		child.stdout?.on("data", handleData);
		child.stderr?.on("data", handleData);

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				content: [{ type: "text" as const, text: `command error: ${err.message}` }],
				isError: true,
			} as any);
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (pendingUpdate) clearTimeout(pendingUpdate);
			signal?.removeEventListener("abort", onAbort);

			const finalCarry = sanitizeForDisplay(controlCarry);
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

			if (timedOut) {
				const text = outputText
					? `${outputText}\n\ncommand timed out after ${timeout} seconds`
					: `command timed out after ${timeout} seconds`;
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
