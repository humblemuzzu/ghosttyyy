import { decodeKittyPrintable, Key, matchesKey, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@mariozechner/pi-tui";
import { addDays, burn, type Burn, type Dataset, type Filter, monthWindow, previousWindow, RANGES, type RangeId, rangeWindow, type Streaks, streaks, type Summary, summarize, summarizeWindow } from "./aggregate";
import { bg, bold, clampLines, fg, type Ink, pad, RAMPS, type RGB, spread } from "./draw";
import { TABS } from "./tabs";
import { type BustOrder, type Ctx, filterLabel, type Group, METRICS, type Metric, modelLabel, seriesColors } from "./widgets";

const HEADER_ROWS = 3;
const FOOTER_ROWS = 1;
const PILL_BG: RGB = [80, 73, 69];
const AGENTS_NOTE = "agents excluded under a provider filter";

export interface ViewOptions {
	planUsd: number;
	/** `provider/model` → context window, from pi's model registry. */
	windows: Map<string, number>;
	budget?: number;
	range?: RangeId;
}

function terminalRows(): number {
	const rows = process.stdout.rows;
	return typeof rows === "number" && rows > 0 ? rows : 40;
}

/** The item after `current` in `list`, wrapping to undefined after the last. */
function cycle(list: string[], current: string | undefined): string | undefined {
	return list[current === undefined ? 0 : list.indexOf(current) + 1];
}

export class StatsView {
	private tab = 0;
	private range: number;
	private metric: Metric = "cost";
	private ramp = 0;
	private skyline = false;
	private group: Group = "model";
	private bustOrder: BustOrder = "cost";
	private filter: Filter = {};
	private cursor: string;
	private scroll = new Map<number, number>();
	private summaries = new Map<string, Summary>();
	private streakCache = new Map<string, Streaks>();
	private month?: Burn;
	private cache?: { key: string; lines: string[] };
	/** Clickable header cells: row, first column, end column, action. */
	private hits: Array<[number, number, number, () => void]> = [];

	constructor(
		private readonly ds: Dataset,
		private readonly ink: Ink,
		private readonly opts: ViewOptions,
		private readonly done: () => void,
	) {
		this.cursor = ds.today;
		this.range = Math.max(0, RANGES.findIndex((r) => r.id === (opts.range ?? "30d")));
	}

	private filterKey(): string {
		return `${this.filter.project ?? ""}\t${this.filter.provider ?? ""}`;
	}

	private memo(key: string, make: () => Summary): Summary {
		const full = `${key}\t${this.filterKey()}`;
		let s = this.summaries.get(full);
		if (!s) this.summaries.set(full, (s = make()));
		return s;
	}

	private summary(id: RangeId): Summary {
		return this.memo(id, () => summarize(this.ds, id, this.filter));
	}

	private previous(id: RangeId): Summary | undefined {
		if (id === "all") return undefined;
		return this.memo(`prev:${id}`, () => summarizeWindow(this.ds, previousWindow(rangeWindow(this.ds, id)), this.filter));
	}

	private streak(): Streaks {
		if (this.filter.project === undefined && this.filter.provider === undefined) return this.ds.lifetime;
		let st = this.streakCache.get(this.filterKey());
		if (!st) {
			const all = this.summary("all");
			this.streakCache.set(this.filterKey(), (st = streaks(new Set(all.days.filter((d) => all.daily.get(d)!.turns > 0)), this.ds.today)));
		}
		return st;
	}

	private monthToDate(): Burn {
		this.month ??= burn(summarizeWindow(this.ds, monthWindow(this.ds.today)).cost, this.ds.today, this.opts.budget);
		return this.month;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private change(fn: () => void): void {
		fn();
		this.invalidate();
	}

	private scrollBy(n: number): void {
		this.change(() => this.scroll.set(this.tab, Math.max(0, (this.scroll.get(this.tab) ?? 0) + n)));
	}

	private moveCursor(days: number): void {
		const next = addDays(this.cursor, days);
		if (next > this.ds.today || next < addDays(this.ds.today, -370)) return;
		this.change(() => (this.cursor = next));
	}

	private setRange(i: number): void {
		this.change(() => (this.range = (i + RANGES.length) % RANGES.length));
	}

	private setFilter(next: Filter): void {
		this.change(() => {
			this.filter = next;
			this.scroll.clear();
		});
	}

	handleInput(raw: string): void {
		const data = decodeKittyPrintable(raw) ?? raw;
		const page = Math.max(1, terminalRows() - HEADER_ROWS - FOOTER_ROWS - 2);
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.done();
		if (matchesKey(data, Key.tab)) return this.change(() => (this.tab = (this.tab + 1) % TABS.length));
		if (matchesKey(data, Key.shift("tab"))) return this.change(() => (this.tab = (this.tab + TABS.length - 1) % TABS.length));
		if (/^[1-9]$/.test(data) && Number(data) <= TABS.length) return this.change(() => (this.tab = Number(data) - 1));
		if (data === "]" || data === "r") return this.setRange(this.range + 1);
		if (data === "[" || data === "R") return this.setRange(this.range - 1);
		if (data === "m") return this.change(() => (this.metric = METRICS[(METRICS.indexOf(this.metric) + 1) % METRICS.length]));
		if (data === "c") return this.change(() => (this.ramp = (this.ramp + 1) % RAMPS.length));
		if (data === "v") return this.change(() => (this.skyline = !this.skyline));
		if (data === "g") return this.change(() => (this.group = this.group === "model" ? "project" : "model"));
		if (data === "t") return this.change(() => (this.cursor = this.ds.today));
		if (data === "b") return this.change(() => (this.bustOrder = this.bustOrder === "cost" ? "recent" : "cost"));
		if (data === "p") return this.setFilter({ ...this.filter, project: cycle(this.ds.lifetime.projectRank, this.filter.project) });
		if (data === "P") return this.setFilter({ ...this.filter, project: undefined });
		if (data === "o") return this.setFilter({ ...this.filter, provider: cycle(this.ds.lifetime.providerRank, this.filter.provider) });
		if (data === "O") return this.setFilter({ ...this.filter, provider: undefined });

		const onOverview = this.tab === 0;
		if (onOverview && (matchesKey(data, Key.left) || data === "h")) return this.moveCursor(-7);
		if (onOverview && (matchesKey(data, Key.right) || data === "l")) return this.moveCursor(7);
		if (onOverview && matchesKey(data, Key.up)) return this.moveCursor(-1);
		if (onOverview && matchesKey(data, Key.down)) return this.moveCursor(1);
		if (matchesKey(data, Key.left)) return this.setRange(this.range - 1);
		if (matchesKey(data, Key.right)) return this.setRange(this.range + 1);
		if (matchesKey(data, Key.up) || data === "k") return this.scrollBy(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.scrollBy(1);
		if (matchesKey(data, Key.pageUp) || data === "u") return this.scrollBy(-page);
		if (matchesKey(data, Key.pageDown) || data === "d" || data === " ") return this.scrollBy(page);
		if (matchesKey(data, Key.home)) return this.change(() => this.scroll.set(this.tab, 0));
		if (matchesKey(data, Key.end)) return this.scrollBy(1e6);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.scrollBy(event.wheelDelta * 2);
			return { handled: true };
		}
		if (event.type === "press" && event.button === "left") {
			const hit = this.hits.find(([row, a, b]) => event.y === row && event.x >= a && event.x < b);
			if (hit) {
				hit[3]();
				return { handled: true };
			}
		}
		return undefined;
	}

	private header(width: number, s: Summary): string[] {
		const ink = this.ink;
		const pill = (text: string, on: boolean) => (on ? bg(PILL_BG, bold(fg([250, 240, 220], ` ${text} `))) : ink.muted(` ${text} `));
		const ranges = RANGES.map((r, i) => pill(r.id, i === this.range)).join("");
		const brand = `${bold(ink.accent("◆ pi stats"))}  ${ink.dim(`${s.label} · ${this.ds.records.length.toLocaleString("en-US")} sessions on disk`)}`;
		this.hits = [];
		let x = width - visibleWidth(ranges);
		RANGES.forEach((r, i) => {
			this.hits.push([0, x, x + r.id.length + 2, () => this.setRange(i)]);
			x += r.id.length + 2;
		});
		let tabs = "";
		TABS.forEach((t, i) => {
			const label = `${i + 1} ${t.title}`;
			const start = visibleWidth(tabs);
			tabs += pill(label, i === this.tab) + " ";
			this.hits.push([1, start, start + visibleWidth(label) + 2, () => this.change(() => (this.tab = i))]);
		});
		const scope = filterLabel(this.ds, this.filter);
		const lead = scope ? `${ink.border("── ")}${ink.accent(`filter: ${scope}`)}${this.filter.provider !== undefined ? ink.dim(` · ${AGENTS_NOTE}`) : ""} ` : "";
		return [spread(brand, ranges, width), tabs, lead + ink.border("─".repeat(Math.max(0, width - visibleWidth(lead))))];
	}

	/** One tab's body at `width`, without the header and footer. */
	tabLines(tab: number, width: number): string[] {
		const s = this.summary(RANGES[this.range].id);
		const ctx: Ctx = {
			ds: this.ds,
			s,
			prev: this.previous(RANGES[this.range].id),
			year: this.summary("1y"),
			streak: this.streak(),
			burn: this.monthToDate(),
			windows: this.opts.windows,
			width: Math.max(40, width - 2),
			ink: this.ink,
			metric: this.metric,
			ramp: RAMPS[this.ramp],
			skyline: this.skyline,
			group: this.group,
			cursor: this.cursor,
			bustOrder: this.bustOrder,
			planUsd: this.opts.planUsd,
			color: seriesColors(s),
			label: (k) => (this.ds.projectName.get(k) ?? modelLabel(k)),
		};
		return TABS[tab].render(ctx).map((l) => ` ${l}`);
	}

	render(width: number): string[] {
		const rows = terminalRows();
		const key = `${width}x${rows}`;
		if (this.cache?.key === key) return this.cache.lines;

		const s = this.summary(RANGES[this.range].id);
		const tab = TABS[this.tab];
		const body = this.tabLines(this.tab, width);
		const viewport = Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS);
		const maxScroll = Math.max(0, body.length - viewport);
		const scroll = Math.min(this.scroll.get(this.tab) ?? 0, maxScroll);
		this.scroll.set(this.tab, scroll);

		const visible = body.slice(scroll, scroll + viewport);
		while (visible.length < viewport) visible.push("");
		const position = maxScroll ? ` ${Math.round((scroll / maxScroll) * 100)}%` : "";
		const filtered = this.filter.project !== undefined || this.filter.provider !== undefined;
		const keys = `tab/1-9 view · ${this.tab === 0 ? "[ ]" : "←→"} range · p/o filter${filtered ? " · P/O clear" : ""} · j/k scroll · q close`;
		const footer = spread(this.ink.dim(` ${tab.hint}`), this.ink.dim(`${keys}${position} `), width);
		const lines = clampLines([...this.header(width, s), ...visible, footer], width);
		this.cache = { key, lines: lines.map((l) => (visibleWidth(l) < width ? pad(l, width) : l)) };
		return this.cache.lines;
	}
}
