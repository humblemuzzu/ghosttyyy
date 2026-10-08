import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { FullOutput } from "./full-output";

describe("FullOutput", () => {
	test("small output stays in memory and writes no file", () => {
		const full = new FullOutput(1024);
		full.add("hello\n");
		expect(full.finish()).toEqual({ output: "hello\n", truncated: false });
	});

	test("past the spill threshold everything, earlier chunks included, lands in a 0600 file", () => {
		const full = new FullOutput(8);
		full.add("first-");
		full.add("second-third");
		const done = full.finish();
		expect(done.output).toBe("first-second-third");
		expect(readFileSync(done.path!, "utf8")).toBe("first-second-third");
		expect((statSync(done.path!).mode & 0o777).toString(8)).toBe("600");
	});

	test("the file stops at its cap and says so instead of filling the disk", () => {
		const full = new FullOutput(4, 10);
		full.add("0123456789abcdef");
		full.add("more");
		const done = full.finish();
		expect(done.capped).toBe(true);
		expect(done.truncated).toBe(true);
		expect(statSync(done.path!).size).toBe(10);
		expect(done.output).toBe("0123456789");
	});

	test("asking to spill before any output creates an empty file, not an error", () => {
		const full = new FullOutput();
		const file = full.spill();
		expect(existsSync(file!)).toBe(true);
		expect(full.finish()).toMatchObject({ output: "", truncated: false });
	});
});
