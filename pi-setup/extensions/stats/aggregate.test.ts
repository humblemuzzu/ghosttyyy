import { describe, expect, test } from "bun:test";
import { addDays, burn, cacheSavings, dayCount, monthWindow, percentile, prepare, previousWindow, rangeWindow, summarize, summarizeWindow } from "./aggregate";
import { delta, GOOD, plainInk, relChange, WARN } from "./draw";
import { agentDetails, assistant, entry, header, MIN, record, toolResult, user } from "./fixtures";
import type { Commit } from "./git";
import { parseLog } from "./git";
import { A, dayKey, U, U_LEN } from "./parse";

const NOW = new Date(2026, 5, 10, 18, 0).getTime();
const TODAY = dayKey(NOW);
const at = (daysAgo: number, hour: number, minute = 0) => {
	const d = new Date(NOW);
	d.setDate(d.getDate() - daysAgo);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
};

const a = record(
	[
		header("sess-a", "/repo/app", at(0, 9)),
		user(at(0, 9), "build it"),
		assistant(at(0, 9, 1), { cost: 2, input: 100, cacheRead: 900, costInput: 0.001, costCacheRead: 0.0009 }),
		toolResult(at(0, 9, 2), "delegate", { details: agentDetails("delegate", 3) }),
		assistant(at(0, 9, 8), { cost: 1 }),
	],
	"/s/a.jsonl",
);
const b = record(
	[header("sess-b", "/repo/app/sub", at(0, 9, 5)), user(at(0, 9, 5), "side quest"), assistant(at(0, 9, 10), { cost: 4 })],
	"/s/b.jsonl",
);
const old = record([header("sess-c", "/elsewhere", at(1, 12)), user(at(1, 12), "yesterday"), assistant(at(1, 12, 5), { cost: 8 })], "/s/c.jsonl");
const ancient = record([header("sess-d", "/elsewhere", at(40, 12)), assistant(at(40, 12), { cost: 16 })], "/s/d.jsonl");

const commit = (ms: number, extra: Partial<Commit> = {}): Commit => ({ hash: `h${ms}`, ms, root: "/repo/app", added: 10, deleted: 2, subject: "feat: x", ...extra });
const git = {
	roots: new Map([
		["/repo/app", "/repo/app"],
		["/repo/app/sub", "/repo/app"],
	]),
	commits: [commit(at(0, 9, 10)), commit(at(0, 14), { sessionId: "sess-a" }), commit(at(0, 16))],
};
const ds = prepare([a, b, old, ancient], git, NOW);

describe("summarize", () => {
	const s = summarize(ds, "7d");

	test("total spend is main turns plus sub-agent runs, inside the range only", () => {
		expect(s.usage[U.cost]).toBe(15);
		expect(s.cost).toBe(18);
		expect(summarize(ds, "all").cost).toBe(34);
		expect(s.days).toHaveLength(7);
		expect(s.days[6]).toBe(TODAY);
	});

	test("cwds inside one repo roll up to one project", () => {
		const app = s.projects.find((p) => p.root === "/repo/app")!;
		expect(app.sessions).toBe(2);
		expect(app.cost).toBe(10);
		expect(app.commits).toBe(3);
	});

	test("time with pi is the union of overlapping sessions", () => {
		expect(s.daily.get(TODAY)!.activeMs).toBe(10 * MIN);
		expect(s.activeMs).toBe(10 * MIN + 5 * MIN);
		expect(s.sessionMs).toBe(8 * MIN + 5 * MIN + 5 * MIN);
	});

	test("a commit is a pi commit when tagged or made during a session in that repo", () => {
		expect(s.piCommits).toBe(2);
		expect(s.taggedCommits).toBe(1);
		expect(s.piLines).toBe(24);
	});

	test("streaks count back from today", () => {
		expect(ds.lifetime.currentStreak).toBe(2);
		expect(ds.lifetime.longestStreak).toBe(2);
		expect(ds.lifetime.firstDay).toBe(addDays(TODAY, -40));
	});
});

test("cache savings price reads at the model's own input rate", () => {
	const u = new Array(U_LEN).fill(0);
	u[U.input] = 1000;
	u[U.costInput] = 0.005;
	u[U.cacheRead] = 10_000;
	u[U.costCacheRead] = 0.005;
	u[U.cacheWrite] = 2000;
	u[U.costCacheWrite] = 0.0125;
	const { saved, premium } = cacheSavings(new Map([["m", u]]));
	expect(saved).toBeCloseTo(0.045, 10);
	expect(premium).toBeCloseTo(0.0025, 10);
});

test("parseLog keeps your commits and tagged ones, with line counts", () => {
	const log = [
		"\x1eaaa\x1f1700000000\x1fme@x.dev\x1ffeat: one\x1f\n\n 2 files changed, 10 insertions(+), 3 deletions(-)",
		"\x1ebbb\x1f1700000100\x1fother@x.dev\x1ffix: theirs\x1f\n",
		"\x1eccc\x1f1700000200\x1fbot@x.dev\x1fchore: tagged\x1fsess-1\n\n 1 file changed, 1 insertion(+)",
	].join("\n");
	const commits = parseLog("/r", log, new Set(["me@x.dev"]));
	expect(commits.map((c) => c.hash)).toEqual(["aaa", "ccc"]);
	expect(commits[0]).toMatchObject({ added: 10, deleted: 3, ms: 1_700_000_000_000 });
	expect(commits[1].sessionId).toBe("sess-1");
});

describe("comparison windows", () => {
	test("the previous window has the same length and ends the day before", () => {
		expect(previousWindow({ start: "2026-06-04", end: "2026-06-10" })).toEqual({ start: "2026-05-28", end: "2026-06-03" });
		expect(previousWindow({ start: "2026-03-01", end: "2026-03-31" })).toEqual({ start: "2026-01-29", end: "2026-02-28" });
		expect(dayCount({ start: "2026-03-01", end: "2026-03-31" })).toBe(31);
		expect(dayCount(rangeWindow(ds, "7d"))).toBe(7);
	});

	test("the prior window is summarised with the same rules", () => {
		expect(summarizeWindow(ds, previousWindow(rangeWindow(ds, "7d"))).cost).toBe(0);
		const prev30 = summarizeWindow(ds, previousWindow(rangeWindow(ds, "30d")));
		expect(prev30.cost).toBe(16);
		expect(prev30.days).toHaveLength(30);
	});

	test("a zero base is 'new', never Infinity; no data on either side is '—'", () => {
		expect(relChange(5, 0)).toBe("new");
		expect(relChange(0, 0)).toBeUndefined();
		expect(relChange(12, 10)).toBeCloseTo(0.2, 10);
		expect(relChange(-1, 10)).toBeUndefined();
		expect(delta(plainInk, 5, 0, "down")).toContain("new");
		expect(delta(plainInk, 0, 0, "down")).toBe("—");
		expect(delta(plainInk, 5, undefined, "down")).toBe("");
		expect(delta(plainInk, 0.95, Number.NaN, "up", true)).toBe("—");
		expect(delta(plainInk, 10, 10, "up")).toBe("±0%");
		expect(delta(plainInk, 5000, 1, "either")).toBe("▲>999%");
	});

	test("each metric picks which direction is good", () => {
		const warn = `38;2;${WARN.join(";")}`;
		const good = `38;2;${GOOD.join(";")}`;
		expect(delta(plainInk, 12, 10, "down")).toContain(warn);
		expect(delta(plainInk, 12, 10, "down")).toContain("▲20%");
		expect(delta(plainInk, 8, 10, "down")).toContain(good);
		expect(delta(plainInk, 0.95, 0.9, "up", true)).toContain(good);
		expect(delta(plainInk, 0.95, 0.9, "up", true)).toContain("▲5.0pp");
		expect(delta(plainInk, 12, 10, "either")).toBe("▲20%");
	});
});

describe("filters and commit attribution", () => {
	const p = record(
		[
			header("sess-p", "/repo/app", at(0, 10)),
			user(at(0, 10), "work"),
			assistant(at(0, 10, 1), { cost: 5, input: 1000, cacheWrite: 40_000 }),
			assistant(at(0, 10, 2), { provider: "openai", model: "gpt-6", cost: 2, input: 500 }),
			toolResult(at(0, 10, 3), "delegate", { details: agentDetails("delegate", 3) }),
		],
		"/s/p.jsonl",
	);
	const q = record([header("sess-q", "/other", at(0, 11)), assistant(at(0, 11, 1), { provider: "openai", model: "gpt-6", cost: 7, input: 70_000 })], "/s/q.jsonl");
	const tie = record(
		[header("sess-t", "/other", at(0, 12)), assistant(at(0, 12, 1), { cost: 1 }), assistant(at(0, 12, 2), { provider: "openai", model: "gpt-6", cost: 1 }), assistant(at(0, 12, 3), { provider: "openai", model: "gpt-6", cost: 0 })],
		"/s/t.jsonl",
	);
	const fds = prepare([p, q, tie], {
		roots: new Map([
			["/repo/app", "/repo/app"],
			["/other", "/other"],
		]),
		commits: [
			commit(at(0, 10, 4), { sessionId: "sess-p" }),
			commit(at(0, 10, 5)),
			commit(at(0, 11, 2), { root: "/other", sessionId: "sess-q" }),
			commit(at(0, 12, 4), { root: "/other", sessionId: "sess-t" }),
			commit(at(0, 12, 5), { root: "/other", sessionId: "not-a-session" }),
		],
	}, NOW);

	test("a tagged commit goes to the model with the largest main-session cost; ties go to the one with more turns", () => {
		expect(fds.leadModel.get("sess-p")).toBe("anthropic/claude-opus-5-5");
		expect(fds.leadModel.get("sess-t")).toBe("openai/gpt-6");
		const s = summarize(fds, "7d");
		expect(Object.fromEntries(s.modelCommits)).toEqual({ "anthropic/claude-opus-5-5": 1, "openai/gpt-6": 2 });
		expect(s.commits).toHaveLength(5);
	});

	test("a project filter keeps that repo's sessions, agents and commits", () => {
		const s = summarize(fds, "7d", { project: "/repo/app" });
		expect(s.cost).toBe(10);
		expect(s.agentTotal[A.cost]).toBe(3);
		expect(s.commits).toHaveLength(2);
		expect(Object.fromEntries(s.modelCommits)).toEqual({ "anthropic/claude-opus-5-5": 1 });
		expect(s.activeMs).toBe(3 * MIN);
	});

	test("a provider filter keeps its main turns and excludes agents, commits, prompts and time", () => {
		const s = summarize(fds, "7d", { provider: "openai" });
		expect(s.cost).toBe(10);
		expect(s.usage[U.turns]).toBe(4);
		expect(s.agentTotal[A.cost]).toBe(0);
		expect(s.agents.size).toBe(0);
		expect(s.commits).toHaveLength(0);
		expect(s.prompts).toBe(0);
		expect(s.activeMs).toBe(0);
		expect([...s.providers.keys()]).toEqual(["openai"]);
		expect(Object.fromEntries(s.modelCommits)).toEqual({ "openai/gpt-6": 2 });
		expect(fds.lifetime.providerRank).toEqual(["openai", "anthropic"]);
	});

	test("context per turn, per-session peaks and percentiles follow the filter", () => {
		const s = summarize(fds, "7d");
		expect(s.contexts.get("openai/gpt-6")).toEqual([500, 70_000]);
		expect(s.sessions.find((x) => x.id === "sess-p")).toMatchObject({ peakContext: 41_000, peakModel: "anthropic/claude-opus-5-5" });
		expect(summarize(fds, "7d", { provider: "openai" }).sessions.find((x) => x.id === "sess-p")?.peakContext).toBe(500);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
		expect(percentile([7], 0.99)).toBe(7);
		expect(percentile([], 0.5)).toBeUndefined();
	});
});

test("bust events carry their session and are dropped by a provider filter", () => {
	const rec = record(
		[
			header("sess-b", "/repo/app", at(0, 8)),
			entry("session_info", at(0, 8), { name: "busty" }),
			assistant(at(0, 8), { cacheWrite: 50_000 }),
			assistant(at(0, 8, 20), { cacheWrite: 51_000, costCacheWrite: 0.6 }),
			entry("compaction", at(0, 8, 21), { tokensBefore: 51_000 }),
		],
		"/s/b.jsonl",
	);
	const bds = prepare([rec], { roots: new Map(), commits: [] }, NOW);
	const s = summarize(bds, "7d");
	expect(s.busts).toHaveLength(1);
	expect(s.busts[0]).toMatchObject({ context: 51_000, cost: 0.6, gapMs: 20 * MIN, idle: true, model: "anthropic/claude-opus-5-5" });
	expect(s.busts[0].session.name).toBe("busty");
	expect(s.busts[0].session.project).toBe("/repo/app");
	expect(s.compactionTokens.get("anthropic/claude-opus-5-5")).toEqual([51_000]);
	expect(summarize(bds, "7d", { provider: "openai" }).busts).toHaveLength(0);
});

describe("budget burn", () => {
	test("projection is month to date ÷ days elapsed × days in the month", () => {
		expect(burn(100, "2026-06-10", 500)).toEqual({ spent: 100, elapsed: 10, daysInMonth: 30, projection: 300, budget: 500 });
		expect(burn(29, "2028-02-29").projection).toBe(29);
		expect(burn(10, "2026-02-01").projection).toBe(280);
		expect(burn(31, "2026-12-31").projection).toBe(31);
		expect(burn(0, "2026-01-01").projection).toBe(0);
	});

	test("month to date starts on the 1st, local time", () => {
		expect(monthWindow("2026-06-10")).toEqual({ start: "2026-06-01", end: "2026-06-10" });
		const lastOfMay = new Date(2026, 4, 31, 23, 30).getTime();
		const firstOfJune = new Date(2026, 5, 1, 0, 30).getTime();
		const recs = [record([header("m1", "/w", lastOfMay), assistant(lastOfMay, { cost: 4 })], "/s/m1.jsonl"), record([header("m2", "/w", firstOfJune), assistant(firstOfJune, { cost: 6 })], "/s/m2.jsonl")];
		const mds = prepare(recs, { roots: new Map(), commits: [] }, NOW);
		expect(summarizeWindow(mds, monthWindow(mds.today)).cost).toBe(6);
	});
});
