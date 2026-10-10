/**
 * /stats — usage analytics over every pi session on disk: cost, tokens,
 * cache, models, tools, sub-agents, projects and commits, rhythm, wrapped.
 *
 * Read-only over ~/.pi/agent/sessions and the repos sessions ran in; the
 * only writes are its own caches and settings under <agent dir>/cache/stats.
 * No network.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, type TUI } from "@mariozechner/pi-tui";
import { burn, type Dataset, monthWindow, prepare, RANGES, type RangeId, summarize, summarizeWindow } from "./aggregate";
import { card, center, clampLines, hbar, type Ink, money, SERIES } from "./draw";
import { commitsSince, loadGit } from "./git";
import { type IngestProgress, ingest, ingestWarm } from "./ingest";
import { dayKey } from "./parse";
import { markdownReport } from "./report";
import { StatsView } from "./view";
import { readSettings, todayText, widgetLine, writeSettings } from "./today";
import { writeWrappedPng } from "./wrapped";

const SHORTCUT = "ctrl+shift+s";
const WIDGET_KEY = "stats-today";
const WIDGET_DEBOUNCE_MS = 1500;

const cacheDir = () => path.join(getAgentDir(), "cache", "stats");
const sessionsDir = () => path.join(getAgentDir(), "sessions");

function inkFrom(theme: Theme): Ink {
	return {
		text: (s) => theme.fg("text", s),
		muted: (s) => theme.fg("muted", s),
		dim: (s) => theme.fg("dim", s),
		accent: (s) => theme.fg("accent", s),
		border: (s) => theme.fg("borderMuted", s),
	};
}

function planUsd(): number {
	const n = Number(process.env.PI_STATS_PLAN_USD);
	return Number.isFinite(n) && n > 0 ? n : 200;
}

function rangeArg(arg: string | undefined): RangeId {
	return RANGES.find((r) => r.id === arg)?.id ?? "30d";
}

async function load(onProgress?: (p: IngestProgress) => void, signal?: AbortSignal): Promise<Dataset> {
	const records = await ingest(sessionsDir(), cacheDir(), onProgress, signal);
	const firstSeen = new Map<string, number>();
	for (const r of records) firstSeen.set(r.cwd, Math.min(firstSeen.get(r.cwd) ?? Infinity, r.startMs));
	return prepare(records, await loadGit(firstSeen, cacheDir()));
}

/** Context window per `provider/model` the dataset has seen, from pi's model registry; unknown models are left out. */
function contextWindows(ctx: ExtensionContext, models: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const key of models) {
		const slash = key.indexOf("/");
		const size = ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1))?.contextWindow;
		if (typeof size === "number" && size > 0) out.set(key, size);
	}
	return out;
}

function gb(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

class Loading {
	progress?: IngestProgress;
	constructor(private readonly ink: Ink) {}

	render(width: number): string[] {
		const rows = process.stdout.rows || 24;
		const w = Math.min(64, width - 2);
		const p = this.progress;
		const frac = p?.totalBytes ? p.bytes / p.totalBytes : 0;
		const status = !p
			? "Finding sessions…"
			: p.totalBytes === 0
				? `${p.files.toLocaleString("en-US")} sessions, all cached · reading git…`
				: `${gb(p.bytes)} of ${gb(p.totalBytes)} · ${p.parsed.toLocaleString("en-US")} files parsed`;
		const body = ["", hbar(frac, w - 4, SERIES[0]), "", this.ink.dim(status), this.ink.dim("The first run reads everything; later runs only read what changed."), ""];
		const box = card(this.ink, { title: "pi stats", right: this.ink.dim("esc to cancel"), width: w, body });
		const top = Math.max(0, Math.floor((rows - box.length) / 2));
		return [...new Array(top).fill(""), ...box.map((l) => center(l, width))];
	}
}

async function open(ctx: ExtensionContext): Promise<void> {
	const { budget } = await readSettings(cacheDir());
	await ctx.ui.custom<null>(
		(tui: TUI, theme: Theme, _kb, done) => {
			const ink = inkFrom(theme);
			const loading = new Loading(ink);
			const controller = new AbortController();
			let view: StatsView | undefined;
			let failed: string | undefined;

			load((p) => {
				loading.progress = { ...p };
				tui.requestRender();
			}, controller.signal)
				.then((ds) => {
					if (controller.signal.aborted) return;
					view = new StatsView(ds, ink, { planUsd: planUsd(), windows: contextWindows(ctx, ds.lifetime.modelRank), budget }, () => done(null));
					tui.requestRender();
				})
				.catch((err) => {
					failed = err instanceof Error ? err.message : String(err);
					tui.requestRender();
				});

			return {
				render: (width: number) =>
					view?.render(width) ?? clampLines(failed ? [ink.accent(` pi stats failed: ${failed}`), ink.dim(" esc to close")] : loading.render(width), width),
				handleInput: (data: string) => {
					if (view) view.handleInput(data);
					else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || (decodeKittyPrintable(data) ?? data) === "q") {
						controller.abort();
						done(null);
					}
					tui.requestRender();
				},
				handleMouse: (event) => view?.handleMouse(event),
				invalidate: () => view?.invalidate(),
				dispose: () => controller.abort(),
			};
		},
		{ overlay: true, overlayOptions: { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" } },
	);
}

function tell(pi: ExtensionAPI, ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "stats", content: text, display: true }, { triggerTurn: false });
}

async function exportReport(pi: ExtensionAPI, ctx: ExtensionContext, range: RangeId): Promise<void> {
	const ds = await load();
	const report = markdownReport(ds, summarize(ds, range));
	const file = path.join(cacheDir(), `report-${ds.today}-${range}.md`);
	await fs.writeFile(file, report);
	if (ctx.hasUI) ctx.ui.notify(`pi stats report written to ${file}`, "info");
	else pi.sendMessage({ customType: "stats", content: report, display: true }, { triggerTurn: false });
}

async function exportWrapped(pi: ExtensionAPI, ctx: ExtensionContext, range: RangeId): Promise<void> {
	tell(pi, ctx, `Rendering pi wrapped (${range})…`);
	const ds = await load();
	const file = path.join(cacheDir(), `wrapped-${ds.today}-${range}.png`);
	try {
		await writeWrappedPng(ds, range, planUsd(), file);
	} catch (err) {
		tell(pi, ctx, `pi wrapped PNG failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	tell(pi, ctx, `pi wrapped written to ${file}`);
}

/** The widget's line, or undefined while there is no index cache: the widget never triggers a full parse. */
async function todayLine(budget: number | undefined): Promise<string | undefined> {
	const records = await ingestWarm(sessionsDir(), cacheDir());
	if (!records) return undefined;
	const now = Date.now();
	const today = dayKey(now);
	const midnight = new Date(now).setHours(0, 0, 0, 0);
	const cwds = [...new Set(records.filter((r) => r.spans.some(([, end]) => end >= midnight)).map((r) => r.cwd))];
	const ds = prepare(records, { commits: await commitsSince(cwds, midnight), roots: new Map() }, now);
	const s = summarizeWindow(ds, { start: today, end: today });
	return todayText(s, budget ? burn(summarizeWindow(ds, monthWindow(today)).cost, today, budget) : undefined);
}

interface TodayWidget {
	refresh(ctx: ExtensionContext): void;
}

function todayWidget(pi: ExtensionAPI): TodayWidget {
	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let pending = false;
	let generation = 0;

	const show = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setWidget(
			WIDGET_KEY,
			text ? (_tui, theme) => ({ render: (width: number) => [widgetLine(theme.fg("dim", text), width)], invalidate() {} }) : undefined,
			{ placement: "belowEditor" },
		);
	};

	const run = async () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		const gen = generation;
		try {
			const settings = await readSettings(cacheDir());
			const text = settings.widget ? await todayLine(settings.budget) : undefined;
			if (gen === generation && ctxRef) show(ctxRef, text);
		} catch {
			// a failed refresh keeps the last line; the next agent turn tries again
		} finally {
			running = false;
			if (pending) {
				pending = false;
				schedule(WIDGET_DEBOUNCE_MS);
			}
		}
	};

	const schedule = (ms: number) => {
		if (!ctxRef) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void run();
		}, ms);
		timer.unref?.();
	};

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctxRef = ctx;
		generation++;
		schedule(0);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctxRef) return;
		ctxRef = ctx;
		schedule(WIDGET_DEBOUNCE_MS);
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		ctxRef = undefined;
		pending = false;
		generation++;
	});

	return { refresh };
}

async function setWidget(pi: ExtensionAPI, ctx: ExtensionContext, arg: string | undefined, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	if (arg !== "on" && arg !== "off") {
		return tell(pi, ctx, `stats widget is ${settings.widget ? "on" : "off"} · /stats widget on|off`);
	}
	await writeSettings(cacheDir(), { ...settings, widget: arg === "on" });
	widget.refresh(ctx);
	tell(pi, ctx, arg === "on" ? "stats widget on: today's spend under the editor, updated after each agent run (needs /stats to have built its index once)" : "stats widget off");
}

async function setBudget(pi: ExtensionAPI, ctx: ExtensionContext, arg: string | undefined, widget: TodayWidget): Promise<void> {
	const settings = await readSettings(cacheDir());
	if (!arg) {
		return tell(pi, ctx, settings.budget ? `monthly budget ${money(settings.budget)} (API-price spend) · /stats budget <usd>|off` : "no monthly budget · /stats budget <usd>");
	}
	const usd = Number(arg.replace(/^\$/, ""));
	if (arg !== "off" && !(Number.isFinite(usd) && usd > 0)) return tell(pi, ctx, `not a budget: ${arg} · /stats budget <usd>|off`, "error");
	await writeSettings(cacheDir(), { ...settings, budget: arg === "off" ? undefined : usd });
	widget.refresh(ctx);
	tell(pi, ctx, arg === "off" ? "monthly budget cleared" : `monthly budget set to ${money(usd)} of API-price spend`);
}

export default function statsExtension(pi: ExtensionAPI): void {
	const widget = todayWidget(pi);
	pi.registerCommand("stats", {
		description:
			"Usage analytics: cost, tokens, cache, models, tools, agents, projects, commits · /stats export|wrapped [7d|30d|90d|1y|all] · /stats widget on|off · /stats budget <usd>|off",
		handler: async (args, ctx) => {
			const [sub, arg] = (args ?? "").trim().split(/\s+/);
			if (sub === "widget") return setWidget(pi, ctx, arg, widget);
			if (sub === "budget") return setBudget(pi, ctx, arg, widget);
			if (sub === "wrapped") return exportWrapped(pi, ctx, rangeArg(arg));
			if (sub === "export" || !ctx.hasUI) return exportReport(pi, ctx, rangeArg(sub === "export" ? arg : undefined));
			return open(ctx);
		},
	});
	pi.registerShortcut(SHORTCUT, {
		description: "Open pi stats",
		handler: async (ctx) => {
			if (ctx.hasUI) await open(ctx);
		},
	});
}
