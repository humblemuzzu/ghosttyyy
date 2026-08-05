/**
 * macOS screen capture and window discovery.
 *
 * Everything here shells out to first-party tools — `screencapture` for pixels,
 * `osascript -l JavaScript` for the window list. No compiled helper, no native
 * module, nothing for `install.sh` to build.
 *
 * Verified behaviour on macOS 26 (2× display), 2026-08-05:
 *
 *   - `CGWindowListCopyWindowInfo` IS reachable from JXA, but only through
 *     `ObjC.castRefToObject`. Calling it directly returns something that
 *     `typeof`s as "function" and unwraps to nothing.
 *   - Option 0 (all windows) is required. Option 1 (kCGWindowListOptionOnScreenOnly)
 *     silently omits every window on another Space — this session's own terminal
 *     was missing from that list, which would make "screenshot my editor" fail
 *     for no visible reason.
 *   - `screencapture -l <id>` FAILS for a window on another Space:
 *     "could not create image from window", exit 1. There is no flag for this.
 *     The window has to be brought to the current Space first.
 *   - `kCGWindowName` is only populated when Screen Recording is granted, which
 *     makes it a free permission probe — no need to pay for the authoritative
 *     `CGPreflightScreenCaptureAccess` check unless something actually fails.
 */

import { execFileSync } from "node:child_process";

export interface WindowInfo {
	id: number;
	app: string;
	title: string;
	layer: number;
	onScreen: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Option 0 is kCGWindowListOptionAll. Do not "optimise" this to 1 — see the
 * header note. `castRefToObject` is likewise load-bearing.
 */
const LIST_WINDOWS_JXA = `
ObjC.import("CoreGraphics");
var raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
JSON.stringify(raw.map(function (w) {
  var b = w.kCGWindowBounds || {};
  return {
    id: w.kCGWindowNumber,
    app: w.kCGWindowOwnerName || "",
    title: w.kCGWindowName || "",
    layer: w.kCGWindowLayer,
    onScreen: !!w.kCGWindowIsOnscreen,
    x: b.X, y: b.Y, width: b.Width, height: b.Height
  };
}));
`;

export class CaptureError extends Error {}

function osascriptJs(source: string): string {
	return execFileSync("osascript", ["-l", "JavaScript", "-e", source], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	});
}

/** Every window the window server knows about, including other Spaces. */
export function listAllWindows(): WindowInfo[] {
	let out: string;
	try {
		out = osascriptJs(LIST_WINDOWS_JXA);
	} catch (err: any) {
		throw new CaptureError(`could not enumerate windows: ${err.message ?? err}`);
	}
	try {
		return JSON.parse(out) as WindowInfo[];
	} catch {
		throw new CaptureError(`window list was not valid JSON: ${out.slice(0, 200)}`);
	}
}

/**
 * The windows a person would call windows. Layer 0 excludes the menu bar, Dock,
 * wallpaper and every helper overlay; the size floor drops the 1×1 tracking
 * windows apps leave lying around.
 */
export function listWindows(): WindowInfo[] {
	return listAllWindows()
		.filter((w) => w.layer === 0 && w.width >= 100 && w.height >= 100)
		.sort((a, b) => {
			if (a.onScreen !== b.onScreen) return a.onScreen ? -1 : 1;
			const byApp = a.app.localeCompare(b.app);
			return byApp !== 0 ? byApp : a.title.localeCompare(b.title);
		});
}

export interface WindowQuery {
	id?: number;
	app?: string;
	title?: string;
}

/** Case-insensitive substring matching, because models do not know exact titles. */
export function findWindows(query: WindowQuery, pool = listWindows()): WindowInfo[] {
	if (query.id !== undefined) return pool.filter((w) => w.id === query.id);
	const app = query.app?.trim().toLowerCase();
	const title = query.title?.trim().toLowerCase();
	return pool.filter(
		(w) =>
			(!app || w.app.toLowerCase().includes(app)) &&
			(!title || w.title.toLowerCase().includes(title)),
	);
}

/**
 * One window, described well enough to pick it out of a list of near-identical
 * siblings.
 *
 * Position is included because a title alone frequently cannot separate them:
 * apps that show a path in the title left-truncate it themselves (Ghostty
 * renders `…/Documents/Code stuff/stripema`), so several windows arrive with
 * byte-identical titles and the part that differs has already been eaten. When
 * that happens the coordinates are the only thing a human or a model can use to
 * tell which is which — and `window_id` is then the only way to select one.
 */
export function describeWindow(w: WindowInfo): string {
	/*
	 * All macOS gives us is `kCGWindowIsOnscreen: false`. That is true for a
	 * window on another Space, a MINIMISED window, a hidden app, and — by far the
	 * most common case in practice — an inactive TAB. Under native tabbing every
	 * tab is its own NSWindow, so a single Ghostty window holding 8 tabs reports
	 * 8 windows of which 7 are "not on screen".
	 *
	 * Saying "[other Space]" names a cause we never checked, and sends people
	 * hunting a Spaces problem that usually is not there. State the observation,
	 * not the theory.
	 */
	const where = w.onScreen ? "" : "  [not on screen]";
	const title = w.title ? `"${w.title}"` : "(untitled)";
	const geom = `${w.width}×${w.height} @${w.x},${w.y}`;
	return `  id ${String(w.id).padEnd(7)} ${w.app.padEnd(18)} ${title} — ${geom}${where}`;
}

/**
 * Windows that share an app, a size and a position to the pixel are almost
 * certainly tabs of one window rather than separate windows — native tabbing
 * gives every tab the identical frame.
 *
 * Worth surfacing because "16 windows match" is a useless thing to tell someone
 * with two windows open, and because `window_id` behaves differently for a tab:
 * capturing one grabs the whole tab group it belongs to.
 */
export function groupLikelyTabs(windows: WindowInfo[]): WindowInfo[][] {
	const groups = new Map<string, WindowInfo[]>();
	for (const w of windows) {
		const key = `${w.app}|${w.width}x${w.height}@${w.x},${w.y}`;
		const g = groups.get(key);
		if (g) g.push(w);
		else groups.set(key, [w]);
	}
	return [...groups.values()];
}

/**
 * Authoritative Screen Recording check. Costs ~130ms and needs the Swift
 * toolchain, so it is only called when something has already gone wrong.
 * `CGPreflightScreenCaptureAccess` is declared in CoreGraphics' BridgeSupport
 * with no signature, so JXA cannot reach it — this is the cheapest honest path.
 */
export function screenRecordingGranted(): boolean | undefined {
	try {
		const out = execFileSync(
			"swift",
			["-e", 'import CoreGraphics; print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")'],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
		);
		return out.trim() === "granted";
	} catch {
		return undefined; // no Swift toolchain — fall back to the title heuristic
	}
}

/**
 * Free permission probe: without Screen Recording, macOS blanks `kCGWindowName`
 * for every window this process does not own.
 */
export function titlesVisible(windows = listWindows()): boolean {
	const others = windows.filter((w) => w.app !== "pi" && w.app !== "osascript");
	if (others.length === 0) return true;
	return others.some((w) => w.title.length > 0);
}

export function permissionAdvice(): string {
	const granted = screenRecordingGranted();
	if (granted === false) {
		return (
			"Screen Recording permission is NOT granted. macOS returns a picture of the " +
			"desktop with no windows in it rather than failing, so this would have " +
			"silently produced a useless image.\n" +
			"Grant it to the terminal running pi: System Settings → Privacy & Security → " +
			"Screen & System Audio Recording, then restart the terminal."
		);
	}
	if (granted === undefined && !titlesVisible()) {
		return (
			"Every window title is blank, which is what macOS does when Screen Recording " +
			"is denied. Grant it to the terminal running pi: System Settings → Privacy & " +
			"Security → Screen & System Audio Recording, then restart the terminal."
		);
	}
	return "";
}

export interface CaptureOptions {
	/** Include the mouse pointer. Off by default — it is rarely the subject. */
	cursor?: boolean;
	/** Milliseconds to wait before the shutter, for animations to settle. */
	delayMs?: number;
	/** Keep the drop shadow on a window capture. Off by default: it is wasted pixels. */
	shadow?: boolean;
}

function baseArgs(opts: CaptureOptions): string[] {
	// -x silences the shutter sound. Without it every agent screenshot is audible.
	const args = ["-x"];
	if (opts.cursor) args.push("-C");
	return args;
}

async function settle(ms: number | undefined): Promise<void> {
	if (!ms || ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10_000)));
}

function runScreencapture(args: string[]): void {
	try {
		execFileSync("screencapture", args, {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
	} catch (err: any) {
		const stderr = String(err.stderr ?? "").trim();
		throw new CaptureError(stderr || err.message || "screencapture failed");
	}
}

export async function captureDisplay(
	out: string,
	opts: CaptureOptions & { display?: number } = {},
): Promise<void> {
	await settle(opts.delayMs);
	const args = baseArgs(opts);
	if (opts.display !== undefined) args.push("-D", String(opts.display));
	args.push(out);
	runScreencapture(args);
}

export async function captureRegion(
	out: string,
	region: { x: number; y: number; width: number; height: number },
	opts: CaptureOptions = {},
): Promise<void> {
	if (region.width <= 0 || region.height <= 0) {
		throw new CaptureError(
			`region must have positive width and height, got ${region.width}×${region.height}`,
		);
	}
	await settle(opts.delayMs);
	const args = baseArgs(opts);
	args.push("-R", `${region.x},${region.y},${region.width},${region.height}`, out);
	runScreencapture(args);
}

export async function captureWindow(
	out: string,
	window: WindowInfo,
	opts: CaptureOptions = {},
): Promise<void> {
	await settle(opts.delayMs);
	const args = baseArgs(opts);
	if (!opts.shadow) args.push("-o");
	args.push("-l", String(window.id), out);
	try {
		runScreencapture(args);
	} catch (err: any) {
		throw new CaptureError(explainWindowFailure(window, String(err.message ?? err)));
	}
}

/**
 * `screencapture -l` on a window that is not on the current Space fails with a
 * flat "could not create image from window". Translating that into the actual
 * cause is most of this tool's value on a multi-Space machine.
 */
function explainWindowFailure(window: WindowInfo, raw: string): string {
	if (!window.onScreen) {
		return (
			`window ${window.id} ("${window.title || window.app}") is on another Space or ` +
			`minimised, and macOS cannot capture it there — screencapture reports ` +
			`"${raw}".\n` +
			`Options: switch to that Space and retry, pass activate:true to bring ` +
			`${window.app} forward first, or capture the display/region instead.`
		);
	}
	const advice = permissionAdvice();
	return advice ? `${raw}\n\n${advice}` : raw;
}

/**
 * Bring an app forward so its window lands on the current Space. Opt-in: it
 * steals focus and switches the user's Space, which is not something to do
 * behind their back.
 */
export async function activateApp(app: string, settleMs = 600): Promise<void> {
	// Escape backslashes BEFORE quotes — doing it the other way round would
	// double-escape the backslashes just inserted. An app name ending in `\`
	// would otherwise consume the closing delimiter of the AppleScript string
	// literal and swallow the rest of the statement.
	const escaped = app.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	try {
		execFileSync("osascript", ["-e", `tell application "${escaped}" to activate`], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		});
	} catch (err: any) {
		const stderr = String(err.stderr ?? "").trim();
		throw new CaptureError(
			`could not activate "${app}": ${stderr || err.message}\n` +
				`macOS may be asking for Automation permission — check System Settings → ` +
				`Privacy & Security → Automation.`,
		);
	}
	await settle(settleMs);
}
