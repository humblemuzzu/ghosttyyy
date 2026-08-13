/**
 * deepseek peak / off-peak pricing clock — pure logic, no I/O, no network.
 *
 * WHY NO API: DeepSeek defines its peak windows in **UTC**, and every machine
 * already knows UTC exactly (`Date.getUTCHours()` — no timezone database, no
 * DST, no conversion). A time API would add a network round-trip, a failure
 * mode, and a cache, to learn something the process already holds. The only
 * way this can be wrong is if the system clock itself is wrong, and a time API
 * would not fix that for any other program on the machine either.
 *
 * SOURCE OF THE NUMBERS (2026-08-13):
 *   @deepseek_ai announcement — "New pricing takes effect at 16:00 UTC,
 *   Aug 16, 2026. Peak Hours: 01:00-04:00 and 06:00-10:00 UTC (all other
 *   hours are off-peak). Off-peak rates are 50% lower than peak."
 *
 * Corroborated independently: those windows are Beijing (UTC+8) 09:00-12:00
 * and 14:00-18:00, i.e. Chinese office hours — 01+8=09, 04+8=12, 06+8=14,
 * 10+8=18. Two sources agreeing on hour-aligned boundaries is why the
 * half-open [start, end) reading below is safe.
 */

/** peak windows as [startHourUTC, endHourUTC), half-open. */
export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
	[1, 4],
	[6, 10],
] as const;

/** 16:00 UTC, Aug 16 2026 — month is 0-indexed, so 7 = August. */
export const EFFECTIVE_FROM_MS = Date.UTC(2026, 7, 16, 16, 0, 0, 0);

const MS_MIN = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

/** window edges as ms-into-the-UTC-day, ascending. */
const BOUNDARIES_MS: number[] = PEAK_WINDOWS_UTC.flatMap(([s, e]) => [s * MS_HOUR, e * MS_HOUR]).sort((a, b) => a - b);

export type Phase = "pre-launch" | "peak" | "off-peak";

export interface PeakState {
	phase: Phase;
	/** ms until `phase` changes to `next` */
	msUntilChange: number;
	/** what the phase becomes at the transition */
	next: "peak" | "off-peak";
	/** price multiplier vs off-peak: 2 during peak, 1 otherwise */
	multiplier: number;
}

/** ms elapsed since 00:00 UTC today. */
function msOfUtcDay(now: Date): number {
	return (
		now.getUTCHours() * MS_HOUR +
		now.getUTCMinutes() * MS_MIN +
		now.getUTCSeconds() * 1000 +
		now.getUTCMilliseconds()
	);
}

export function isPeakAt(now: Date): boolean {
	const t = msOfUtcDay(now);
	return PEAK_WINDOWS_UTC.some(([s, e]) => t >= s * MS_HOUR && t < e * MS_HOUR);
}

/**
 * Current pricing phase and the exact time until it flips.
 *
 * Before the effective date the V4 rate card is flat, so the honest answer is
 * "not yet" plus a countdown — reporting "off-peak" then would be a claim about
 * a discount that does not exist yet.
 */
export function computeState(now: Date = new Date()): PeakState {
	const nowMs = now.getTime();

	if (nowMs < EFFECTIVE_FROM_MS) {
		return {
			phase: "pre-launch",
			msUntilChange: EFFECTIVE_FROM_MS - nowMs,
			// 16:00 UTC falls outside both windows, so the scheme opens off-peak.
			next: isPeakAt(new Date(EFFECTIVE_FROM_MS)) ? "peak" : "off-peak",
			multiplier: 1,
		};
	}

	const t = msOfUtcDay(now);
	const peak = isPeakAt(now);
	// next edge today, else the first edge tomorrow (10:00 -> 01:00 is 15h off-peak)
	const nextEdge = BOUNDARIES_MS.find((b) => b > t) ?? BOUNDARIES_MS[0] + MS_DAY;

	return {
		phase: peak ? "peak" : "off-peak",
		msUntilChange: nextEdge - t,
		next: peak ? "off-peak" : "peak",
		multiplier: peak ? 2 : 1,
	};
}

/** compact duration: "2d 3h", "11h 48m", "47m", "<1m". */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const totalMin = Math.floor(ms / MS_MIN);
	if (totalMin < 1) return "<1m";
	if (totalMin >= 1440) {
		const d = Math.floor(totalMin / 1440);
		const h = Math.floor((totalMin % 1440) / 60);
		return h > 0 ? `${d}d ${h}h` : `${d}d`;
	}
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	return `${m}m`;
}

/** one-line status for the editor border. */
export function renderLabel(state: PeakState): string {
	const left = formatDuration(state.msUntilChange);
	switch (state.phase) {
		case "pre-launch":
			return `ds flat · ${left}`;
		case "peak":
			return `◆ ds PEAK 2× · ${left} left`;
		case "off-peak":
			return `◇ ds off-peak · ${left} left`;
	}
}

/** theme color key for the label, given whether the active model is deepseek. */
export function labelColor(state: PeakState, onDeepseek: boolean): "success" | "warning" | "error" | "muted" {
	if (state.phase === "pre-launch") return "muted";
	if (state.phase === "off-peak") return "success";
	// peak while actually running deepseek is the case worth shouting about
	return onDeepseek ? "error" : "warning";
}

/** $ per 1M tokens, from the announcement table. peak = 2× off-peak. */
export const PRICES = {
	"v4-flash": { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
	"v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
} as const;

/**
 * Format a UTC hour as a local wall-clock time, using the runtime's own
 * timezone. Deliberately not hardcoded to IST(+5:30): a hardcoded offset is
 * wrong the moment the laptop is somewhere else, and Intl already knows.
 * "en-US" is explicit because toLocaleTimeString otherwise follows the SYSTEM
 * locale (en-IN here), which formats differently.
 */
export function utcHourToLocal(hourUtc: number, ref: Date = new Date(), timeZone?: string): string {
	const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hourUtc, 0, 0));
	return d.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		...(timeZone ? { timeZone } : {}),
	});
}

/**
 * Local wall-clock time for the border, e.g. "7:02" — 12-hour, no leading zero,
 * and the AM/PM stripped: at a glance you already know whether it is morning.
 *
 * The meridiem is removed rather than never requested because Intl has no
 * "12-hour without meridiem" option — `hour12: false` would give "19:02", which
 * is a different clock, not the same one with less text. Modern ICU separates
 * the time from AM/PM with U+202F (narrow no-break space), not a plain space,
 * so the strip must not assume ASCII — `\s` covers both.
 */
export function formatClock(now: Date = new Date(), timeZone?: string): string {
	const s = now.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
		...(timeZone ? { timeZone } : {}),
	});
	return s.replace(/[\s\u202f]*[AP]\.?M\.?$/i, "").trim();
}

/** peak windows expressed in local wall-clock time, e.g. "06:30-09:30". */
export function localPeakWindows(ref: Date = new Date(), timeZone?: string): string[] {
	return PEAK_WINDOWS_UTC.map(
		([s, e]) => `${utcHourToLocal(s, ref, timeZone)}–${utcHourToLocal(e, ref, timeZone)}`,
	);
}
