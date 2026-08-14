/**
 * the decision a silence-watchdog makes on each tick.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO INLINE `if`s
 *
 * two watchdogs need exactly this logic: `bash.ts` kills a command that has
 * stopped producing output, and `pi-spawn.ts` kills a sub-agent process that has
 * stopped producing stdout. written inline they were two copies of the same
 * three-line decision, both unreachable from a test because both live inside a
 * `setInterval` closure over a live child process.
 *
 * the subtle part is the sleep guard, and subtle-plus-untestable is how the
 * deepseek-peak timer took a whole session down. so it lives here, pure, with
 * the clock passed in.
 */

export type WatchdogVerdict =
	/** the window has not elapsed. do nothing. */
	| "wait"
	/** the window elapsed with no activity. kill. */
	| "kill"
	/**
	 * the machine was suspended across this tick, so the observed silence is an
	 * artefact of the clock rather than evidence about the process. reset and
	 * grant a fresh window.
	 */
	| "slept";

/**
 * decide what a watchdog tick should do.
 *
 * @param now          current wall clock (ms)
 * @param lastTickAt   when this watchdog last ticked (ms)
 * @param lastActiveAt when the watched thing last showed life (ms)
 * @param windowMs     how much silence is fatal
 * @param sleepJumpMs  a tick delta this large means the machine slept
 *
 * ORDER IS LOAD-BEARING: the sleep check runs FIRST and wins outright. after a
 * lid-close both conditions are true — hours of "silence" AND an impossible tick
 * delta — and the honest reading is that the process was frozen along with the
 * rest of the machine, so it has not yet been given its window. checking idle
 * first would kill a healthy child at the exact moment the user opens the laptop
 * and starts watching, which is the worst possible moment to be wrong.
 *
 * the failure direction is deliberate: a spurious "slept" costs one extra
 * window of patience, a missed one costs a live process. no scheduler delay is
 * a minute; every real suspend is minutes.
 */
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

/**
 * how often to wake, given the window being enforced.
 *
 * a long window wants a coarse tick (waking every 10s to enforce 5 minutes is
 * already 30× more often than necessary, and wake-ups are what cost battery). a
 * short window — which is what tests and an operator debugging with
 * `PI_BASH_IDLE_KILL_SEC=2` use — needs a tick fine enough to observe it, or the
 * window silently becomes the tick.
 *
 * a third of the window gives at least two observations inside it; the 250ms
 * floor stops a pathological setting from busy-looping the event loop.
 */
export function watchdogTickMs(windowMs: number, maxTickMs: number): number {
	return Math.max(250, Math.min(maxTickMs, Math.floor(windowMs / 3)));
}
