import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@mariozechner/pi-tui";
import { prepare } from "./aggregate";
import { plainInk } from "./draw";
import { agentDetails, assistant, entry, header, MIN, record, toolResult, user } from "./fixtures";
import { TABS } from "./tabs";
import { StatsView, type ViewOptions } from "./view";

const NOW = Date.now();
const DAY_MS = 86_400_000;
const lines = [header("r", "/repo/x", NOW - 90 * MIN), user(NOW - 90 * MIN, "a prompt with a ⚡ wide glyph and 日本語")];
for (let i = 0; i < 40; i++) {
	lines.push(
		assistant(NOW - 89 * MIN + i * MIN, {
			cost: i * 0.1,
			input: 10 * i,
			output: 50,
			cacheRead: 1000 * i,
			cacheWrite: 30_000,
			durationMs: 2000,
			thinkingLevel: i % 2 ? "high" : "low",
			model: i % 3 ? "claude-opus-5-5" : "claude-sonnet-5-5",
			calls: [{ name: "bash", arguments: { cmd: "git status" } }, { name: "chad" }],
		}),
		toolResult(NOW - 89 * MIN + i * MIN + 1000, i % 4 ? "bash" : "chad", { details: i % 4 ? undefined : agentDetails("chad", 0.2), durationMs: 300 }),
	);
}
lines.push(entry("compaction", NOW - 40 * MIN, { tokensBefore: 180_000 }));
const earlier = NOW - 9 * DAY_MS;
const other = record(
	[
		header("o", "/repo/y", earlier),
		user(earlier, "older work"),
		assistant(earlier + MIN, { provider: "openai", model: "gpt-6", cost: 3, input: 5000, cacheWrite: 60_000 }),
		assistant(earlier + 30 * MIN, { provider: "openai", model: "gpt-6", cost: 1, cacheWrite: 61_000 }),
	],
	"/sessions/o.jsonl",
);
const git = {
	roots: new Map([
		["/repo/x", "/repo/x"],
		["/repo/y", "/repo/y"],
	]),
	commits: [
		{ hash: "a", ms: NOW - 60 * MIN, root: "/repo/x", added: 5, deleted: 1, subject: "feat: a", sessionId: "r" },
		{ hash: "b", ms: earlier + 2 * MIN, root: "/repo/y", added: 2, deleted: 0, subject: "fix: b", sessionId: "o" },
	],
};
const full = prepare([record(lines), other], git, NOW);
const empty = prepare([], { commits: [], roots: new Map() }, NOW);
const OPTS: ViewOptions = { planUsd: 200, windows: new Map([["anthropic/claude-opus-5-5", 200_000]]), budget: 500 };

const KEYS = ["]", "]", "]", "]", "]", "m", "m", "c", "v", "g", "b"];
const FILTERS = [[], ["p"], ["o"], ["p", "o"], ["o", "o"]];

const fits = (view: StatsView, width: number) => {
	for (const line of view.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toMatch(/NaN|undefined|Infinity/);
	}
};

describe("every tab fits every width", () => {
	for (const [name, ds] of [["data", full], ["empty", empty]] as const) {
		for (const width of [40, 60, 80, 120, 200, 260]) {
			test(`${name} at ${width} columns, with filters and comparisons`, () => {
				for (const filter of FILTERS) {
					const view = new StatsView(ds, plainInk, OPTS, () => {});
					for (const key of filter) view.handleInput(key);
					for (let tab = 1; tab <= TABS.length; tab++) {
						view.handleInput(String(tab));
						for (const key of ["", ...KEYS]) {
							if (key) view.handleInput(key);
							fits(view, width);
						}
					}
				}
			});
		}
	}
});

const top = (view: StatsView) => view.render(120).slice(0, 2).join("\n");
const text = (view: StatsView) => stripTerminalSequences(view.render(200).join("\n"));
const press = (x: number, y: number) =>
	({ type: "press", button: "left", x, y, screenX: x, screenY: y, width: 120, height: 40, shift: false, alt: false, ctrl: false }) as const;

test("kitty-encoded keys change the range like plain ones", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	expect(top(view)).toContain("Last 30 days");
	view.handleInput("\x1b[93u");
	expect(top(view)).toContain("Last 90 days");
	view.handleInput("2");
	view.handleInput("\x1b[D");
	expect(top(view)).toContain("Last 30 days");
});

test("range pills and tabs are clickable", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	const [brand, tabs] = view.render(120);
	const column = (line: string, t: string) => visibleWidth(line.slice(0, line.indexOf(t)));
	expect(view.handleMouse(press(column(brand, " all ") + 1, 0))?.handled).toBe(true);
	expect(top(view)).toContain("Lifetime");
	view.handleMouse(press(column(tabs, "4 Cache"), 1));
	expect(view.render(120).join("\n")).toContain("Hit rate by day");
});

test("the view fills the terminal height exactly", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	expect(view.render(120)).toHaveLength(process.stdout.rows || 40);
});

test("filters show in the header and footer, and a provider filter says agents are out", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	expect(text(view)).not.toContain("filter:");
	view.handleInput("p");
	expect(text(view)).toContain("filter: project x");
	expect(text(view)).toContain("P/O clear");
	view.handleInput("o");
	expect(text(view)).toContain("filter: project x · provider anthropic · agents excluded under a provider filter");
	view.handleInput("6");
	expect(text(view)).toContain("excluded under a provider filter");
	view.handleInput("P");
	view.handleInput("\x1b[111:79;2u");
	expect(text(view)).not.toContain("filter:");
});

test("tiles compare against the previous window, and lifetime has nothing to compare", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	expect(text(view)).toContain("$84.00 new");
	view.handleInput("[");
	expect(text(view)).toContain("$80.00 ▲>999%");
	view.handleInput("]");
	view.handleInput("]");
	view.handleInput("]");
	view.handleInput("]");
	expect(top(view)).toContain("Lifetime");
	expect(text(view)).not.toMatch(/[▲▼]|\bnew\b/);
});

test("the month card labels spend, budget and the linear projection", () => {
	const out = text(new StatsView(full, plainInk, OPTS, () => {}));
	expect(out).toContain("This month · API-price spend");
	expect(out).toContain("Month to date");
	expect(out).toContain("Linear projection");
	expect(out).toContain("$500");
});

test("models tab shows the leaderboard, context pressure against known windows, and busts are listed", () => {
	const view = new StatsView(full, plainInk, OPTS, () => {});
	view.handleInput("3");
	const models = view.render(260).join("\n");
	expect(models).toContain("Led commits");
	expect(models).toContain("Context pressure");
	expect(models).toMatch(/opus-5-5\s+200K/);
	expect(models).toMatch(/sonnet-5-5\s+—/);
	view.handleInput("]");
	view.handleInput("4");
	expect(view.render(260).join("\n")).toContain("Cache busts");
});
