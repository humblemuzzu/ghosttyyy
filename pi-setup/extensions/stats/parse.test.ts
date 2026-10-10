import { describe, expect, test } from "bun:test";
import { agentDetails, assistant, entry, header, MIN, record, toolResult, user } from "./fixtures";
import { A, commandWord, dayKey, T, U } from "./parse";

const T0 = new Date(2026, 5, 10, 9, 0).getTime();
const DAY = dayKey(T0);
const MODEL = "anthropic/claude-opus-5-5";

describe("ingestLine", () => {
	const rec = record([
		header("s1", "/work/app", T0),
		entry("model_change", T0, { provider: "anthropic", modelId: "claude-opus-5-5" }),
		entry("thinking_level_change", T0, { thinkingLevel: "high" }),
		user(T0 + 1000, "fix the login bug\nwith details"),
		assistant(T0 + 2000, {
			input: 10,
			output: 100,
			cacheWrite: 30_000,
			cost: 1,
			durationMs: 4000,
			calls: [
				{ name: "bash", arguments: { cmd: "cd x && FOO=1 bun test --watch | tee out" } },
				{ name: "apply_patch", arguments: { path: "src/a.ts" } },
			],
		}),
		toolResult(T0 + 3000, "bash", { isError: true, durationMs: 1500 }),
		assistant(T0 + 4000, { cacheRead: 30_000, cacheWrite: 100, cost: 0.5, calls: [{ name: "chad" }, { name: "chad" }] }),
		toolResult(T0 + 5000, "chad", {
			details: agentDetails("chad", 0.5, {
				messages: [
					{ role: "assistant", content: [] },
					{ role: "toolResult", toolName: "read", isError: false },
					{ role: "toolResult", toolName: "finder", isError: false, details: agentDetails("finder", 0.25, { exitCode: 1, model: "claude-haiku-4-5" }) },
				],
			}),
		}),
		entry("custom", T0 + 6000, { customType: "pi-codex-goal", data: { goal: { goalId: "g1", status: "complete", usage: { activeSeconds: 90 } } } }),
		entry("session_info", T0 + 7000, { name: "login fix" }),
	]);

	test("main turns land in one day/model/thinking bucket", () => {
		const u = rec.usage[`${DAY}\t${MODEL}\thigh`];
		expect(u[U.turns]).toBe(2);
		expect(u[U.cost]).toBe(1.5);
		expect(u[U.cacheRead]).toBe(30_000);
		expect(u[U.timedOutput]).toBe(100);
		expect(u[U.durationMs]).toBe(4000);
	});

	test("sub-agent spend comes from details.usage, nested runs included", () => {
		const chad = rec.agents[`${DAY}\tchad\tdeepseek-flash`];
		const finder = rec.agents[`${DAY}\tfinder\tclaude-haiku-4-5`];
		expect(chad[A.runs]).toBe(1);
		expect(chad[A.cost]).toBe(0.5);
		expect(chad[A.turns]).toBe(4);
		expect(finder[A.cost]).toBe(0.25);
		expect(finder[A.failures]).toBe(1);
	});

	test("tools split into main and agent scope", () => {
		expect(rec.tools[`${DAY}\tmain\tanthropic\tbash`][T.errors]).toBe(1);
		expect(rec.tools[`${DAY}\tmain\tanthropic\tbash`][T.durationMs]).toBe(1500);
		expect(rec.tools[`${DAY}\tmain\tanthropic\tchad`][T.calls]).toBe(1);
		expect(rec.tools[`${DAY}\tagent\t\tread`][T.calls]).toBe(1);
		expect(rec.tools[`${DAY}\tagent\t\tfinder`][T.calls]).toBe(1);
	});

	test("commands, edits, fan-out, goals, prompts and names", () => {
		expect(rec.bash[`${DAY}\tanthropic\tbun test`]).toBe(1);
		expect(rec.edits[`${DAY}\tanthropic\t/work/app/src/a.ts`]).toBe(1);
		expect(rec.fanout[`${DAY}\tanthropic\t2`]).toBe(1);
		expect(rec.hours[`${DAY}\t9\tanthropic`]).toEqual([2, 1.5]);
		expect(rec.goals.g1.slice(0, 2)).toEqual(["complete", 90]);
		expect(rec.prompts[DAY][0]).toBe(1);
		expect(rec.title).toBe("fix the login bug");
		expect(rec.name).toBe("login fix");
	});

	test("one active span while events stay within 10 minutes", () => {
		expect(rec.spans).toEqual([[T0 + 1000, T0 + 5000]]);
	});

	test("every main turn's context is kept per day and model", () => {
		expect(rec.contexts[`${DAY}\t${MODEL}`]).toEqual([30_010, 30_100]);
	});
});

test("a tool result belongs to the provider of the turn that called it", () => {
	const rec = record([
		header("p", "/w", T0),
		assistant(T0, { provider: "openai", model: "gpt-6", calls: [{ name: "bash", arguments: { cmd: "ls" } }] }),
		toolResult(T0 + 1, "bash"),
		assistant(T0 + 2, { calls: [{ name: "read" }] }),
		toolResult(T0 + 3, "read"),
	]);
	expect(Object.keys(rec.tools).sort()).toEqual([`${DAY}\tmain\tanthropic\tread`, `${DAY}\tmain\topenai\tbash`]);
	expect(rec.bash[`${DAY}\topenai\tls`]).toBe(1);
});

describe("forks", () => {
	const lines = (parent: string) => [
		header("fork", "/w", T0 + 10 * MIN, parent),
		assistant(T0, { cost: 1 }),
		assistant(T0 + 11 * MIN, { cost: 2 }),
	];

	test("the copied prefix is skipped while the parent file exists", () => {
		const rec = record(lines("/sessions/parent.jsonl"), "/s/f.jsonl", () => true);
		expect(rec.usage[`${DAY}\t${MODEL}\tunknown`][U.cost]).toBe(2);
	});

	test("the copy is the only record once the parent is gone", () => {
		const rec = record(lines("/sessions/parent.jsonl"), "/s/f.jsonl", () => false);
		expect(rec.usage[`${DAY}\t${MODEL}\tunknown`][U.cost]).toBe(3);
	});
});

describe("cache busts", () => {
	const rec = record([
		header("b", "/w", T0),
		assistant(T0, { cacheWrite: 50_000 }),
		assistant(T0 + 2 * MIN, { cacheRead: 50_000, cacheWrite: 1000 }),
		assistant(T0 + 12 * MIN, { cacheWrite: 52_000, costCacheWrite: 3 }),
		assistant(T0 + 13 * MIN, { cacheWrite: 53_000, costCacheWrite: 4 }),
		entry("compaction", T0 + 14 * MIN, { tokensBefore: 53_000, summary: "", firstKeptEntryId: "x" }),
		assistant(T0 + 15 * MIN, { cacheWrite: 20_000 }),
		assistant(T0 + 16 * MIN, { model: "claude-sonnet-5-5", cacheWrite: 20_000 }),
	]);
	const u = rec.usage[`${DAY}\t${MODEL}\tunknown`];

	test("a rewrite of a warm context is a bust; past the TTL it is idle", () => {
		expect(u[U.busts]).toBe(2);
		expect(u[U.idleBusts]).toBe(1);
		expect(u[U.bustCost]).toBe(7);
	});

	test("the turn after a compaction and a model switch never count", () => {
		expect(rec.usage[`${DAY}\tanthropic/claude-sonnet-5-5\tunknown`][U.busts]).toBe(0);
		expect(rec.compactions).toEqual([[T0 + 14 * MIN, 53_000, MODEL]]);
	});

	test("each bust is kept as an event with its context, rewrite cost and gap", () => {
		expect(rec.busts).toEqual([
			[T0 + 12 * MIN, MODEL, 52_000, 3, 10 * MIN, true],
			[T0 + 13 * MIN, MODEL, 53_000, 4, MIN, false],
		]);
	});

	test("a fork's copied prefix records no bust events", () => {
		const fork = record(
			[header("f", "/w", T0 + 20 * MIN, "/s/parent.jsonl"), assistant(T0, { cacheWrite: 50_000 }), assistant(T0 + 12 * MIN, { cacheWrite: 52_000 })],
			"/s/f.jsonl",
			() => true,
		);
		expect(fork.busts).toEqual([]);
		expect(fork.contexts).toEqual({});
	});
});

test("a turn with no usage is never a cache bust", () => {
	const rec = record([header("z", "/w", T0), assistant(T0, { cacheWrite: 50_000 }), assistant(T0 + MIN, { stopReason: "error" })]);
	expect(rec.usage[`${DAY}\t${MODEL}\tunknown`][U.busts]).toBe(0);
});

test("an errored turn without usage still counts", () => {
	const rec = record([header("e", "/w", T0), assistant(T0, { stopReason: "error" }), assistant(T0 + 1, { stopReason: "aborted" })]);
	const u = rec.usage[`${DAY}\t${MODEL}\tunknown`];
	expect(u[U.turns]).toBe(2);
	expect(u[U.errors]).toBe(1);
	expect(u[U.aborted]).toBe(1);
});

test("commandWord finds the command that actually ran", () => {
	expect(commandWord("cd /x && git status")).toBe("git status");
	expect(commandWord('"/Volumes/Macintosh HD/bin/tool" --flag')).toBe("tool");
	expect(commandWord("for f in *.ts; do grep -n x $f; done")).toBe("grep");
	expect(commandWord("echo ---; ls -la")).toBe("ls");
	expect(commandWord("NODE_ENV=test time bun run build")).toBe("bun run");
	expect(commandWord("git -C repo log")).toBe("git");
	expect(commandWord("cd x")).toBeUndefined();
});
