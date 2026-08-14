/**
 * watchdog decision tests.
 *
 * this is the sleep-guard logic that both bash.ts (idle command kill) and
 * pi-spawn.ts (stalled sub-agent kill) run on every tick. it is pure precisely
 * so the lid-close case can be asserted, because that case is otherwise
 * unreachable: it needs a machine suspend, and the consequence of getting it
 * wrong is killing a healthy process at the moment the user starts watching.
 */

import { describe, expect, test } from "bun:test";
import { watchdogTickMs, watchdogVerdict } from "./watchdog";

const WINDOW = 300_000; // 5 min
const SLEEP = 60_000; // 1 min

describe("watchdogVerdict — normal operation", () => {
	test("waits while the window has not elapsed", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 10_000, now - 1_000, WINDOW, SLEEP)).toBe("wait");
		expect(watchdogVerdict(now, now - 10_000, now - 299_000, WINDOW, SLEEP)).toBe("wait");
	});

	test("kills exactly at the window, not a tick later", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 10_000, now - WINDOW, WINDOW, SLEEP)).toBe("kill");
	});

	test("kills past the window", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 10_000, now - WINDOW - 5_000, WINDOW, SLEEP)).toBe("kill");
	});

	test("one millisecond short of the window still waits", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 10_000, now - WINDOW + 1, WINDOW, SLEEP)).toBe("wait");
	});

	test("activity in this tick resets nothing by itself — the caller stamps", () => {
		// lastActive == now is the freshest possible state
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 10_000, now, WINDOW, SLEEP)).toBe("wait");
	});
});

describe("watchdogVerdict — the sleep guard", () => {
	test("a tick delta at the sleep threshold reports slept", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - SLEEP, now - 1_000, WINDOW, SLEEP)).toBe("slept");
	});

	test("a lid-close (3 hours) reports slept, NOT kill", () => {
		const now = 1_000_000_000;
		const threeHours = 3 * 60 * 60 * 1000;
		// both conditions are true: the tick jumped 3h AND there has been 3h of
		// silence. this is the exact 3am scenario, and it must not kill.
		expect(watchdogVerdict(now, now - threeHours, now - threeHours, WINDOW, SLEEP)).toBe("slept");
	});

	test("sleep wins over kill — order is load-bearing", () => {
		const now = 1_000_000;
		// silence far beyond the window, but the tick delta proves the clock jumped
		const verdict = watchdogVerdict(now, now - SLEEP - 1, now - WINDOW * 10, WINDOW, SLEEP);
		expect(verdict).toBe("slept");
		expect(verdict).not.toBe("kill");
	});

	test("an ordinary scheduler delay below the threshold does NOT read as sleep", () => {
		const now = 1_000_000;
		// 59s late: extreme, but a loaded machine could do it. must still be a real
		// verdict, or a busy machine silently disables the watchdog.
		expect(watchdogVerdict(now, now - (SLEEP - 1_000), now - WINDOW, WINDOW, SLEEP)).toBe("kill");
	});

	test("a slightly-late tick with fresh activity still waits", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 12_000, now - 500, WINDOW, SLEEP)).toBe("wait");
	});
});

describe("watchdogVerdict — degenerate inputs", () => {
	test("a clock that went BACKWARDS never kills", () => {
		// NTP correction or a manual clock change. negative deltas must not be
		// read as 'the window elapsed'.
		const now = 1_000_000;
		expect(watchdogVerdict(now, now + 5_000, now + 5_000, WINDOW, SLEEP)).toBe("wait");
	});

	test("zero window kills immediately (callers must gate on window > 0)", () => {
		const now = 1_000_000;
		expect(watchdogVerdict(now, now - 100, now, 0, SLEEP)).toBe("kill");
	});
});

describe("watchdogTickMs", () => {
	test("a long window uses the coarse cap, not a third of itself", () => {
		expect(watchdogTickMs(300_000, 10_000)).toBe(10_000);
		expect(watchdogTickMs(900_000, 30_000)).toBe(30_000);
	});

	test("a short window is observed at least twice inside itself", () => {
		expect(watchdogTickMs(2_000, 10_000)).toBe(666);
		expect(2_000 / watchdogTickMs(2_000, 10_000)).toBeGreaterThanOrEqual(2);
	});

	test("never busy-loops, however small the window", () => {
		for (const window of [0, 1, 10, 100, 500, 749]) {
			expect(watchdogTickMs(window, 10_000)).toBeGreaterThanOrEqual(250);
		}
	});

	test("a tiny window still ticks fast enough to be usable in tests", () => {
		expect(watchdogTickMs(1_000, 10_000)).toBe(333);
	});
});
