/** pure because both callers live inside setInterval closures over a live child. */

export type WatchdogVerdict =
	| "wait"
	| "kill"
	| "slept";

/** a tick delta this large means the machine slept, not that the process went quiet. */
export const SLEEP_JUMP_MS = 60_000;

/** sleep check runs first and wins — after a lid-close both idle and sleep are true. */
export function watchdogVerdict(
	now: number,
	lastTickAt: number,
	lastActiveAt: number,
	windowMs: number,
	sleepJumpMs: number,
): WatchdogVerdict {
	if (now - lastTickAt >= sleepJumpMs) return "slept";
	if (now - lastActiveAt >= windowMs) return "kill";
	return "wait";
}

export function watchdogTickMs(windowMs: number, maxTickMs: number): number {
	return Math.max(250, Math.min(maxTickMs, Math.floor(windowMs / 3)));
}
