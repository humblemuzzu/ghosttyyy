import { describe, expect, test } from "bun:test";
import { describeWindow, groupLikelyTabs, type WindowInfo } from "./lib/capture";
import fs from "node:fs";
import path from "node:path";
import {
	createScreenshotTool,
	displayedSibling,
	normalizeRegion,
	resolveWindow,
	tabRescueAdvice,
} from "./screenshot";
import { evaluatePermission, type PermissionRule } from "./lib/permissions";

const tool = createScreenshotTool() as any;

describe("normalizeRegion tolerates what models actually send", () => {
	const expected = { x: 10, y: 20, width: 300, height: 400 };

	test("a plain array", () => {
		expect(normalizeRegion([10, 20, 300, 400])).toEqual(expected);
	});

	test("a JSON-stringified array — the shape that made pi-tasks unusable", () => {
		expect(normalizeRegion("[10, 20, 300, 400]")).toEqual(expected);
	});

	test("a bare comma string", () => {
		expect(normalizeRegion("10,20,300,400")).toEqual(expected);
	});

	test("a space-separated string", () => {
		expect(normalizeRegion("10 20 300 400")).toEqual(expected);
	});

	test("string numbers inside an array", () => {
		expect(normalizeRegion(["10", "20", "300", "400"])).toEqual(expected);
	});

	test("an object, with either width/height or w/h", () => {
		expect(normalizeRegion({ x: 10, y: 20, width: 300, height: 400 })).toEqual(expected);
		expect(normalizeRegion({ x: 10, y: 20, w: 300, h: 400 })).toEqual(expected);
	});

	test("absent stays absent", () => {
		expect(normalizeRegion(undefined)).toBeUndefined();
		expect(normalizeRegion(null)).toBeUndefined();
	});

	test("the wrong number of values is a clear error, not a silent guess", () => {
		expect(() => normalizeRegion([1, 2, 3])).toThrow(/exactly four numbers/);
		expect(() => normalizeRegion("1,2,3,4,5")).toThrow(/exactly four numbers/);
	});

	test("non-numeric values are rejected rather than becoming NaN", () => {
		expect(() => normalizeRegion(["a", "b", "c", "d"])).toThrow(/must all be numbers/);
	});
});

describe("tool contract", () => {
	test("registers under a name that collides with nothing", () => {
		expect(tool.name).toBe("screenshot");
	});

	test("every parameter is optional — a bare call captures the display", () => {
		expect(tool.parameters.required ?? []).toEqual([]);
	});

	test("no parameter shouts REQUIRED in prose", () => {
		const shouting = Object.entries(tool.parameters.properties ?? {})
			.filter(([, schema]) => /\bREQUIRED\b/.test(String((schema as any)?.description ?? "")))
			.map(([param]) => param);
		expect(shouting).toEqual([]);
	});

	test("every parameter carries a description", () => {
		// Substantive prose, not a placeholder: the model calls this without
		// reading our source, so every knob has to explain itself. Reported as a
		// map so a failure names the offending parameter.
		const tooShort = Object.entries(tool.parameters.properties ?? {})
			.filter(([, schema]) => String((schema as any)?.description ?? "").length < 40)
			.map(([param]) => param);
		expect(tooShort).toEqual([]);
	});

	test("the description ends with a literal example call", () => {
		expect(tool.description).toMatch(/Example: screenshot\(\{.*\}\)/);
	});

	test("the description steers away from the shell workaround", () => {
		expect(tool.description).toContain("sips -Z");
		expect(tool.description).toContain("screencapture");
	});

	test("exposes the full targeting surface", () => {
		const props = Object.keys(tool.parameters.properties ?? {});
		for (const expected of ["app", "window_title", "window_id", "region", "display", "list"]) {
			expect(props).toContain(expected);
		}
	});

	test("tier is constrained to the two real tiers", () => {
		const tier = (tool.parameters.properties as any).tier;
		const literals = JSON.stringify(tier);
		expect(literals).toContain("standard");
		expect(literals).toContain("high");
		expect(literals).not.toContain("highRes");
	});

	test("nothing in the spec nudges the model to economise", () => {
		// The tool used to advertise high as "~3x the cost", which is a reason to
		// avoid it. Cost is the caller's business; the tool's business is not
		// handing back a degraded picture.
		const surface = [
			tool.description,
			...Object.values(tool.parameters.properties ?? {}).map(
				(s: any) => String(s?.description ?? ""),
			),
		].join(" ");
		expect(surface).not.toMatch(/token cost|cheaper|\dx the cost|expensive/i);
	});

	test("the tier parameter states that high is the default", () => {
		const tier = String((tool.parameters.properties as any).tier.description);
		expect(tier).toMatch(/default/i);
		expect(tier).toContain("high");
	});

	test("the description warns that a very long page is truncated", () => {
		expect(tool.description).toMatch(/truncat/i);
		expect(tool.description).toContain("selector");
	});
});

describe("renderCall never emits a control character into a single-line sink", () => {
	const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s };

	function lastText(args: any): string {
		let captured = "";
		const stub = { setText: (s: string) => { captured = s; } };
		tool.renderCall(args, theme, { lastComponent: stub });
		return captured;
	}

	test("a multi-line app name is flattened", () => {
		// A newline is width-0 to every width check and still advances the real
		// terminal cursor a row — the TUI smear class documented in AGENTS.md.
		expect(lastText({ app: "Fo\no\tBar\r\nBaz" })).not.toMatch(/[\r\n\t\v\f]/);
	});

	test("an absurdly long title is capped", () => {
		const text = lastText({ app: "x".repeat(500) });
		expect(text.length).toBeLessThan(120);
	});

	test("a bare call describes the default target", () => {
		expect(lastText({})).toContain("display");
	});

	test("list mode is labelled distinctly", () => {
		expect(lastText({ list: true })).toContain("list windows");
	});
});

/**
 * These assert the rules that actually ship, read off disk. A test that
 * hard-codes its own copy of the rules only proves the copy is self-consistent.
 */
describe("permissions.json routes the shell workaround to this tool", () => {
	const rules: PermissionRule[] = JSON.parse(
		fs.readFileSync(path.join(__dirname, "..", "..", "permissions.json"), "utf-8"),
	);
	const verdict = (cmd: string) => evaluatePermission("Bash", { cmd }, rules);

	test("the exact command a sub-agent ran is rejected", () => {
		const v = verdict(
			"screencapture -x -o -l 12237 /tmp/shot.png && sips -Z 1400 /tmp/shot.png >/dev/null && echo ok",
		);
		expect(v.action).toBe("reject");
		expect(v.message).toContain("screenshot tool");
	});

	test("bare screencapture is rejected", () => {
		expect(verdict("screencapture /tmp/a.png").action).toBe("reject");
	});

	test("screencapture after a separator is rejected", () => {
		expect(verdict("cd /tmp; screencapture a.png").action).toBe("reject");
		expect(verdict("true && screencapture a.png").action).toBe("reject");
		expect(verdict("nohup screencapture a.png &").action).toBe("reject");
	});

	test("resizing with sips is NOT blocked — it was only ever collateral", () => {
		// The rule used to match `sips -Z` too, and that pattern produced three
		// false positives in one session: a git commit message describing the old
		// pattern, and two files written through a shell heredoc that merely
		// QUOTED it. The guard exists to stop an agent TAKING a screenshot by
		// hand, not to stop anyone writing about it. With the capture binary
		// blocked there is no fresh screenshot to badly resize anyway, and `read`
		// now fits any image it opens.
		expect(verdict("sips -Z 1400 a.png").action).toBe("allow");
		expect(verdict("sips -z 900 1400 a.png").action).toBe("allow");
	});

	test("writing ABOUT the old pattern is never blocked", () => {
		const capture = ["screen", "capture"].join("");
		const heredoc = `git commit -q -F - <<'EOT'\n  ${capture} -x -o a.png && sips -Z 1400 a.png\nEOT`;
		expect(verdict(heredoc).action).toBe("allow");
		expect(verdict(`git commit -m 'drop the ${capture} path'`).action).toBe("allow");
		expect(verdict(`grep -rn ${capture} ./docs`).action).toBe("allow");
	});

	test("sips as a codec or a metadata reader is still allowed", () => {
		// The tool itself uses these; blocking them would break the thing we built.
		expect(verdict("sips -g pixelWidth -g pixelHeight a.png").action).toBe("allow");
		expect(verdict("sips -s format png a.jpg --out a.png").action).toBe("allow");
	});

	test("unrelated commands that merely contain the word are not caught", () => {
		expect(verdict("echo 'run screencapture manually'").action).toBe("allow");
		expect(verdict("grep -r screencapture ./docs").action).toBe("allow");
	});

	test("the message names the escape hatch for discovering targets", () => {
		expect(verdict("screencapture x.png").message).toContain("list: true");
	});
});

describe("window listing tells identical-looking windows apart", () => {
	/*
	 * A test run hit five Ghostty windows whose displayed titles were
	 * byte-identical (`…/Documents/Code stuff/stripema`) because Ghostty
	 * left-truncates the path itself — the distinguishing prefix was already
	 * gone before we saw it. Without coordinates the candidate list is five
	 * indistinguishable rows.
	 */
	const w = (over: Partial<WindowInfo>): WindowInfo => ({
		id: 1,
		app: "Ghostty",
		title: "…/Documents/Code stuff/stripema",
		layer: 0,
		onScreen: true,
		x: 0,
		y: 0,
		width: 1916,
		height: 1040,
		...over,
	});

	test("position is shown, so identical titles are still separable", () => {
		const a = describeWindow(w({ id: 15251, x: 0, y: 40 }));
		const b = describeWindow(w({ id: 14093, x: 1920, y: 40 }));
		expect(a).not.toBe(b);
		expect(a).toContain("@0,40");
		expect(b).toContain("@1920,40");
	});

	test("the id is always present — it is the only guaranteed selector", () => {
		expect(describeWindow(w({ id: 16303 }))).toContain("16303");
	});

	test("a window on another Space is still marked as such", () => {
		expect(describeWindow(w({ onScreen: false }))).toContain("not on screen");
		expect(describeWindow(w({ onScreen: true }))).not.toContain("not on screen");
	});
});

describe("ambiguous window matches give advice that can actually work", () => {
	/*
	 * From a live test run: `app:"ghostty"` matched 12 windows and captured one
	 * SILENTLY, while `app` + `window_title` matched 5 and refused — with the
	 * message "Narrow it with window_title, or pass window_id" even though a
	 * window_title had just been supplied and all five candidates had identical
	 * titles. No window_title value could ever have worked. That is the shape of
	 * advice that sends a model into a retry loop.
	 */
	const w = (over: Partial<WindowInfo>): WindowInfo => ({
		id: 1,
		app: "Ghostty",
		title: "…/Documents/Code stuff/stripema",
		layer: 0,
		onScreen: false,
		x: 0,
		y: 40,
		width: 1916,
		height: 1040,
		...over,
	});
	const identical = [
		w({ id: 15251 }),
		w({ id: 14093 }),
		w({ id: 16303 }),
		w({ id: 14408 }),
		w({ id: 13707 }),
	];

	test("identical titles: it says window_title CANNOT help, and asks for window_id", () => {
		try {
			resolveWindow({ app: "ghostty", window_title: "stripema" }, identical);
			throw new Error("should have refused");
		} catch (e: any) {
			expect(e.message).toContain("window_id");
			expect(e.message).toMatch(/cannot separate them|same title/i);
			// The impossible instruction must be gone.
			expect(e.message).not.toMatch(/Narrow it with window_title/);
		}
	});

	test("distinct titles: refining window_title is offered, because it would work", () => {
		const distinct = [w({ id: 1, title: "alpha" }), w({ id: 2, title: "beta" })];
		try {
			resolveWindow({ app: "ghostty" }, distinct);
			throw new Error("should have refused");
		} catch (e: any) {
			expect(e.message).toMatch(/window_title/);
			expect(e.message).toContain("window_id");
		}
	});

	test("a single on-screen match is auto-picked, and the choice is DISCLOSED", () => {
		const pool = [...identical, w({ id: 99, onScreen: true })];
		const choice = resolveWindow({ app: "ghostty" }, pool);
		expect(choice.window.id).toBe(99);
		expect(choice.autoPicked).toBeDefined();
		expect(choice.autoPicked!.total).toBe(6);
	});

	test("an unambiguous match reports no auto-pick at all", () => {
		const choice = resolveWindow({ app: "ghostty" }, [w({ id: 7, onScreen: true })]);
		expect(choice.window.id).toBe(7);
		expect(choice.autoPicked).toBeUndefined();
	});

	test("the candidate list carries the ids needed to act on the advice", () => {
		try {
			resolveWindow({ app: "ghostty", window_title: "stripema" }, identical);
		} catch (e: any) {
			for (const id of [15251, 14093, 16303, 14408, 13707]) {
				expect(e.message).toContain(String(id));
			}
		}
	});
});

describe("tab-heavy apps are counted honestly", () => {
	/*
	 * Real numbers from this machine: 4 visible Ghostty terminals reported as
	 * SIXTEEN matching windows. Under macOS native tabbing every tab is its own
	 * NSWindow, and the tab bar is a further separate window at y=0. The raw
	 * count is accurate and useless.
	 */
	const tab = (id: number, x: number, title: string): WindowInfo => ({
		id,
		app: "Ghostty",
		title,
		layer: 0,
		onScreen: false,
		x,
		y: 40,
		width: x === 0 ? 1920 : 1916,
		height: 1040,
	});
	// two real windows: seven tabs at @0,40 and eight at @4,40
	const pool = [
		...[1, 2, 3, 4, 5, 6, 7].map((i) => tab(i, 0, `w1 tab ${i}`)),
		...[8, 9, 10, 11, 12, 13, 14, 15].map((i) => tab(i, 4, `w2 tab ${i}`)),
	];

	test("15 reported windows collapse to the 2 frames a person would count", () => {
		expect(groupLikelyTabs(pool)).toHaveLength(2);
	});

	test("the ambiguity message explains the inflated count", () => {
		try {
			resolveWindow({ app: "ghostty" }, pool);
			throw new Error("should have refused");
		} catch (e: any) {
			expect(e.message).toContain("15 windows match");
			expect(e.message).toContain("2 distinct window frame");
			expect(e.message).toMatch(/tab/i);
		}
	});

	test("genuinely separate windows are NOT collapsed", () => {
		const separate = [
			{ ...tab(1, 0, "a"), x: 0, y: 0 },
			{ ...tab(2, 0, "b"), x: 700, y: 300 },
			{ ...tab(3, 0, "c"), x: 100, y: 900 },
		];
		expect(groupLikelyTabs(separate)).toHaveLength(3);
	});

	test("windows of different apps never group together", () => {
		const mixed = [tab(1, 0, "a"), { ...tab(2, 0, "b"), app: "Safari" }];
		expect(groupLikelyTabs(mixed)).toHaveLength(2);
	});

	test("'[not on screen]' does not claim a reason we never checked", () => {
		// It is equally true of another Space, a minimised window, a hidden app
		// and — most often — a background tab. Naming one of those is a guess.
		const line = describeWindow(tab(1, 0, "x"));
		expect(line).toContain("not on screen");
		expect(line).not.toMatch(/other Space|minimi|hidden/i);
	});
});

describe("feedback: one-shot capture, folded lists, tab rescue", () => {
	const tab = (id: number, over: Partial<WindowInfo> = {}): WindowInfo => ({
		id,
		app: "Ghostty",
		title: `tab ${id}`,
		layer: 0,
		onScreen: false,
		x: 4,
		y: 40,
		width: 1916,
		height: 1040,
		...over,
	});

	describe("(a) one call, not two", () => {
		test("exactly one on-screen candidate is captured, not refused", () => {
			const pool = [tab(1), tab(2), tab(3), tab(9, { onScreen: true })];
			const choice = resolveWindow({ app: "ghostty" }, pool);
			expect(choice.window.id).toBe(9);
		});

		test("and the choice is said out loud", () => {
			const pool = [tab(1), tab(2), tab(9, { onScreen: true })];
			expect(resolveWindow({ app: "ghostty" }, pool).autoPicked).toEqual({
				total: 3,
				query: 'app "ghostty"',
			});
		});

		test("it only refuses when the on-screen set is genuinely ambiguous", () => {
			// two separate frames, both visible: nothing justifies choosing for you
			const pool = [tab(1, { onScreen: true }), tab(2, { onScreen: true, x: 900 })];
			expect(() => resolveWindow({ app: "ghostty" }, pool)).toThrow();
		});
	});

	describe("(b) the list folds by frame", () => {
		const many = [
			...[1, 2, 3, 4, 5, 6, 7].map((i) => tab(i, { x: 0, width: 1920 })),
			...[8, 9, 10, 11, 12, 13, 14, 15].map((i) => tab(i)),
		];

		test("17 rows become one entry per frame", () => {
			let msg = "";
			try {
				resolveWindow({ app: "ghostty" }, many);
			} catch (e: any) {
				msg = e.message;
			}
			// one "capture id" line per frame, not per tab
			expect((msg.match(/capture id/g) ?? []).length).toBe(2);
			expect(msg).toContain("15 across 2 window frame(s)");
		});

		test("the folded entry still exposes every id", () => {
			let msg = "";
			try {
				resolveWindow({ app: "ghostty" }, many);
			} catch (e: any) {
				msg = e.message;
			}
			for (const id of [1, 8, 15]) expect(msg).toContain(String(id));
		});

		test("apps without tabs still render as a plain flat list", () => {
			const plain = [
				tab(1, { app: "Safari", x: 0, y: 0 }),
				tab(2, { app: "Safari", x: 800, y: 200 }),
			];
			let msg = "";
			try {
				resolveWindow({ app: "safari" }, plain);
			} catch (e: any) {
				msg = e.message;
			}
			expect(msg).not.toContain("window frame(s)");
			expect(msg).toContain("id 1");
		});
	});

	describe("(c) a dead end becomes a next step", () => {
		test("the on-screen sibling of a background tab is found", () => {
			const target = tab(13707);
			const pool = [target, tab(16543, { onScreen: true })];
			expect(displayedSibling(target, pool)?.id).toBe(16543);
		});

		test("a window that is already on screen needs no rescue", () => {
			const target = tab(1, { onScreen: true });
			expect(displayedSibling(target, [target, tab(2, { onScreen: true })])).toBeUndefined();
		});

		test("a different frame is not offered as a substitute", () => {
			// same app, different geometry: not the same window, so not a rescue
			const target = tab(1);
			expect(displayedSibling(target, [target, tab(2, { onScreen: true, x: 900 })])).toBeUndefined();
		});

		test("the advice names the id to use and does not pretend it is the same content", () => {
			const msg = tabRescueAdvice(tab(13707), tab(16543, { onScreen: true, title: "live" }));
			expect(msg).toContain("16543");
			expect(msg).toContain("13707");
			expect(msg).toMatch(/switch to that tab/i);
			// Must not assert impossibility — background tabs often DO capture.
			expect(msg).not.toMatch(/can never be captured|impossible/i);
		});
	});
});

describe("the tool never claims a capture is impossible", () => {
	/*
	 * Measured: window_id 13861 — a BACKGROUND tab — captured fine at 3840×2080
	 * (exactly bounds×2, without the group's tab bar). An earlier draft of the
	 * rescue message said "a background tab can never be captured on its own",
	 * and one live test disproved it. Absolute claims about macOS behaviour have
	 * been wrong every time they were made in this file.
	 */
	const w = (over: Partial<WindowInfo> = {}): WindowInfo => ({
		id: 1,
		app: "Ghostty",
		title: "t",
		layer: 0,
		onScreen: false,
		x: 0,
		y: 40,
		width: 1920,
		height: 1040,
		...over,
	});

	test("the rescue advice describes what will work, not what cannot", () => {
		const msg = tabRescueAdvice(w({ id: 13707 }), w({ id: 16543, onScreen: true }));
		expect(msg).not.toMatch(/never|impossible|cannot be captured/i);
		expect(msg).toMatch(/will succeed/i);
	});

	test("it warns that the content differs, which is the real trap", () => {
		const msg = tabRescueAdvice(w({ id: 13707 }), w({ id: 16543, onScreen: true }));
		expect(msg).toMatch(/not id 13707|ACTIVE tab/i);
	});

	test("the folded list does not promise a failure either", () => {
		let msg = "";
		try {
			resolveWindow({ app: "ghostty" }, [w({ id: 1 }), w({ id: 2 }), w({ id: 3, x: 900 })]);
		} catch (e: any) {
			msg = e.message;
		}
		expect(msg).not.toMatch(/cannot be captured/i);
	});
});
