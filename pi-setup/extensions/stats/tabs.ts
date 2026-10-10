import os from "node:os";
import { cacheHit, cacheSavings, percentile, type SessionStat, type Summary, weekday } from "./aggregate";
import {
	AGENT,
	BAD,
	type Better,
	bg,
	bold,
	card,
	cardRow,
	center,
	clip,
	type ColSpec,
	columnChart,
	compact,
	delta,
	dot,
	duration,
	fg,
	GOOD,
	gradientText,
	hbar,
	hstack,
	type Ink,
	int,
	money,
	note,
	OTHER,
	pad,
	pct,
	rampAt,
	rampColor,
	type RGB,
	segmentBar,
	SERIES,
	spread,
	split,
	table,
	tail,
	tiles,
	WARN,
	WHITE,
} from "./draw";
import { A, T, U } from "./parse";
import { type Ctx, dayGrader, dayPanel, filterLabel, heatmap, longDate, modelLabel, plot, punchcard, skyline, timeline, unscoped } from "./widgets";

export interface Tab {
	title: string;
	hint: string;
	render(ctx: Ctx): string[];
}

const C = {
	teal: SERIES[0],
	violet: SERIES[1],
	amber: SERIES[2],
	blue: SERIES[3],
	rose: SERIES[4],
	lime: SERIES[5],
	orange: SERIES[6],
	indigo: SERIES[7],
};

const HOME = os.homedir();
const AGENTS_EXCLUDED = "Sub-agent rows carry no provider, so agent runs and spend are excluded under a provider filter.";

/** "sfrog/crates/core/src/store.rs" when the file is inside a known project, else a ~ path. */
function projectPath(ctx: Ctx, file: string): string {
	let best = "";
	for (const root of ctx.ds.projectName.keys()) {
		if (root.length > best.length && file.startsWith(`${root}/`)) best = root;
	}
	if (best) return `${ctx.ds.projectName.get(best)}${file.slice(best.length)}`;
	return file.startsWith(HOME) ? `~${file.slice(HOME.length)}` : file;
}

function modelOrDash(model: string): string {
	return model === "unknown" ? "—" : model;
}

function share(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

/** Like `share`, but NaN (shown as "—") when there is no whole to take a share of. */
function rate(part: number, whole: number): number {
	return whole > 0 ? part / whole : NaN;
}

function netSaved(s: Summary): number {
	const save = cacheSavings(s.models);
	return save.saved - save.premium;
}

/** Change of `pick` against the previous window; empty for the lifetime range. */
function vs(ctx: Ctx, pick: (s: Summary) => number, better: Better, points = false): string {
	return delta(ctx.ink, pick(ctx.s), ctx.prev && pick(ctx.prev), better, points);
}

/** `vs` for a number that has no provider: nothing to compare under a provider filter. */
function vsUnscoped(ctx: Ctx, pick: (s: Summary) => number, better: Better): string {
	return ctx.s.filter.provider === undefined ? vs(ctx, pick, better) : "";
}

function sessionName(ctx: Ctx, x: SessionStat): string {
	return x.name ?? ctx.ink.dim(`untitled ${x.id.slice(0, 8)}`);
}

function when(ms: number): string {
	const d = new Date(ms);
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function relative(ms: number, now: number): string {
	const days = Math.floor((now - ms) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function kv(ink: Ink, pairs: Array<[string, string]>, inner: number): string[] {
	if (inner < 70) return pairs.map(([k, v]) => spread(ink.muted(k), v, inner));
	const [lw, rw] = split(inner, 2, 4);
	const half = Math.ceil(pairs.length / 2);
	const left = pairs.slice(0, half).map(([k, v]) => spread(ink.muted(k), v, lw));
	const right = pairs.slice(half).map(([k, v]) => spread(ink.muted(k), v, rw));
	return hstack([left, right], [lw, rw], 4);
}

function bars(ink: Ink, items: Array<{ label: string; value: number; text: string; color: RGB }>, inner: number, labelW = 18): string[] {
	if (!items.length) return [ink.muted("Nothing here yet.")];
	const max = Math.max(...items.map((i) => i.value));
	const textW = Math.max(...items.map((i) => i.text.length), 4);
	const barW = Math.max(4, inner - labelW - textW - 2);
	return items.map((i) => `${pad(i.label, labelW)}${hbar(share(i.value, max), barW, i.color)} ${ink.text(i.text.padStart(textW))}`);
}

function peakHour(s: Summary): number {
	const byHour = Array.from({ length: 24 }, (_, h) => s.punch.reduce((a, r) => a + r[h], 0));
	return byHour.indexOf(Math.max(...byHour));
}

function turnsShare(s: Summary, from: number, to: number): number {
	let part = 0;
	let all = 0;
	for (const r of s.punch) {
		for (let h = 0; h < 24; h++) {
			all += r[h];
			if (h >= from && h < to) part += r[h];
		}
	}
	return share(part, all);
}

function busiestDay(s: Summary): [string, number] | undefined {
	let best: [string, number] | undefined;
	for (const d of s.daily.values()) {
		const v = d.cost + d.agentCost;
		if (v > 0 && (!best || v > best[1])) best = [d.day, v];
	}
	return best;
}

function hourLabel(h: number): string {
	return `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
}

function burnCard(ctx: Ctx): string[] {
	const { ink, width, burn: b } = ctx;
	const budget = b.budget;
	const used = budget ? b.spent / budget : undefined;
	const tone = !budget ? C.teal : b.spent > budget ? BAD : b.projection > budget ? WARN : GOOD;
	const body = kv(ink, [
		["Month to date", `${bold(money(b.spent))} ${ink.dim(`day ${b.elapsed} of ${b.daysInMonth}`)}`],
		["Linear projection", `${money(b.projection)} ${ink.dim(`MTD ÷ ${b.elapsed}d × ${b.daysInMonth}d`)}`],
		["Budget", budget ? money(budget) : ink.dim("none · /stats budget <usd>")],
		["Used", used === undefined ? "—" : fg(tone, pct(used, 0))],
	], width - 4);
	if (used !== undefined) body.push(hbar(used, width - 4, tone));
	const scope = ctx.s.filter.project !== undefined || ctx.s.filter.provider !== undefined ? "account-wide, filters not applied" : "account-wide";
	return card(ink, { title: "This month · API-price spend", right: ink.dim(scope), width, body });
}

const overview: Tab = {
	title: "Overview",
	hint: "←→ week · ↑↓ day · t today · v skyline · m metric · c colours",
	render(ctx) {
		const { s, ds, ink, width, streak } = ctx;
		const byProvider = s.filter.provider !== undefined;
		const out = tiles(ink, [
			{ label: "Cost", value: money(s.cost), sub: byProvider ? "main sessions only" : `agents ${pct(share(s.agentTotal[A.cost], s.cost), 0)} of it`, color: C.teal, delta: vs(ctx, (x) => x.cost, "down") },
			{ label: "Tokens", value: compact(s.tokens), sub: `${compact(s.usage[U.output] + s.agentTotal[A.output])} written`, color: C.violet, delta: vs(ctx, (x) => x.tokens, "either") },
			{ label: "Active days", value: int(s.activeDays), sub: `of ${s.days.length} · streak ${streak.currentStreak}d`, color: C.amber, delta: vs(ctx, (x) => x.activeDays, "either") },
			{ label: "Sessions", value: int(s.sessions.length), sub: `${unscoped(ctx, int(s.prompts))} prompts`, color: C.blue, delta: vs(ctx, (x) => x.sessions.length, "either") },
			{ label: "Cache hit", value: pct(cacheHit(s.usage)), sub: `saved ${money(netSaved(s))}`, color: GOOD, delta: vs(ctx, (x) => cacheHit(x.usage), "up", true) },
			{ label: "Agent runs", value: unscoped(ctx, int(s.agentTotal[A.runs])), sub: byProvider ? "excluded by provider" : `${money(s.agentTotal[A.cost])} spent`, color: AGENT, delta: vsUnscoped(ctx, (x) => x.agentTotal[A.runs], "either") },
			{ label: "Time with pi", value: unscoped(ctx, duration(s.activeMs)), sub: `${int(s.usage[U.turns])} model turns`, color: C.orange, delta: vsUnscoped(ctx, (x) => x.activeMs, "either") },
			{ label: "Commits", value: unscoped(ctx, int(s.commits.length)), sub: byProvider ? "no provider on commits" : `${int(s.piCommits)} with pi`, color: C.lime, delta: vsUnscoped(ctx, (x) => x.commits.length, "up") },
		], width);
		out.push("");
		out.push(...burnCard(ctx), "");

		const heatInner = 4 + 2 * 53;
		const side = width >= heatInner + 4 + 2 + 44;
		const heatW = side ? heatInner + 4 : width;
		const heatBody = ctx.skyline ? skyline(ctx, heatW - 4) : heatmap(ctx, heatW - 4);
		const heat = { title: "Contributions", right: ink.dim(`${ctx.year.activeDays} active days · ${ctx.metric}/day`), body: heatBody };
		const dayW = side ? width - heatW - 2 : width;
		const day = { title: "Day breakdown", right: ink.dim("arrows"), body: dayPanel(ctx, ctx.cursor, dayW - 4) };
		if (side) {
			const h = Math.max(heat.body.length, day.body.length);
			const fill = (b: string[]) => [...b, ...new Array(h - b.length).fill("")];
			out.push(...hstack([card(ink, { ...heat, width: heatW, body: fill(heat.body) }), card(ink, { ...day, width: dayW, body: fill(day.body) })], [heatW, dayW]));
		} else {
			out.push(...card(ink, { ...heat, width }), "", ...card(ink, { ...day, width }));
		}
		out.push("");
		out.push(...card(ink, { title: "Usage over time", right: ink.dim(`${s.label} · ${ctx.metric} by model`), width, body: timeline(ctx, width - 4, 10) }));
		out.push("");

		const fav = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost])[0];
		const busy = busiestDay(s);
		const big = s.sessions[0];
		const ph = peakHour(s);
		const unpriced = [...s.models.values()].reduce((n, u) => n + (u[U.cost] === 0 ? u[U.turns] : 0), 0);
		out.push(...card(ink, {
			title: "Highlights",
			width,
			body: kv(ink, [
				["Favourite model", fav ? `${modelLabel(fav[0])} ${ink.dim(pct(share(fav[1][U.cost], s.usage[U.cost]), 0))}` : "—"],
				["Busiest day", busy ? `${longDate(busy[0])} ${ink.dim(money(busy[1]))}` : "—"],
				["Peak hour", s.usage[U.turns] ? hourLabel(ph) : "—"],
				["Biggest session", big ? `${clip(big.name ?? "untitled", 48)} ${ink.dim(`${ds.projectName.get(big.project) ?? big.project} · ${money(big.cost)}`)}` : "—"],
				["Longest streak", streak.longestStreak ? `${streak.longestStreak} days ${ink.dim(`ending ${streak.longestStreakEnd}`)}` : "—"],
				["Per active day", s.activeDays ? `${money(s.cost / s.activeDays)} · ${unscoped(ctx, duration(s.activeMs / s.activeDays))}` : "—"],
				["Unpriced turns", unpriced ? `${int(unpriced)} ${ink.dim("pi recorded no price; counted as $0")}` : ink.dim("none")],
			], width - 4),
		}));
		return out;
	},
};

function monthRows(ctx: Ctx): string[][] {
	const months = new Map<string, { cost: number; tokens: number; turns: number; days: number; agent: number; cr: number; den: number }>();
	for (const d of ctx.s.daily.values()) {
		const key = d.day.slice(0, 7);
		const m = months.get(key) ?? { cost: 0, tokens: 0, turns: 0, days: 0, agent: 0, cr: 0, den: 0 };
		m.cost += d.cost + d.agentCost;
		m.agent += d.agentCost;
		m.tokens += d.tokens;
		m.turns += d.turns;
		m.days += d.turns > 0 ? 1 : 0;
		m.cr += d.cacheRead;
		m.den += d.cacheDenom;
		months.set(key, m);
	}
	const list = [...months].sort((a, b) => b[0].localeCompare(a[0]));
	const max = Math.max(0, ...list.map(([, m]) => m.cost));
	return list.map(([key, m], i) => {
		const prev = list[i + 1]?.[1].cost;
		const label = new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
		return [
			label,
			hbar(share(m.cost, max), 24, C.teal),
			money(m.cost),
			prev === undefined ? ctx.ink.dim("—") : delta(ctx.ink, m.cost, prev, "down"),
			compact(m.tokens),
			int(m.turns),
			String(m.days),
			m.den ? pct(m.cr / m.den, 0) : "—",
			unscoped(ctx, money(m.agent)),
		];
	});
}

const timelineTab: Tab = {
	title: "Timeline",
	hint: "m metric · g group by model/project",
	render(ctx) {
		const { ink, width, s } = ctx;
		const out = card(ink, { title: "Usage over time", right: ink.dim(`${s.label} · ${ctx.metric} by ${ctx.group}`), width, body: timeline(ctx, width - 4, 16) });
		const cols: ColSpec[] = [
			{ title: "Month", w: 9 },
			{ title: "", w: 24, drop: 2 },
			{ title: "Cost", w: 9, right: true },
			{ title: "vs prev", w: 7, right: true, drop: 1 },
			{ title: "Tokens", w: 8, right: true },
			{ title: "Turns", w: 8, right: true },
			{ title: "Days", w: 4, right: true },
			{ title: "Cache", w: 5, right: true, drop: 1 },
			{ title: "Agents", w: 8, right: true },
		];
		out.push("", ...card(ink, { title: "Month by month", width, body: table(ink, cols, monthRows(ctx), width - 4) }));
		return out;
	},
};

/** `v` tokens, with its share of the model's context window when the registry knows it. */
function ofWindow(ctx: Ctx, model: string, v: number | undefined): string {
	if (v === undefined) return "—";
	const win = ctx.windows.get(model);
	return win ? `${compact(v)} ${ctx.ink.dim(pct(v / win, 0))}` : compact(v);
}

function contextCard(ctx: Ctx): string[] {
	const { s, ink, width } = ctx;
	const sorted = (list: number[] | undefined) => [...(list ?? [])].sort((a, b) => a - b);
	const models = [...new Set([...s.contexts.keys(), ...s.compactionTokens.keys()])]
		.map((model) => ({ model, turns: sorted(s.contexts.get(model)), compactions: sorted(s.compactionTokens.get(model)) }))
		.sort((a, b) => b.turns.length - a.turns.length || b.compactions.length - a.compactions.length)
		.slice(0, 12);
	const cols: ColSpec[] = [
		{ title: "Model", w: 0, flex: true },
		{ title: "Window", w: 7, right: true },
		{ title: "Turns", w: 7, right: true, drop: 2 },
		{ title: "Median", w: 11, right: true, drop: 1 },
		{ title: "p90", w: 11, right: true },
		{ title: "Peak", w: 11, right: true },
		{ title: "Near full", w: 9, right: true, drop: 2 },
		{ title: "Compactions", w: 11, right: true, drop: 3 },
		{ title: "At compaction", w: 13, right: true, drop: 3 },
	];
	const rows = models.map(({ model, turns, compactions }) => {
		const win = ctx.windows.get(model);
		return [
			`${dot(ctx.color(model))} ${modelLabel(model)}`,
			win ? compact(win) : ink.dim("—"),
			int(turns.length),
			ofWindow(ctx, model, percentile(turns, 0.5)),
			ofWindow(ctx, model, percentile(turns, 0.9)),
			ofWindow(ctx, model, turns[turns.length - 1]),
			win ? int(turns.filter((c) => c >= 0.8 * win).length) : ink.dim("—"),
			int(compactions.length),
			ofWindow(ctx, model, percentile(compactions, 0.5)),
		];
	});
	const body = models.length
		? [
				...table(ink, cols, rows, width - 4),
				"",
				...note(
					ink,
					"Context = input + cache read + cache write of one main turn. % is of the context window pi's model registry lists for the model; — where it lists none. Percentiles are exact (nearest rank). Near full: turns at ≥80% of the window. At compaction: median tokensBefore pi recorded when it compacted.",
					width - 4,
				),
			]
		: [ink.muted("No main turns in this range.")];
	return card(ink, { title: "Context pressure", right: ink.dim(s.label), width, body });
}

function fullestCard(ctx: Ctx): string[] {
	const { s, ds, ink, width } = ctx;
	const top = s.sessions.filter((x) => x.peakContext > 0).sort((a, b) => b.peakContext - a.peakContext).slice(0, 8);
	const cols: ColSpec[] = [
		{ title: "Session", w: 0, flex: true },
		{ title: "Project", w: 16, drop: 1 },
		{ title: "Model", w: 18, drop: 2 },
		{ title: "Peak", w: 11, right: true },
		{ title: "Compactions", w: 11, right: true, drop: 1 },
	];
	const rows = top.map((x) => [
		sessionName(ctx, x),
		ink.dim(ds.projectName.get(x.project) ?? x.project),
		ink.dim(modelLabel(x.peakModel)),
		ofWindow(ctx, x.peakModel, x.peakContext),
		int(x.compactions),
	]);
	const body = top.length ? table(ink, cols, rows, width - 4) : [ink.muted("No main turns in this range.")];
	return card(ink, { title: "Fullest sessions", right: ink.dim("largest single-turn context"), width, body });
}

const modelsTab: Tab = {
	title: "Models",
	hint: "main-session models · agent models live in Agents",
	render(ctx) {
		const { s, ink, width } = ctx;
		const total = s.usage[U.cost];
		const list = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost] || b[1][U.turns] - a[1][U.turns]);
		const max = list[0]?.[1][U.cost] ?? 0;
		const errCell = (n: number, turns: number) => {
			const r = share(n, turns);
			return r > 0.05 ? fg(BAD, pct(r, 0)) : ink.dim(pct(r, 0));
		};
		const rows = list.slice(0, 20).map(([key, u]) => {
			const slash = key.indexOf("/");
			const tps = u[U.durationMs] > 0 ? u[U.timedOutput] / (u[U.durationMs] / 1000) : NaN;
			return [
				`${dot(ctx.color(key))} ${key.slice(slash + 1)}`,
				ink.dim(key.slice(0, slash)),
				hbar(share(u[U.cost], max), 16, ctx.color(key)),
				money(u[U.cost]),
				pct(share(u[U.cost], total), 0),
				int(u[U.turns]),
				compact(u[U.input] + u[U.output] + u[U.cacheRead] + u[U.cacheWrite]),
				pct(cacheHit(u), 0),
				Number.isFinite(tps) ? tps.toFixed(0) : "—",
				money(share(u[U.cost], u[U.turns])),
				errCell(u[U.errors], u[U.turns]),
				errCell(u[U.aborted], u[U.turns]),
				int(s.modelCommits.get(key) ?? 0),
			];
		});
		const cols: ColSpec[] = [
			{ title: "Model", w: 0, flex: true },
			{ title: "Provider", w: 13, drop: 4 },
			{ title: "", w: 16, drop: 5 },
			{ title: "Cost", w: 9, right: true },
			{ title: "Share", w: 5, right: true, drop: 3 },
			{ title: "Turns", w: 7, right: true },
			{ title: "Tokens", w: 7, right: true, drop: 1 },
			{ title: "Cache", w: 5, right: true, drop: 2 },
			{ title: "Tok/s", w: 5, right: true, drop: 2 },
			{ title: "$/turn", w: 7, right: true, drop: 2 },
			{ title: "Err", w: 4, right: true, drop: 1 },
			{ title: "Abort", w: 5, right: true, drop: 1 },
			{ title: "Led commits", w: 11, right: true, drop: 1 },
		];
		const board = list.length
			? [
					...table(ink, cols, rows, width - 4),
					"",
					...note(
						ink,
						"Err / Abort: share of turns that stopped on an error / were aborted. Led commits: commits whose Session-Id trailer names a session this model led (largest main-session spend in it). Untagged commits count for no model.",
						width - 4,
					),
				]
			: [ink.muted("No turns in this range.")];
		const out = card(ink, { title: "Model leaderboard", right: ink.dim(`${list.length} used · ${s.label}`), width, body: board });
		out.push("", ...contextCard(ctx), "", ...fullestCard(ctx));

		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"];
		const thinking = [...s.thinking].sort((a, b) => levels.indexOf(a[0]) - levels.indexOf(b[0]));
		const providers = [...s.providers].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 8);
		const [w1] = split(width, 2);
		out.push("", ...cardRow(ink, width, [
			{
				title: "Thinking levels",
				right: ink.dim("by turns"),
				body: bars(ink, thinking.map(([lvl, u], i) => ({ label: lvl, value: u[U.turns], text: `${int(u[U.turns])} · ${money(u[U.cost])}`, color: rampAt(ctx.ramp, (i + 1) / levels.length) })), w1 - 4, 10),
			},
			{
				title: "Providers",
				right: ink.dim("by cost"),
				body: bars(ink, providers.map(([p, u], i) => ({ label: p, value: u[U.cost], text: money(u[U.cost]), color: SERIES[i % SERIES.length] })), w1 - 4, 16),
			},
		]));

		const u = s.usage;
		const tokenParts: Array<[RGB, number]> = [[C.blue, u[U.input]], [C.violet, u[U.output]], [C.teal, u[U.cacheRead]], [C.amber, u[U.cacheWrite]]];
		const costParts: Array<[RGB, number]> = [[C.blue, u[U.costInput]], [C.violet, u[U.costOutput]], [C.teal, u[U.costCacheRead]], [C.amber, u[U.costCacheWrite]]];
		const inner = width - 4;
		const names = ["input", "output", "cache read", "cache write"];
		const tokTotal = tokenParts.reduce((a, [, v]) => a + v, 0);
		const costTotal = costParts.reduce((a, [, v]) => a + v, 0);
		const keyLine = names.map((n, i) => `${dot(tokenParts[i][0])} ${n} ${ink.dim(`${pct(share(tokenParts[i][1], tokTotal), 0)} of tokens · ${pct(share(costParts[i][1], costTotal), 0)} of cost`)}`);
		out.push("", ...card(ink, {
			title: "Where tokens go vs where money goes",
			width,
			body: [
				spread(ink.muted("tokens"), ink.dim(compact(tokTotal)), inner),
				segmentBar(tokenParts, inner),
				spread(ink.muted("cost"), ink.dim(money(costTotal)), inner),
				segmentBar(costParts, inner),
				"",
				...kv(ink, keyLine.map((l) => [l, ""] as [string, string]), inner),
				ink.dim(`reasoning: ${compact(u[U.reasoning])} of the output tokens were thinking`),
			],
		}));
		return out;
	},
};

function bustCard(ctx: Ctx): string[] {
	const { s, ds, ink, width, bustOrder } = ctx;
	const list = [...s.busts].sort(bustOrder === "cost" ? (a, b) => b.cost - a.cost : (a, b) => b.ms - a.ms).slice(0, 12);
	const cols: ColSpec[] = [
		{ title: "When", w: 12 },
		{ title: "Session", w: 0, flex: true },
		{ title: "Project", w: 14, drop: 2 },
		{ title: "Model", w: 18, drop: 3 },
		{ title: "Context", w: 7, right: true },
		{ title: "Rewrite $", w: 9, right: true },
		{ title: "Gap", w: 7, right: true, drop: 1 },
		{ title: "Kind", w: 6, drop: 1 },
	];
	const rows = list.map((b) => [
		ink.dim(when(b.ms)),
		sessionName(ctx, b.session),
		ink.dim(ds.projectName.get(b.session.project) ?? b.session.project),
		ink.dim(modelLabel(b.model)),
		compact(b.context),
		money(b.cost),
		duration(b.gapMs),
		b.idle ? fg(WARN, "idle") : "prefix",
	]);
	const body = list.length ? table(ink, cols, rows, width - 4) : [ink.muted("No cache busts in this range.")];
	if (s.busts.length > list.length) body.push(ink.dim(`  ${int(s.busts.length - list.length)} more in this range`));
	const order = bustOrder === "cost" ? "costliest first · b for latest" : "latest first · b for costliest";
	return card(ink, { title: "Cache busts", right: ink.dim(order), width, body });
}

const cacheTab: Tab = {
	title: "Cache",
	hint: "bust = a turn that rewrote ≥ half of a warm context · b sort busts",
	render(ctx) {
		const { s, ink, width } = ctx;
		const u = s.usage;
		const save = cacheSavings(s.models);
		const out = tiles(ink, [
			{ label: "Hit rate", value: pct(cacheHit(u)), sub: "cache reads ÷ prompt tokens", color: GOOD, delta: vs(ctx, (x) => cacheHit(x.usage), "up", true) },
			{ label: "Net saved", value: money(save.saved - save.premium), sub: `reads ${money(save.saved)} · writes +${money(save.premium)}`, color: C.teal, delta: vs(ctx, netSaved, "up") },
			{ label: "Read from cache", value: compact(u[U.cacheRead]), sub: `cost ${money(u[U.costCacheRead])}`, color: C.violet, delta: vs(ctx, (x) => x.usage[U.cacheRead], "either") },
			{ label: "Written to cache", value: compact(u[U.cacheWrite]), sub: `cost ${money(u[U.costCacheWrite])}`, color: C.amber, delta: vs(ctx, (x) => x.usage[U.cacheWrite], "either") },
			{ label: "Cache busts", value: int(u[U.busts]), sub: `${int(u[U.idleBusts])} idle · ${int(u[U.busts] - u[U.idleBusts])} prefix`, color: C.rose, delta: vs(ctx, (x) => x.usage[U.busts], "down") },
			{ label: "Bust rewrites", value: money(u[U.bustCost]), sub: `${pct(share(u[U.bustCost], u[U.cost]), 0)} of main spend`, color: BAD, delta: vs(ctx, (x) => x.usage[U.bustCost], "down") },
		], width);
		const hitColor = (h: number): RGB => (h >= 0.93 ? GOOD : h >= 0.85 ? C.teal : h >= 0.7 ? WARN : BAD);
		out.push("", ...card(ink, {
			title: "Hit rate by day",
			right: ink.dim(`${fg(GOOD, "■")} ≥93%  ${fg(C.teal, "■")} ≥85%  ${fg(WARN, "■")} ≥70%  ${fg(BAD, "■")} below`),
			width,
			body: plot(ctx, (day) => {
				const d = s.daily.get(day)!;
				const h = d.cacheDenom > 0 ? d.cacheRead / d.cacheDenom : 0;
				return [[hitColor(h), h]];
			}, width - 4, 8, { format: (v) => pct(v, 0), max: 1, average: true }),
		}));
		const parts: RGB[] = [C.blue, C.violet, C.teal, C.amber];
		out.push("", ...card(ink, {
			title: "Where the money goes",
			right: ink.dim(["input", "output", "cache read", "cache write"].map((n, i) => `${fg(parts[i], "■")} ${n}`).join("  ")),
			width,
			body: plot(ctx, (day) => s.daily.get(day)!.parts.map((v, i) => [parts[i], v] as [RGB, number]), width - 4, 8, { format: money }),
		}));
		const list = [...s.models].filter(([, m]) => m[U.cacheRead] + m[U.cacheWrite] > 0).sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 14);
		const cols: ColSpec[] = [
			{ title: "Model", w: 0, flex: true },
			{ title: "Hit", w: 6, right: true },
			{ title: "Read", w: 7, right: true },
			{ title: "Write", w: 7, right: true },
			{ title: "Net saved", w: 9, right: true },
			{ title: "Busts", w: 6, right: true },
			{ title: "Idle", w: 6, right: true, drop: 1 },
			{ title: "Rewrite $", w: 9, right: true },
		];
		const rows = list.map(([key, m]) => [
			`${dot(ctx.color(key))} ${modelLabel(key)}`,
			fg(hitColor(cacheHit(m)), pct(cacheHit(m), 1)),
			compact(m[U.cacheRead]),
			compact(m[U.cacheWrite]),
			save.byModel.has(key) ? money(save.byModel.get(key)!) : ink.dim("—"),
			int(m[U.busts]),
			int(m[U.idleBusts]),
			money(m[U.bustCost]),
		]);
		out.push("", ...card(ink, {
			title: "Cache by model",
			width,
			body: [
				...table(ink, cols, rows, width - 4),
				"",
				...note(
					ink,
					"Bust: a turn on a warm context (≥20K) that rewrote at least half of it. Idle: the gap since the last turn outlived the cache TTL. Prefix: something earlier in the prompt changed. Turns after a compaction or a model switch never count. Net saved = cache reads at the input rate, minus the extra paid for writes.",
					width - 4,
				),
			],
		}));
		out.push("", ...bustCard(ctx));
		return out;
	},
};

function toolRows(ctx: Ctx, tools: Map<string, number[]>, inner: number, limit: number): string[] {
	const { ink } = ctx;
	const list = [...tools].sort((a, b) => b[1][T.calls] - a[1][T.calls]).slice(0, limit);
	if (!list.length) return [ink.muted("No tool calls in this range.")];
	const max = list[0][1][T.calls];
	const barW = Math.max(6, Math.min(30, inner - 50));
	const cols: ColSpec[] = [
		{ title: "Tool", w: 0, flex: true },
		{ title: "", w: barW, drop: 2 },
		{ title: "Calls", w: 7, right: true },
		{ title: "Err", w: 5, right: true },
		{ title: "Avg", w: 6, right: true, drop: 1 },
	];
	return table(ink, cols, list.map(([name, t]) => {
		const err = share(t[T.errors], t[T.calls]);
		return [
			name,
			hbar(share(t[T.calls], max), barW, C.teal),
			int(t[T.calls]),
			err > 0.05 ? fg(BAD, pct(err, 0)) : ink.dim(pct(err, 0)),
			t[T.timed] ? duration(t[T.durationMs] / t[T.timed]) : "—",
		];
	}), inner);
}

const toolsTab: Tab = {
	title: "Tools",
	hint: "every tool call, yours and your agents'",
	render(ctx) {
		const { s, ink, width } = ctx;
		const sum = (m: Map<string, number[]>, i: number) => [...m.values()].reduce((a, t) => a + t[i], 0);
		const calls = sum(s.tools, T.calls);
		const editsTotal = [...s.edits.values()].reduce((a, b) => a + b, 0);
		const out = tiles(ink, [
			{ label: "Tool calls", value: int(calls), sub: `${share(calls, s.usage[U.turns]).toFixed(1)} per turn`, color: C.teal },
			{ label: "Error rate", value: pct(share(sum(s.tools, T.errors), calls)), sub: `${int(sum(s.tools, T.errors))} failed`, color: C.rose },
			{ label: "Tool time", value: duration(sum(s.tools, T.durationMs)), sub: "where timed", color: C.orange },
			{ label: "Inside agents", value: unscoped(ctx, int(sum(s.agentTools, T.calls))), sub: `${unscoped(ctx, pct(share(sum(s.agentTools, T.errors), sum(s.agentTools, T.calls))))} errors`, color: AGENT },
			{ label: "File edits", value: int(editsTotal), sub: `${int(s.edits.size)} files`, color: C.violet },
			{ label: "Shell commands", value: int([...s.bash.values()].reduce((a, b) => a + b, 0)), sub: `${int(s.bash.size)} distinct`, color: C.amber },
		], width);
		const [w1] = split(width, 2);
		out.push("", ...cardRow(ink, width, [
			{ title: "Your tools", body: toolRows(ctx, s.tools, w1 - 4, 14) },
			{ title: "Inside agents", body: s.filter.provider === undefined ? toolRows(ctx, s.agentTools, w1 - 4, 14) : [ink.muted(AGENTS_EXCLUDED)] },
		], 56));
		const commands = [...s.bash].sort((a, b) => b[1] - a[1]).slice(0, 14);
		const edits = [...s.edits].sort((a, b) => b[1] - a[1]).slice(0, 14);
		const fileW = w1 - 4 - 8;
		out.push("", ...cardRow(ink, width, [
			{ title: "Top shell commands", body: bars(ink, commands.map(([c, n]) => ({ label: c, value: n, text: int(n), color: C.amber })), w1 - 4, 18) },
			{ title: "Most edited files", body: edits.length ? edits.map(([p, n]) => spread(tail(projectPath(ctx, p), fileW), ink.dim(int(n)), w1 - 4)) : [ink.muted("No edits in this range.")] },
		], 56));
		return out;
	},
};

const agentsTab: Tab = {
	title: "Agents",
	hint: "sub-agent spend comes from each run's own usage record",
	render(ctx) {
		const { s, ink, width } = ctx;
		if (s.filter.provider !== undefined) {
			return card(ink, { title: "Sub-agents", right: ink.dim(s.label), width, body: note(ink, `${AGENTS_EXCLUDED} Press O to clear the provider filter.`, width - 4) });
		}
		const a = s.agentTotal;
		const maxFan = Math.max(0, ...s.fanout.keys());
		const list = [...s.agents].filter(([, v]) => v[A.runs] > 0 || v[A.cost] > 0).sort((x, y) => y[1][A.cost] - x[1][A.cost]);
		const color = (i: number) => SERIES[i % SERIES.length];
		const out = tiles(ink, [
			{ label: "Agent runs", value: int(a[A.runs]), sub: `${int(list.length)} kinds`, color: AGENT, delta: vs(ctx, (x) => x.agentTotal[A.runs], "either") },
			{ label: "Agent spend", value: money(a[A.cost]), sub: `${pct(share(a[A.cost], s.cost), 0)} of all spend`, color: C.teal, delta: vs(ctx, (x) => x.agentTotal[A.cost], "down") },
			{ label: "Per run", value: money(share(a[A.cost], a[A.runs])), sub: `${share(a[A.turns], a[A.runs]).toFixed(1)} turns each`, color: C.violet, delta: vs(ctx, (x) => rate(x.agentTotal[A.cost], x.agentTotal[A.runs]), "down") },
			{ label: "Agent turns", value: int(a[A.turns]), sub: `${compact(a[A.output])} tokens written`, color: C.blue, delta: vs(ctx, (x) => x.agentTotal[A.turns], "either") },
			{ label: "Failures", value: pct(rate(a[A.failures], a[A.runs])), sub: `${int(a[A.failures])} runs`, color: C.rose, delta: vs(ctx, (x) => rate(x.agentTotal[A.failures], x.agentTotal[A.runs]), "down", true) },
			{ label: "Biggest swarm", value: maxFan ? `${maxFan} agents` : "—", sub: "in one message", color: C.amber },
		], width);
		const topModel = (agent: string) => {
			let best: [string, number] | undefined;
			for (const [k, v] of s.agentPairs) {
				const [ag, model] = k.split("\t");
				if (ag === agent && (!best || v[A.runs] > best[1])) best = [model, v[A.runs]];
			}
			return modelOrDash(best?.[0] ?? "unknown");
		};
		const maxRuns = Math.max(0, ...list.map(([, v]) => v[A.runs]));
		const cols: ColSpec[] = [
			{ title: "Agent", w: 0, flex: true },
			{ title: "", w: 20, drop: 4 },
			{ title: "Runs", w: 6, right: true },
			{ title: "Cost", w: 9, right: true },
			{ title: "Share", w: 5, right: true, drop: 2 },
			{ title: "$/run", w: 7, right: true },
			{ title: "Turns/run", w: 9, right: true, drop: 1 },
			{ title: "Fail", w: 5, right: true },
			{ title: "Top model", w: 22, drop: 3 },
		];
		const rows = list.map(([name, v], i) => [
			`${dot(color(i))} ${name}`,
			hbar(share(v[A.runs], maxRuns), 20, color(i)),
			int(v[A.runs]),
			money(v[A.cost]),
			pct(share(v[A.cost], a[A.cost]), 0),
			money(share(v[A.cost], v[A.runs])),
			share(v[A.turns], v[A.runs]).toFixed(1),
			share(v[A.failures], v[A.runs]) > 0.1 ? fg(BAD, pct(share(v[A.failures], v[A.runs]), 0)) : ink.dim(pct(share(v[A.failures], v[A.runs]), 0)),
			ink.dim(topModel(name)),
		]);
		out.push("", ...card(ink, { title: "Sub-agents", right: ink.dim(s.label), width, body: list.length ? table(ink, cols, rows, width - 4) : [ink.muted("No sub-agent runs in this range.")] }));

		const fan = [1, 2, 3, 4, 5].map((n) => {
			const count = n < 5 ? (s.fanout.get(n) ?? 0) : [...s.fanout].filter(([k]) => k >= 5).reduce((x, [, c]) => x + c, 0);
			return { label: n === 1 ? "1 agent" : n < 5 ? `${n} agents` : "5+ agents", value: count, text: int(count), color: rampAt(ctx.ramp, n / 5) };
		});
		const models = [...s.agentModels].sort((x, y) => y[1][A.cost] - x[1][A.cost]).slice(0, 8);
		const [w1] = split(width, 2);
		out.push("", ...cardRow(ink, width, [
			{ title: "Swarm size", right: ink.dim("agent calls per message"), body: bars(ink, fan, w1 - 4, 12) },
			{ title: "Agent models", right: ink.dim("by cost"), body: bars(ink, models.map(([m, v], i) => ({ label: modelOrDash(m), value: v[A.cost], text: `${money(v[A.cost])} · ${int(v[A.runs])}`, color: color(i) })), w1 - 4, 22) },
		]));
		out.push("", ...card(ink, {
			title: "You vs your agents",
			right: ink.dim(`${fg(C.teal, "■")} main  ${fg(AGENT, "■")} agents`),
			width,
			body: plot(ctx, (day) => {
				const d = s.daily.get(day)!;
				return [[C.teal, d.cost], [AGENT, d.agentCost]];
			}, width - 4, 8, { format: money }),
		}));
		return out;
	},
};

const COMMIT_TYPES = ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "style", "build", "ci"];

const projectsTab: Tab = {
	title: "Projects",
	hint: "commits: yours in each repo since its first session",
	render(ctx) {
		const { s, ds, ink, width } = ctx;
		const added = (x: Summary) => x.commits.reduce((n, c) => n + c.added, 0);
		const deleted = s.commits.reduce((x, c) => x + c.deleted, 0);
		const perPiCommit = (x: Summary) => rate(x.cost, x.piCommits);
		const linesPerDollar = (x: Summary) => rate(x.piLines, x.cost);
		const known = s.filter.provider === undefined;
		const out = tiles(ink, [
			{ label: "Projects", value: int(s.projects.filter((p) => p.sessions).length), sub: `${unscoped(ctx, int(s.projects.filter((p) => p.commits).length))} with commits`, color: C.blue, delta: vs(ctx, (x) => x.projects.filter((p) => p.sessions).length, "either") },
			{ label: "Commits", value: unscoped(ctx, int(s.commits.length)), sub: known ? `${int(s.piCommits)} with pi · ${int(s.taggedCommits)} tagged` : "no provider on commits", color: C.lime, delta: vsUnscoped(ctx, (x) => x.commits.length, "up") },
			{ label: "Lines added", value: unscoped(ctx, compact(added(s))), sub: `${unscoped(ctx, compact(deleted))} removed`, color: GOOD, delta: vsUnscoped(ctx, added, "either") },
			{ label: "Per pi commit", value: known && s.piCommits ? money(perPiCommit(s)) : "—", sub: "all spend ÷ pi commits", color: C.teal, delta: vsUnscoped(ctx, perPiCommit, "down") },
			{ label: "Lines per $", value: known && s.cost > 0 ? compact(linesPerDollar(s)) : "—", sub: "changed by pi commits", color: C.violet, delta: vsUnscoped(ctx, linesPerDollar, "up") },
		], width);
		const list = s.projects.filter((p) => p.cost >= 1 || p.commits > 0).slice(0, 15);
		const rest = s.projects.filter((p) => !list.includes(p));
		const max = Math.max(0, ...list.map((p) => p.cost));
		const cols: ColSpec[] = [
			{ title: "Project", w: 0, flex: true },
			{ title: "", w: 14, drop: 4 },
			{ title: "Cost", w: 9, right: true },
			{ title: "Sessions", w: 8, right: true, drop: 2 },
			{ title: "Days", w: 4, right: true, drop: 3 },
			{ title: "Commits", w: 7, right: true },
			{ title: "pi", w: 5, right: true },
			{ title: "+lines", w: 7, right: true, drop: 1 },
			{ title: "−lines", w: 7, right: true, drop: 1 },
			{ title: "$/commit", w: 8, right: true, drop: 2 },
			{ title: "Last", w: 10, right: true, drop: 3 },
		];
		const rows = list.map((p) => [
			`${dot(ctx.color(p.root))} ${p.name}`,
			hbar(share(p.cost, max), 14, ctx.color(p.root)),
			money(p.cost),
			int(p.sessions),
			int(p.activeDays),
			unscoped(ctx, int(p.commits)),
			unscoped(ctx, int(p.piCommits)),
			!known ? "—" : p.added ? fg(GOOD, compact(p.added)) : ink.dim("0"),
			!known ? "—" : p.deleted ? fg(BAD, compact(p.deleted)) : ink.dim("0"),
			known && p.piCommits ? money(p.cost / p.piCommits) : ink.dim("—"),
			ink.dim(p.lastMs ? relative(p.lastMs, ds.generatedAt) : "—"),
		]);
		const body = list.length ? table(ink, cols, rows, width - 4) : [ink.muted("Nothing in this range.")];
		if (rest.length) body.push(ink.dim(`  + ${rest.length} more, ${money(rest.reduce((x, p) => x + p.cost, 0))} together`));
		out.push("", ...card(ink, { title: "Projects", right: ink.dim(s.label), width, body }));

		const types = new Map<string, number>();
		for (const c of s.commits) {
			const t = c.subject.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
			const key = t && COMMIT_TYPES.includes(t) ? t : "other";
			types.set(key, (types.get(key) ?? 0) + 1);
		}
		const [w1] = split(width, 2);
		out.push("", ...(known
			? cardRow(ink, width, [
					{ title: "Commit types", body: bars(ink, [...types].sort((x, y) => y[1] - x[1]).map(([t, n], i) => ({ label: t, value: n, text: int(n), color: SERIES[i % SERIES.length] })), w1 - 4, 10) },
					{ title: "Commits per day", right: ink.dim(`${fg(C.lime, "■")} with pi  ${fg(OTHER, "■")} without`), body: plot(ctx, (day) => {
						const d = s.daily.get(day)!;
						return [[C.lime, d.piCommits], [OTHER, d.commits - d.piCommits]];
					}, w1 - 4, 8, { format: (v) => int(v) }) },
				])
			: card(ink, { title: "Commits", width, body: note(ink, "Commits carry no provider, so they are left out under a provider filter. The Models tab attributes tagged commits to the model that led each session.", width - 4) })));

		const top = s.sessions.slice(0, 12);
		const sessionCols: ColSpec[] = [
			{ title: "Session", w: 0, flex: true },
			{ title: "Project", w: 18, drop: 1 },
			{ title: "Cost", w: 9, right: true },
			{ title: "Turns", w: 6, right: true },
			{ title: "Agents", w: 6, right: true, drop: 2 },
			{ title: "Active", w: 8, right: true },
			{ title: "When", w: 10, right: true, drop: 1 },
		];
		out.push("", ...card(ink, {
			title: "Most expensive sessions",
			width,
			body: table(ink, sessionCols, top.map((x) => [
				sessionName(ctx, x),
				ink.dim(ds.projectName.get(x.project) ?? x.project),
				money(x.cost),
				int(x.turns),
				unscoped(ctx, int(x.agentRuns)),
				unscoped(ctx, duration(x.activeMs)),
				ink.dim(relative(x.lastMs, ds.generatedAt)),
			]), width - 4),
		}));
		return out;
	},
};

const rhythmTab: Tab = {
	title: "Rhythm",
	hint: "time with pi = wall-clock time with any session active (gaps over 10 min don't count)",
	render(ctx) {
		const { s, ink, width, streak } = ctx;
		const ph = peakHour(s);
		const weekendTurns = s.punch.slice(5).flat().reduce((a, b) => a + b, 0);
		const allTurns = s.punch.flat().reduce((a, b) => a + b, 0);
		const out = tiles(ink, [
			{ label: "Time with pi", value: unscoped(ctx, duration(s.activeMs)), sub: `${unscoped(ctx, duration(s.sessionMs))} of session time`, color: C.orange },
			{ label: "Parallelism", value: s.activeMs ? `${(s.sessionMs / s.activeMs).toFixed(2)}×` : "—", sub: "sessions running at once", color: C.violet },
			{ label: "Model time", value: duration(s.usage[U.durationMs]), sub: "waiting on replies", color: C.blue },
			{ label: "Peak hour", value: allTurns ? hourLabel(ph) : "—", sub: `${pct(turnsShare(s, ph, ph + 1), 0)} of turns`, color: C.amber },
			{ label: "Night owl", value: pct(turnsShare(s, 0, 5), 0), sub: "turns 00:00–05:00", color: C.indigo },
			{ label: "Weekends", value: pct(share(weekendTurns, allTurns), 0), sub: "of turns", color: C.rose },
			{ label: "Streak", value: `${streak.currentStreak} days`, sub: `best ${streak.longestStreak}`, color: GOOD },
			{ label: "Prompts", value: unscoped(ctx, int(s.prompts)), sub: unscoped(ctx, `${s.activeDays ? Math.round(s.prompts / s.activeDays) : 0}/day · ${s.prompts ? Math.round(s.promptChars / s.prompts) : 0} chars avg`), color: C.teal },
			{ label: "Goals done", value: unscoped(ctx, `${s.goalsDone}/${s.goalsSet}`), sub: `${unscoped(ctx, duration(s.goalSeconds * 1000))} of goal time`, color: C.lime },
			{ label: "Compactions", value: int(s.compactions), sub: s.compactionMax ? `largest ${compact(s.compactionMax)} tokens` : "", color: OTHER },
		], width);
		out.push("", ...card(ink, { title: "When you work", right: ink.dim("model turns by weekday and hour"), width, body: punchcard(ctx, width - 4) }));
		const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
		const [w1] = split(width, 2);
		const maxH = Math.max(0, ...s.hourlyCost);
		const hours = Array.from({ length: 24 }, (_, h) => [[rampAt(ctx.ramp, share(s.hourlyCost[h], maxH)), s.hourlyCost[h]]] as Array<[RGB, number]>);
		const cw = Math.max(1, Math.min(3, Math.floor((w1 - 5) / 24)));
		let labels = "";
		for (let h = 0; h < 24; h++) labels += pad(h % 6 === 0 ? String(h) : "", cw);
		const hourChart = [...columnChart(hours, 7, cw), ink.dim(labels)];
		out.push("", ...cardRow(ink, width, [
			{ title: "By weekday", right: ink.dim("cost"), body: bars(ink, names.map((n, i) => ({ label: n, value: s.weekdayCost[i], text: money(s.weekdayCost[i]), color: i >= 5 ? C.rose : C.teal })), w1 - 4, 5) },
			{ title: "By hour", right: ink.dim("cost"), body: hourChart },
		]));
		return out;
	},
};

interface Badge {
	name: string;
	about: string;
	progress: number;
	have: string;
}

function badges(ctx: Ctx): Badge[] {
	const { s, streak } = ctx;
	const known = s.filter.provider === undefined;
	const calls = [...s.tools.values()].reduce((a, t) => a + t[T.calls], 0);
	const errs = [...s.tools.values()].reduce((a, t) => a + t[T.errors], 0);
	const maxDayTokens = Math.max(0, ...[...s.daily.values()].map((d) => d.tokens));
	const longestSession = Math.max(0, ...s.sessions.map((x) => x.activeMs));
	const maxFan = Math.max(0, ...s.fanout.keys());
	const hit = cacheHit(s.usage);
	const errRate = share(errs, calls);
	const b = (name: string, about: string, value: number, target: number, have: string): Badge => ({ name, about, progress: Number.isFinite(value) ? Math.min(1, share(value, target)) : 0, have });
	return [
		b("Cache Lord", "95% cache hits", hit, 0.95, pct(hit)),
		b("Swarm Commander", "5 agents at once", maxFan, 5, `${maxFan}`),
		b("Billion-token Day", "1B in a day", maxDayTokens, 1e9, compact(maxDayTokens)),
		b("Streak Master", "30-day streak", streak.longestStreak, 30, `${streak.longestStreak}d`),
		b("Polyglot", "10 models", s.models.size, 10, `${s.models.size}`),
		...(known ? [b("Shipper", "100 pi commits", s.piCommits, 100, int(s.piCommits)), b("Goal Getter", "10 goals done", s.goalsDone, 10, `${s.goalsDone}`)] : []),
		b("Toolsmith", "100K tool calls", calls, 100_000, compact(calls)),
		b("Steady Hands", "< 2% tool errors", calls ? Math.min(1, 0.02 / Math.max(errRate, 1e-9)) : 0, 1, pct(errRate)),
		b("Night Owl", "20% of turns 0–5h", turnsShare(s, 0, 5), 0.2, pct(turnsShare(s, 0, 5), 0)),
		...(known
			? [b("Marathoner", "8h in one session", longestSession, 8 * 3_600_000, duration(longestSession)), b("Delegator", "1,000 agent runs", s.agentTotal[A.runs], 1000, int(s.agentTotal[A.runs]))]
			: []),
	];
}

/** The year at half-block resolution: two weekdays per terminal row. */
function miniYear(ctx: Ctx): string[] {
	const { year, ramp, metric } = ctx;
	const grade = dayGrader(year, metric);
	const color = (day: string | undefined): RGB | undefined => (day ? rampColor(ramp, grade(day)) : undefined);
	const cells: Array<string | undefined> = [...new Array(weekday(year.days[0])).fill(undefined), ...year.days];
	const weeks = Math.ceil(cells.length / 7);
	const out: string[] = [];
	for (let r = 0; r < 7; r += 2) {
		let line = "";
		for (let w = 0; w < weeks; w++) {
			const top = color(cells[w * 7 + r]);
			const bottom = r + 1 < 7 ? color(cells[w * 7 + r + 1]) : undefined;
			if (top && bottom) line += bg(bottom, fg(top, "▀"));
			else if (top) line += fg(top, "▀");
			else if (bottom) line += fg(bottom, "▄");
			else line += " ";
		}
		out.push(line);
	}
	return out;
}

const wrappedTab: Tab = {
	title: "Wrapped",
	hint: "your range, in one card · [ ] to change the range",
	render(ctx) {
		const { s, ink, width, planUsd } = ctx;
		const known = s.filter.provider === undefined;
		const w = Math.min(width, 100);
		const inner = w - 4;
		const body: string[] = [];
		const scope = filterLabel(ctx.ds, s.filter);
		body.push("", center(bold(gradientText("p i   w r a p p e d", C.teal, AGENT)), inner), center(ink.dim(scope ? `${s.label} · ${scope}` : s.label), inner), "");
		body.push(...tiles(ink, [
			{ label: "Spent (API prices)", value: money(s.cost), color: C.teal },
			{ label: "Tokens", value: compact(s.tokens), color: C.violet },
			{ label: "Time with pi", value: unscoped(ctx, duration(s.activeMs)), color: C.orange },
			{ label: "Commits", value: unscoped(ctx, int(s.commits.length)), color: C.lime },
		], inner, 16));
		body.push("");

		const models = [...s.models].sort((a, b) => b[1][U.cost] - a[1][U.cost]).slice(0, 3);
		const agents = [...s.agents].sort((a, b) => b[1][A.runs] - a[1][A.runs]).slice(0, 3);
		const projects = s.projects.filter((p) => p.cost > 0).slice(0, 3);
		const cw = split(inner, 3, 3);
		const list = (title: string, rows: Array<[string, string]>, width: number) => [
			ink.muted(title),
			...rows.map(([a, b], i) => spread(`${bold(fg(SERIES[i], String(i + 1)))} ${a}`, ink.dim(b), width)),
		];
		body.push(...hstack([
			list("Top models", models.map(([k, u]) => [modelLabel(k), money(u[U.cost])]), cw[0]),
			known ? list("Top agents", agents.map(([k, a]) => [k, `${int(a[A.runs])} runs`]), cw[1]) : [ink.muted("Top agents"), ink.dim("excluded by provider")],
			list("Top projects", projects.map((p) => [p.name, money(p.cost)]), cw[2]),
		], cw, 3));
		body.push("", ink.muted("Your year"), ...miniYear(ctx).map((l) => center(l, inner)), "");

		const busy = busiestDay(s);
		const written = s.usage[U.output] + s.agentTotal[A.output];
		const cached = s.usage[U.cacheRead] + s.agentTotal[A.cacheRead];
		const novels = (written * 0.75) / 90_000;
		const months = Math.max(s.days.length / 30.44, 1 / 30.44);
		const facts = [
			`The models wrote ${bold(compact(written))} tokens, about ${bold(novels.toFixed(novels >= 10 ? 0 : 1))} novels of text.`,
			`${bold(compact(cached))} tokens came back from cache: War and Peace, re-read ${bold(int(cached / 780_000))} times.`,
			`At API prices that is ${bold(`${(s.cost / (planUsd * months)).toFixed(1)}×`)} a $${planUsd}/month plan.`,
			known ? `Agents ran ${bold(int(s.agentTotal[A.runs]))} times and took ${bold(int(s.agentTotal[A.turns]))} turns for you.` : "",
			busy ? `Your biggest day was ${bold(longDate(busy[0]))}: ${bold(money(busy[1]))}.` : "",
			`${bold(pct(turnsShare(s, 0, 5), 0))} of your turns happened between midnight and 5am.`,
		].filter(Boolean);
		body.push(ink.muted("Fun facts"), ...facts.map((f) => `${fg(C.amber, "✦")} ${f}`), "");

		body.push(ink.muted("Badges"));
		const list2 = badges(ctx);
		const bw = split(inner, 2, 3);
		for (let i = 0; i < list2.length; i += 2) {
			const cell = (b: Badge | undefined, width: number) => {
				if (!b) return "";
				const earned = b.progress >= 1;
				const icon = earned ? fg(C.amber, "◆") : ink.dim("◇");
				const name = earned ? bold(ink.text(b.name)) : ink.muted(b.name);
				const meter = earned ? fg(GOOD, "earned") : `${hbar(b.progress, 8, rampAt(ctx.ramp, b.progress))} ${ink.dim(b.have)}`;
				return spread(`${icon} ${name} ${ink.dim(b.about)}`, meter, width);
			};
			body.push(hstack([[cell(list2[i], bw[0])], [cell(list2[i + 1], bw[1])]], bw, 3)[0]);
		}
		body.push("");
		const earned = list2.filter((b) => b.progress >= 1).length;
		const cardLines = card(ink, { title: "pi wrapped", right: fg(WHITE, `${earned}/${list2.length} badges`), width: w, body });
		const left = Math.floor((width - w) / 2);
		return cardLines.map((l) => " ".repeat(left) + l);
	},
};

export const TABS: Tab[] = [overview, timelineTab, modelsTab, cacheTab, toolsTab, agentsTab, projectsTab, rhythmTab, wrappedTab];
