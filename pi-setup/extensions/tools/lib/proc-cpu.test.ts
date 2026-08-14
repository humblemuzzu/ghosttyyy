/**
 * proc-cpu parsing tests — the pure half of the CPU liveness signal.
 *
 * the sampler itself shells out to `ps` and is exercised by the real-process
 * tests in bash-timeout.test.ts; here we pin the parsing, because a wrong parse
 * would silently feed the watchdog a bad number. every degenerate input must
 * return `undefined` (= "no signal, fall back to stdout-only"), never a wrong
 * value that could keep a corpse alive or kill a worker.
 */

import { describe, expect, test } from "bun:test";
import { cpuTimeToSeconds, parseGroupCpuSeconds } from "./proc-cpu";

describe("cpuTimeToSeconds", () => {
	test("M:SS.ss (short process)", () => {
		expect(cpuTimeToSeconds("0:01.01")).toBeCloseTo(1.01, 2);
		expect(cpuTimeToSeconds("0:03.02")).toBeCloseTo(3.02, 2);
		expect(cpuTimeToSeconds("2:30.00")).toBeCloseTo(150, 2);
	});

	test("H:MM:SS.ss (hour-plus process)", () => {
		expect(cpuTimeToSeconds("1:00:00.00")).toBeCloseTo(3600, 2);
		expect(cpuTimeToSeconds("54:20.56")).toBeCloseTo(54 * 60 + 20.56, 2);
	});

	test("DD-HH:MM:SS.ss (multi-day)", () => {
		expect(cpuTimeToSeconds("2-01:00:00.00")).toBeCloseTo(2 * 86400 + 3600, 2);
	});

	test("whitespace is tolerated", () => {
		expect(cpuTimeToSeconds("  0:05.00 ")).toBeCloseTo(5, 2);
	});

	test("garbage returns undefined, never a wrong number", () => {
		for (const junk of ["", "   ", "abc", "1:2:3:4", "x:yy", "-", "1-"]) {
			expect(cpuTimeToSeconds(junk)).toBeUndefined();
		}
	});
});

describe("parseGroupCpuSeconds", () => {
	// a realistic `ps -o pgid=,cputime= -ax` slice: two groups interleaved.
	const ps = [
		"    1   54:20.56",
		"  467    0:00.69",
		"60577    0:01.50", // our group
		"60577    0:02.25", // our group (a child — shares the leader's pgid)
		"60590    0:09.99", // someone else
		"60577    0:00.25", // our group (the pipe)
	].join("\n");

	test("sums only the matching process group", () => {
		expect(parseGroupCpuSeconds(ps, 60577)).toBeCloseTo(1.5 + 2.25 + 0.25, 2);
	});

	test("a group with one process", () => {
		expect(parseGroupCpuSeconds(ps, 467)).toBeCloseTo(0.69, 2);
	});

	test("a group that has fully exited returns undefined, NOT 0", () => {
		// the distinction is load-bearing: 0 would read as "idle, kill it", but
		// the group is simply gone (already reaped) — no signal to act on.
		expect(parseGroupCpuSeconds(ps, 99999)).toBeUndefined();
	});

	test("empty ps output returns undefined", () => {
		expect(parseGroupCpuSeconds("", 60577)).toBeUndefined();
	});

	test("malformed rows are skipped, not counted as zero", () => {
		const messy = "not a row\n60577  garbage\n60577  0:02.00\n";
		expect(parseGroupCpuSeconds(messy, 60577)).toBeCloseTo(2.0, 2);
	});

	test("a pgid substring does not false-match (60577 vs 6057)", () => {
		expect(parseGroupCpuSeconds(ps, 6057)).toBeUndefined();
	});
});
