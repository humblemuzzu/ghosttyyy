/**
 * you-should-know — a side agent that watches your back while you work.
 *
 * The side call ALWAYS runs on deepseek-flash, whatever the session is on. That
 * is a cost decision: DeepSeek caches a matching prefix automatically and bills
 * it at 1/50th of input, so repeating a conversation-sized prompt costs a
 * fraction of a cent — but only while every check has the same shape.
 *
 * Nothing here touches the main conversation, and nothing polls: every check is
 * driven by turn_end. The pure half lives in ./logic.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Text, type KeybindingsManager, type TUI } from "@mariozechner/pi-tui";
import type { Message } from "@mariozechner/pi-ai";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CHECK_EVERY_TURNS,
	FREE_IGNORES,
	MAX_NOTES,
	SUB_AGENT_REPORTS,
	REQUEST_TIMEOUT_MS,
	collectSubAgentReports,
	emptyState,
	flatten,
	nextSkip,
	normalizeLine,
	parseNote,
	pushCapped,
	renderPrompt,
	textOf,
	type Note,
	type State,
} from "./logic";

const SIDE_PROVIDER = "deepseek";
const SIDE_MODEL_ID = "deepseek-flash";
const WIDGET_KEY = "you-should-know";
const COMMAND = "ysk";
const SHORTCUT = "ctrl+shift+y";

const STATE_DIR = join(homedir(), ".pi", "agent", "you-should-know");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOG_FILE = join(STATE_DIR, "checks.jsonl");
const PROMPT_FILENAME = "detect-prompt.md";

function loadState(): State {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
		const base = emptyState();
		const strings = (value: unknown) =>
			Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined;
		const number = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
		return {
			// Absent means the default, which is off — not "on unless explicitly disabled".
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
			seen: strings(raw.seen) ?? base.seen,
			known: strings(raw.known) ?? base.known,
			ignoredInARow: number(raw.ignoredInARow, 0),
			skip: number(raw.skip, 0),
			checks: number(raw.checks, 0),
			shown: number(raw.shown, 0),
		};
	} catch {
		return emptyState();
	}
}

function saveState(state: State): void {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// a state file we cannot write costs us dedup, not correctness
	}
}

function logCheck(entry: Record<string, unknown>): void {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
	} catch {
		// logging is never worth an error
	}
}

/**
 * Fail closed: a missing prompt would send an empty question and come back with
 * a confident, useless note. If it cannot be read, checks stay off and the
 * reason is reported once.
 */
function loadTemplate(): string {
	const candidates: string[] = [];
	try {
		candidates.push(fileURLToPath(new URL("./detect-prompt.md", import.meta.url)));
	} catch {
		// import.meta.url unavailable — fall back to the deployed location
	}
	candidates.push(join(homedir(), ".pi", "agent", "extensions", "you-should-know", PROMPT_FILENAME));
	for (const path of candidates) {
		try {
			const text = readFileSync(path, "utf8");
			if (text.trim().length > 0) return text;
		} catch {
			// try the next candidate
		}
	}
	return "";
}

class ExplanationView extends Container {
	private closed = false;
	private finish: (result: undefined) => void;

	constructor(body: string, finish: (result: undefined) => void, theme: Theme, heading: string) {
		super();
		this.finish = finish;
		this.addChild(new Text(theme.fg("dim", heading), 0, 0));
		this.addChild(new Text("", 0, 0));
		this.addChild(
			new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }),
		);
		this.addChild(new Text("", 0, 0));
		this.addChild(new Text(theme.fg("dim", "enter or esc to close"), 0, 0));
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === "\x1b" || data === "\r" || data === "\n" || data === "q" || data === "0") {
			this.closed = true;
			this.finish(undefined);
		}
	}
}

export default function (pi: ExtensionAPI) {
	let state = emptyState();
	let notes: Note[] = [];
	let template = "";
	let disabledReason: string | undefined;
	let turnsSinceCheck = 0;
	let promptCounter = 0;
	let inFlight: AbortController | undefined;
	/** the main conversation as the provider saw it, reused as the explain prefix */
	let llmMessages: Message[] = [];

	const pickModel = (ctx: ExtensionContext) => ctx.modelRegistry.find(SIDE_PROVIDER, SIDE_MODEL_ID);

	const render = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (notes.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => {
				const container = new Container();
				for (const [index, note] of notes.entries()) {
					const first = index === 0;
					const marker = first ? theme.fg("accent", "✦ ") : theme.fg("dim", "✧ ");
					const tag = first ? theme.fg("accent", theme.bold(note.tag)) : theme.fg("dim", note.tag);
					container.addChild(new Text(`${marker}${tag}${theme.fg("dim", " · ")}${flatten(note.line)}`, 0, 0));
				}
				return container;
			},
			{ placement: "aboveEditor" },
		);
	};

	/** Any answer to a note resets the backoff: a note the user acted on is not a nag. */
	const dropNote = (ctx: ExtensionContext, target: Note): void => {
		const index = notes.indexOf(target);
		if (index === -1) return;
		notes.splice(index, 1);
		state.ignoredInARow = 0;
		state.skip = 0;
		saveState(state);
		render(ctx);
	};

	/** Reuses the conversation prefix, so this second call is mostly a cache read. */
	const explain = async (ctx: ExtensionContext, note: Note, signal: AbortSignal): Promise<string> => {
		if (note.explain) return note.explain;
		const model = pickModel(ctx);
		if (!model) throw new Error("side model unavailable");
		const body = [
			"A side agent already showed this one-line note to the person you work for:",
			`"${note.line}"`,
			"",
			"Answer straight away: do not think it over first, do not call any tool.",
			"Write the explanation that note was pointing at, for someone with no memory of",
			"the session. Use the format the instructions describe: a short bold title line",
			"stating the takeaway, then a plain-English explainer of at most 120 words.",
			"Output only the explanation.",
		].join("\n");
		const result = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					...llmMessages,
					{ role: "user" as const, content: [{ type: "text" as const, text: body }], timestamp: Date.now() },
				],
			},
			{ signal, sessionId: ctx.sessionManager.getSessionId() },
		);
		return textOf(result) || note.line;
	};

	const showExplanation = async (ctx: ExtensionContext, note: Note): Promise<boolean> => {
		const controller = new AbortController();
		inFlight?.abort();
		inFlight = controller;
		try {
			ctx.ui.notify("One moment…", "info");
			const body = await explain(ctx, note, controller.signal);
			note.explain = body;
			await ctx.ui.custom<undefined>(
				(_tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: undefined) => void) =>
					new ExplanationView(body, done, theme, `${note.tag} · ${flatten(note.line)}`),
				{ overlay: true },
			);
			return true;
		} catch {
			ctx.ui.notify("Could not write that explanation. The note is still there.", "warning");
			return false;
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	};

	const chatInMain = (note: Note): void => {
		const quoted = [note.tag, note.line, note.evidence ? `evidence: ${note.evidence}` : ""]
			.filter(Boolean)
			.flatMap((line) => line.split("\n"))
			.map((line) => `> ${line}`)
			.join("\n");
		pi.sendUserMessage(`A side agent flagged this while you were working:\n\n${quoted}`, { deliverAs: "followUp" });
	};

	const respond = async (ctx: ExtensionContext): Promise<void> => {
		const note = notes[0];
		if (!note) {
			ctx.ui.notify("Nothing to know right now.", "info");
			return;
		}
		const choice = await ctx.ui.select(`✦ ${note.tag}`, [
			"1  Learn more",
			"2  Know this already",
			"3  Chat in main session",
			"0  Dismiss",
		]);
		if (!choice) return;
		if (choice.startsWith("1")) {
			// Dropped only on success, so a failed explanation does not take the note with it.
			if (await showExplanation(ctx, note)) dropNote(ctx, note);
		} else if (choice.startsWith("2")) {
			pushCapped(state.known, note.line);
			dropNote(ctx, note);
			ctx.ui.notify("Won't mention that again.", "info");
		} else if (choice.startsWith("3")) {
			dropNote(ctx, note);
			chatInMain(note);
		} else {
			dropNote(ctx, note);
		}
	};

	/** Fire-and-forget by design: a check must never delay the main agent. */
	const runCheck = async (ctx: ExtensionContext, conversation: Message[]): Promise<void> => {
		const startedAt = Date.now();
		const model = pickModel(ctx);
		if (!model) return;
		const controller = new AbortController();
		inFlight = controller;
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		const askedAt = promptCounter;
		let outcome = "error";
		let usage: Record<string, number | undefined> = {};
		let failure: string | undefined;
		try {
			const reports = collectSubAgentReports(ctx.sessionManager.getEntries(), SUB_AGENT_REPORTS);
			const messages: Message[] = [
				...conversation,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: renderPrompt(template, state, reports) }],
					timestamp: Date.now(),
				},
			];
			const result = await ctx.modelRegistry.complete(
				model,
				{ messages },
				{ signal: controller.signal, sessionId: ctx.sessionManager.getSessionId() },
			);
			usage = {
				input: result.usage.input,
				cacheRead: result.usage.cacheRead,
				output: result.usage.output,
				cost: result.usage.cost.total,
			};
			state.checks += 1;

			const parsed = parseNote(textOf(result));
			if (parsed === null) outcome = "unparsed";
			else if (parsed === "none") outcome = "none";
			else if (promptCounter !== askedAt) outcome = "stale";
			else if (state.seen.some((s) => normalizeLine(s) === normalizeLine(parsed.line))) outcome = "duplicate";
			else if (state.known.some((s) => normalizeLine(s) === normalizeLine(parsed.line))) outcome = "known";
			else {
				pushCapped(state.seen, parsed.line);
				notes.push({ ...parsed, waited: 0, counted: false });
				while (notes.length > MAX_NOTES) notes.shift();
				state.shown += 1;
				outcome = "shown";
				render(ctx);
			}
		} catch (error) {
			outcome = controller.signal.aborted ? "aborted" : "error";
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
			if (inFlight === controller) inFlight = undefined;
			saveState(state);
		}
		logCheck({
			ts: new Date().toISOString(),
			outcome,
			ms: Date.now() - startedAt,
			...usage,
			...(failure ? { error: failure } : {}),
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		state = loadState();
		notes = [];
		llmMessages = [];
		promptCounter = 0;
		turnsSinceCheck = 0;
		template = loadTemplate();
		disabledReason = template ? undefined : `${PROMPT_FILENAME} is missing or empty`;
		render(ctx);
		if (disabledReason && ctx.hasUI) ctx.ui.notify(`you-should-know is off: ${disabledReason}`, "warning");
	});

	pi.on("session_shutdown", async () => {
		inFlight?.abort();
		inFlight = undefined;
		notes = [];
		llmMessages = [];
	});

	pi.on("input", async (event) => {
		// Our own follow-up deliveries are not the user answering.
		if (event.source === "extension") return;
		promptCounter += 1;
		for (const note of notes) {
			note.waited += 1;
			if (!note.counted && note.waited >= FREE_IGNORES) {
				note.counted = true;
				state.ignoredInARow += 1;
				state.skip = nextSkip(state.ignoredInARow);
			}
		}
		saveState(state);
	});

	pi.on("turn_end", async (event, ctx) => {
		llmMessages = event.context.llmMessages;
		if (!state.enabled || !ctx.hasUI || disabledReason) return;

		// Counted across prompts, not within one run: a session made of many
		// short questions would otherwise never reach the threshold.
		turnsSinceCheck += 1;
		if (turnsSinceCheck < CHECK_EVERY_TURNS) return;
		if (inFlight) return;
		turnsSinceCheck = 0;

		if (state.skip > 0) {
			state.skip -= 1;
			saveState(state);
			logCheck({ ts: new Date().toISOString(), outcome: "skipped", skipLeft: state.skip });
			return;
		}
		void runCheck(ctx, event.context.llmMessages).catch(() => undefined);
	});

	pi.registerCommand(COMMAND, {
		description:
			"Side agent that flags what you might have missed. Off by default: '/ysk on' enables it, '/ysk' answers the latest note, '/ysk status' shows checks and spend.",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			if (command === "on" || command === "off") {
				state.enabled = command === "on";
				if (!state.enabled) notes = [];
				saveState(state);
				render(ctx);
				ctx.ui.notify(
					state.enabled
						? "you-should-know on. It checks every 6 turns on deepseek-flash (~0.1-0.3¢ each)."
						: "you-should-know off.",
					"info",
				);
				return;
			}
			if (command === "status") {
				ctx.ui.notify(
					`you-should-know: ${state.enabled ? "on" : "off"} · ${state.checks} checks · ${state.shown} notes shown` +
						(disabledReason ? ` · disabled: ${disabledReason}` : ""),
					"info",
				);
				return;
			}
			if (!state.enabled) {
				ctx.ui.notify("you-should-know is off. '/ysk on' to enable it.", "info");
				return;
			}
			await respond(ctx);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Answer the side agent's note",
		handler: async (ctx) => {
			await respond(ctx);
		},
	});
}
