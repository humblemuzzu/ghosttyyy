/**
 * process-group CPU sampling for the bash idle watchdog.
 *
 * WHY THIS EXISTS
 *
 * the idle watchdog kills a command that has stopped producing OUTPUT. that is
 * too blunt on its own: a command can be doing real work while printing nothing
 * — a silent compile, an upload, or (the case that actually bites) a producer
 * behind `| tail`, where `tail` buffers everything until the command exits so we
 * see zero bytes for the whole run. stdout-silence cannot tell that apart from a
 * process that finished and hung.
 *
 * CPU time can. a working process burns CPU; a finished-but-hung one (a test
 * runner parked on a leaked handle) burns none. measured on this machine:
 *
 *   sleep 30                 ΔCPU/4s = 0.00s   (idle / hung — quiet)
 *   yes >/dev/null           ΔCPU/4s = 4.03s   (busy, silent to us — WORKING)
 *   yes | tail -1000000      ΔCPU/4s = 4.03s   (the `| tail` shape — WORKING)
 *   node print-then-hang     ΔCPU/4s = 0.00s   (the vitest bug — quiet)
 *
 * so CPU across the whole process GROUP (the shell, the pipe, every child) is
 * the signal that separates alive-but-quiet from dead. the command is spawned
 * `detached`, so it is its own group leader and pgid === child.pid — the same
 * assumption the existing `process.kill(-pid)` already relies on.
 *
 * FAIL-SAFE BY CONSTRUCTION
 *
 * this can only ever mark a command ALIVE (keep it running); it never causes a
 * kill. every function returns `undefined` on any error, and the caller treats
 * `undefined` as "no CPU signal, fall back to stdout-only" — i.e. exactly
 * today's behaviour. a parse bug or a missing `ps` degrades to the current
 * guard; it cannot make anything worse.
 */

import { execFileSync } from "node:child_process";

/**
 * parse a `ps` cputime string to seconds.
 *
 * macOS/BSD format is `[DD-]H:MM:SS.ss` with the leading fields dropped when
 * zero, so a short process is `M:SS.ss` and a long one `DD-HH:MM:SS.ss`.
 * returns `undefined` for anything that does not parse, so a surprising format
 * degrades to "no signal" rather than a wrong number.
 */
export function cpuTimeToSeconds(raw: string): number | undefined {
	const s = raw.trim();
	if (!s) return undefined;
	let days = 0;
	let rest = s;
	const dash = rest.indexOf("-");
	if (dash !== -1) {
		const dStr = rest.slice(0, dash);
		const d = Number(dStr);
		if (dStr.trim() === "" || !Number.isFinite(d)) return undefined;
		days = d;
		rest = rest.slice(dash + 1);
	}
	// `Number("")` is 0, so an empty field after a stray dash/colon would parse
	// as a real time. reject it — a surprising shape must give "no signal".
	if (rest.trim() === "") return undefined;
	const parts = rest.split(":");
	if (parts.length === 0 || parts.length > 3) return undefined;
	const nums = parts.map((p) => (p.trim() === "" ? Number.NaN : Number(p)));
	if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
	while (nums.length < 3) nums.unshift(0);
	const [h, m, sec] = nums;
	return days * 86400 + h * 3600 + m * 60 + sec;
}

/**
 * sum the cputime of every process whose PGID matches, from `ps` stdout.
 *
 * pure so it can be tested against captured `ps` output. expects lines of
 * `<pgid> <cputime>` (as produced by `ps -o pgid=,cputime= -ax`). returns
 * `undefined` when no process in the group is found — a group that has fully
 * exited gives no signal, which the caller must not read as "0 CPU, idle".
 */
export function parseGroupCpuSeconds(psStdout: string, pgid: number): number | undefined {
	let total = 0;
	let matched = 0;
	for (const line of psStdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\S+)/);
		if (!m) continue;
		if (Number(m[1]) !== pgid) continue;
		const secs = cpuTimeToSeconds(m[2]);
		if (secs === undefined) continue;
		total += secs;
		matched++;
	}
	return matched > 0 ? total : undefined;
}

/**
 * sample the total CPU seconds consumed by a process group, or `undefined` if
 * it cannot be measured (ps missing/slow/failed, or the group is gone).
 *
 * synchronous on purpose: it runs inside the watchdog's `setInterval`, one call
 * every ~10s, measured at ~10ms — cheaper than the render it shares the loop
 * with. a hard 2s timeout guards against a pathologically slow `ps` so the
 * interval can never wedge.
 */
export function sampleGroupCpuSeconds(pgid: number): number | undefined {
	if (!Number.isInteger(pgid) || pgid <= 0) return undefined;
	try {
		const out = execFileSync("ps", ["-o", "pgid=,cputime=", "-ax"], {
			encoding: "utf-8",
			timeout: 2000,
			maxBuffer: 8 * 1024 * 1024,
		});
		return parseGroupCpuSeconds(out, pgid);
	} catch {
		return undefined;
	}
}
