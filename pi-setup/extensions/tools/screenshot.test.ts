import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createScreenshotTool, normalizeRegion } from "./screenshot";
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

	test("sips -Z and -z are both rejected", () => {
		expect(verdict("sips -Z 1400 a.png").action).toBe("reject");
		expect(verdict("sips -z 900 1400 a.png").action).toBe("reject");
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
