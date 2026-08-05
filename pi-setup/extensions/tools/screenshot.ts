/**
 * screenshot tool — capture the screen, a window, or a region, and hand back an
 * image that is already inside Claude's vision budget.
 *
 * WHY THIS EXISTS
 *
 * Agents were doing this by hand:
 *
 *   screencapture -x -o -l 12237 /tmp/shot.png && sips -Z 1400 /tmp/shot.png
 *
 * Both halves are wrong. `sips -Z 1400` picks a long edge that satisfies the
 * 1568px edge limit and blows the 1568-token limit — a 1400×900 result costs
 * 1650 tokens, so the API resizes it AGAIN to 1372×882. Text gets resampled
 * twice for a 2% size change. And on a 2× display the capture was 2800×1800 to
 * begin with, so that is a 3.2× reduction pushed through two filters.
 *
 * This tool resamples exactly once, to the exact dimensions Anthropic's own
 * resizer would have chosen, using a filter picked for UI rather than for
 * photographs. See lib/vision.ts and lib/image-fit.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	activateApp,
	captureDisplay,
	captureRegion,
	captureWindow,
	CaptureError,
	describeWindow,
	findWindows,
	groupLikelyTabs,
	listWindows,
	permissionAdvice,
	type WindowInfo,
} from "./lib/capture";
import {
	defaultOutDir,
	fitImageFile,
	fitResultBlocks,
	imageSize,
	pruneOutDir,
} from "./lib/image-fit";
import { crop, load, save } from "./lib/image";
import { captureWebPage, WebCaptureError } from "./lib/web-capture";
import { boxRendererWindowed, textSection, type Excerpt } from "./lib/box-format";
import { getContainer, getText } from "./lib/tui";

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 6 }];

/** Cap the candidate list so an ambiguous match cannot flood the context. */
const MAX_CANDIDATES = 25;

/**
 * Models send a four-number region as an array, a JSON string, a bare
 * "x,y,w,h" string, or an object. Librarian's `normalizeRepositories` exists
 * for the same reason; rejecting the shape a model happens to pick teaches it
 * nothing and costs a turn.
 */
export function normalizeRegion(
	value: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
	if (value === undefined || value === null) return undefined;

	let parts: unknown[] | undefined;
	if (Array.isArray(value)) {
		parts = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) parts = parsed;
			} catch {
				/* fall through to the comma split */
			}
		}
		if (!parts) parts = trimmed.split(/[,\s]+/).filter(Boolean);
	} else if (typeof value === "object") {
		const o = value as Record<string, unknown>;
		const got = [o.x, o.y, o.width ?? o.w, o.height ?? o.h];
		if (got.every((n) => n !== undefined)) parts = got;
	}

	if (!parts || parts.length !== 4) {
		throw new Error(
			`region needs exactly four numbers as [x, y, width, height], got ${JSON.stringify(value)}`,
		);
	}
	const [x, y, width, height] = parts.map((n) => Number(n));
	if (![x, y, width, height].every((n) => Number.isFinite(n))) {
		throw new Error(`region values must all be numbers, got ${JSON.stringify(value)}`);
	}
	return { x: x!, y: y!, width: width!, height: height! };
}

/**
 * Render a window list, folding tab groups into one entry each.
 *
 * A flat list is actively misleading on a tab-heavy machine: 4 visible terminals
 * produced 17 rows that differed only by id, and the row you can actually
 * capture was buried among 15 you cannot. Grouping by frame shows the same
 * information at a third of the length and puts the capturable id first.
 *
 * Falls back to the flat list when nothing groups, so ordinary apps read exactly
 * as before.
 */
function renderWindowTable(windows: WindowInfo[], heading: string): string {
	const groups = groupLikelyTabs(windows);
	if (groups.length === windows.length) {
		const shown = windows.slice(0, MAX_CANDIDATES);
		const lines = [heading, ...shown.map(describeWindow)];
		if (windows.length > shown.length) {
			lines.push(`  … and ${windows.length - shown.length} more`);
		}
		return lines.join("\n");
	}

	const grouped = groups.filter((g) => g.length > 1).length;
	const lines = [
		`${heading} ${windows.length} across ${groups.length} window frame(s) — ` +
			`${grouped} of them tab group(s)`,
	];
	for (const g of groups.slice(0, MAX_CANDIDATES)) {
		const head = g[0]!;
		// A frame with one window is just a window. Folding it adds a "1 tab(s)"
		// header and an indent around a single line, which is pure noise — only
		// the genuinely grouped entries earn the extra structure.
		if (g.length === 1) {
			lines.push(describeWindow(head));
			continue;
		}
		// The on-screen tab is the one that can actually be captured, so it leads.
		const live = g.find((w) => w.onScreen);
		const lead = live ?? head;
		const state = live ? "on screen" : "not on screen";
		lines.push(
			`  ${lead.app} ${lead.width}×${lead.height} @${lead.x},${lead.y} — ` +
				`${g.length} tab(s), ${state}`,
		);
		lines.push(
			`      capture id ${lead.id}  ${lead.title ? `"${lead.title}"` : "(untitled)"}` +
				(live ? "" : "  ← nothing in this group is on screen; capture may fail"),
		);
		const others = g.filter((w) => w.id !== lead.id);
		if (others.length) {
			lines.push(`      other tabs: ${others.map((w) => w.id).join(", ")}`);
		}
	}
	if (groups.length > MAX_CANDIDATES) {
		lines.push(`  … and ${groups.length - MAX_CANDIDATES} more frame(s)`);
	}
	return lines.join("\n");
}

/**
 * What `resolveWindow` decided, so the caller can disclose a choice it made.
 *
 * Auto-picking silently was a real complaint from a test run: `app:"ghostty"`
 * matched 12 windows and captured one with no signal, while `app` + a
 * `window_title` matched 5 and refused outright. Both behaviours are defensible;
 * the problem was that the caller could not tell which had happened, so it had
 * no reason to doubt it got the window it meant.
 */
export interface WindowChoice {
	window: WindowInfo;
	/** Set when more than one window matched and one was picked for the caller. */
	autoPicked?: { total: number; query: string };
}

/**
 * The sibling of `target` that is currently on screen, if its tab group has one.
 *
 * Capturing any tab grabs the whole group as it is *currently displayed*, so a
 * background tab is never capturable on its own — but the group usually is,
 * under a different id. Without this, "13707 cannot be captured" is a dead end
 * when a perfectly good capture of that same window is one id away.
 */
export function displayedSibling(target: WindowInfo, pool: WindowInfo[]): WindowInfo | undefined {
	if (target.onScreen) return undefined;
	return pool.find(
		(w) =>
			w.id !== target.id &&
			w.onScreen &&
			w.app === target.app &&
			w.width === target.width &&
			w.height === target.height &&
			w.x === target.x &&
			w.y === target.y,
	);
}

/**
 * What to tell a caller whose target is a background tab.
 *
 * Only ever reached AFTER a capture has actually failed. Do not claim a
 * background tab is uncapturable in principle — measured, it often is
 * capturable: `window_id 13861`, a background tab, captured fine at 3840×2080
 * (exactly bounds×2, without the group's tab bar). An earlier draft of this
 * message asserted "a background tab can never be captured on its own" and a
 * single live test disproved it.
 *
 * Deliberately does NOT auto-capture the sibling either: the group renders
 * whichever tab is active, so capturing it returns different CONTENT than was
 * asked for. Silently substituting it would be the same class of bug as the
 * silent auto-pick — right pixels, wrong subject, no disclosure.
 */
export function tabRescueAdvice(target: WindowInfo, sibling: WindowInfo): string {
	return (
		`\n\nid ${target.id} looks like a background tab of a window that IS on screen ` +
		`right now as id ${sibling.id}${sibling.title ? ` ("${sibling.title}")` : ""}. ` +
		`Capturing ${sibling.id} will succeed and returns that window as it currently ` +
		`appears — which is the ACTIVE tab's content, not id ${target.id}'s. To get ` +
		`id ${target.id}'s own content, switch to that tab first, then retry this call.`
	);
}

/**
 * Resolve a window target, or explain the ambiguity well enough to fix it.
 *
 * `pool` is injectable because the interesting branches depend on which Spaces
 * happen to be active, which makes them untestable against the live desktop —
 * the ambiguous case stops being ambiguous the moment a window moves.
 */
export function resolveWindow(params: any, pool: WindowInfo[] = listWindows()): WindowChoice {
	if (params.window_id !== undefined) {
		const byId = findWindows({ id: Number(params.window_id) }, pool);
		if (byId.length === 1) return { window: byId[0]! };
		throw new CaptureError(
			`no window with id ${params.window_id}. Window ids change when an app relaunches, ` +
				`so re-read the list rather than reusing an old one.\n\n` +
				renderWindowTable(pool, "open windows:"),
		);
	}

	const matches = findWindows({ app: params.app, title: params.window_title }, pool);
	const query = [params.app && `app "${params.app}"`, params.window_title && `title "${params.window_title}"`]
		.filter(Boolean)
		.join(" + ");

	if (matches.length === 0) {
		const advice = permissionAdvice();
		throw new CaptureError(
			`no window matches ${query}.\n\n` +
				renderWindowTable(pool, "open windows:") +
				(advice ? `\n\n${advice}` : ""),
		);
	}
	if (matches.length > 1) {
		// Prefer an unambiguous on-screen match before giving up: a background
		// app with six hidden helper windows should not defeat "screenshot Safari".
		const onScreen = matches.filter((w) => w.onScreen);
		if (onScreen.length === 1) {
			return { window: onScreen[0]!, autoPicked: { total: matches.length, query } };
		}
		/*
		 * Only suggest `window_title` when it could actually work. Telling a
		 * caller to "narrow it with window_title" after it already passed one —
		 * or when every candidate shares a byte-identical title — is advice that
		 * cannot succeed, and it invites a retry loop.
		 */
		const distinctTitles = new Set(matches.map((w) => w.title)).size;
		const titleCouldHelp = distinctTitles > 1;
		const advice = titleCouldHelp
			? params.window_title
				? `Refine window_title (the candidates below differ), or pass window_id.`
				: `Narrow it with window_title, or pass window_id.`
			: `Every candidate reports the same title, so window_title cannot separate them — ` +
				`pass window_id.`;
		/*
		 * A raw count is misleading under native tabbing: every tab is its own
		 * window, so two real windows can report sixteen matches. Say how many
		 * distinct frames there are, so the number matches what the user sees.
		 */
		const groups = groupLikelyTabs(matches);
		const tabNote =
			groups.length < matches.length
				? `\n\nThese occupy only ${groups.length} distinct window frame(s) — under macOS ` +
					`native tabbing each TAB is reported as its own window, so most of these are ` +
					`likely tabs of the same window. Capturing any one of them grabs the whole ` +
					`tab group as it is currently displayed.`
				: "";
		throw new CaptureError(
			`${matches.length} windows match ${query}. ${advice}\n\n` +
				renderWindowTable(matches, "candidates:") +
				tabNote,
		);
	}
	return { window: matches[0]! };
}

export function createScreenshotTool(): ToolDefinition {
	return {
		name: "screenshot",
		label: "Screenshot",
		description:
			"Capture the screen, a specific window, or a rectangular region on macOS, and return it " +
			"as an image already fitted to the vision model's limits — resampled exactly once, at the " +
			"size the API would have picked anyway.\n\n" +
			"Use it to verify UI you just built or changed, to read something on screen, or to see " +
			"what an app is currently showing.\n\n" +
			"Do NOT shell out to `screencapture` or `sips -Z` — `sips -Z` ignores the visual-token " +
			"budget, so the API resamples the image a second time and small text stops being readable.\n\n" +
			"Targeting, in precedence order: window_id, then app/window_title, then region, otherwise " +
			"the whole display. With list:true it returns the open windows instead of an image. " +
			"Ambiguous or missing window matches come back with the candidate list, so a failed call " +
			"tells you exactly what to pass next.\n\n" +
			"Pass a url to render a page in a headless browser instead of photographing the screen. " +
			"That captures the WHOLE page including everything below the fold, which no screen capture " +
			"can do, and a very tall page is returned as ordered readable slices rather than one " +
			"illegible strip. Use it for web UI you are building. A page too long to return in one " +
			"call is truncated from the top and says so — pass a selector to reach a specific " +
			"section instead.\n\n" +
			'Example: screenshot({ app: "Safari" })',

		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"Render this URL in a headless browser and capture it, instead of capturing the screen. Beats every other targeting option. Animations are frozen first so repeat runs agree.",
				}),
			),
			selector: Type.Optional(
				Type.String({
					description:
						"With url: capture only the element matching this CSS selector, scrolled into view first, rather than the whole page.",
				}),
			),
			viewport_width: Type.Optional(
				Type.Number({
					description:
						"With url: browser viewport width in CSS pixels, which is what decides the responsive layout. Defaults to 1440.",
				}),
			),
			full_page: Type.Optional(
				Type.Boolean({
					description:
						"With url: capture the entire scrollable document rather than just the visible viewport. On by default.",
				}),
			),
			app: Type.Optional(
				Type.String({
					description:
						'Capture a window belonging to this app, matched case-insensitively as a substring — "safari" finds "Safari".',
				}),
			),
			window_title: Type.Optional(
				Type.String({
					description:
						"Narrow the match by window title, case-insensitive substring. Combine with app when one app has several windows.",
				}),
			),
			window_id: Type.Optional(
				Type.Number({
					description:
						"Exact CGWindowID, as printed by a list:true call. Beats app and window_title.",
				}),
			),
			region: Type.Optional(
				Type.Array(Type.Number(), {
					description:
						"Rectangle as [x, y, width, height], origin top-left, in points. Alone it means SCREEN coordinates. Combined with window_id/app it means coordinates INSIDE that window, so [0,0,600,200] is the window's top-left corner regardless of where the window sits — and it keeps working after the window moves. On a 2x display the captured image is twice these numbers in pixels, which is handled for you.",
				}),
			),
			display: Type.Optional(
				Type.Number({
					description: "Which display to capture, 1-based. Defaults to the main display.",
				}),
			),
			list: Type.Optional(
				Type.Boolean({
					description:
						"Return the list of open windows with their ids, titles and sizes instead of capturing anything.",
				}),
			),
			activate: Type.Optional(
				Type.Boolean({
					description:
						"Bring the target app to the front before capturing, which also switches Space. Steals focus, so it is not done up front. Leave unset and a window that fails to capture because it is on another Space is retried this way automatically; set false to forbid that.",
				}),
			),
			delay_ms: Type.Optional(
				Type.Number({
					description:
						"Wait this many milliseconds before the shutter, for animations or transitions to settle. Capped at 10000.",
				}),
			),
			cursor: Type.Optional(
				Type.Boolean({ description: "Include the mouse pointer. Off by default." }),
			),
			shadow: Type.Optional(
				Type.Boolean({
					description:
						"Keep the drop shadow around a window capture. Off by default because it is wasted pixels.",
				}),
			),
			tier: Type.Optional(
				Type.Union([Type.Literal("standard"), Type.Literal("high")], {
					description:
						'Detail level. Defaults to "high", which is never worse than "standard" and often needs no resampling at all. Pass "standard" only to deliberately request a smaller image; there is no reason to reach for it otherwise.',
				}),
			),
		}),

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			let what = "display";
			if (args?.list) what = "list windows";
			else if (args?.url) what = String(args.url);
			else if (args?.window_id !== undefined) what = `window ${args.window_id}`;
			else if (args?.app) what = String(args.app) + (args.window_title ? ` — ${args.window_title}` : "");
			else if (args?.window_title) what = String(args.window_title);
			else if (args?.region) what = `region ${JSON.stringify(args.region)}`;
			else if (args?.display !== undefined) what = `display ${args.display}`;
			// Single-line sink: a newline here is width-0 to every check and still
			// moves the terminal cursor a row, which smears the whole TUI.
			what = what.replace(/[\r\n\t\v\f]+/g, " ").slice(0, 60);
			text.setText(theme.fg("toolTitle", theme.bold("Screenshot ")) + theme.fg("dim", what));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			// The image blocks are rendered by pi itself; we show the audit trail.
			const textBlock = [...(result.content ?? [])].reverse().find((c: any) => c.type === "text");
			const body = textBlock?.text ?? "(no output)";
			container.addChild(
				boxRendererWindowed(() => [textSection(undefined, body)], {
					collapsed: { excerpts: COLLAPSED_EXCERPTS },
					expanded: {},
				}),
			);
			return container;
		},

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const outDir = defaultOutDir();
			try {
				fs.mkdirSync(outDir, { recursive: true });
				pruneOutDir(outDir);

				// --- list mode: no capture at all
				if (params.list) {
					const windows = listWindows();
					const advice = permissionAdvice();
					const body = windows.length
						? renderWindowTable(windows, `${windows.length} open windows:`)
						: "no windows found.";
					return {
						content: [
							{
								type: "text" as const,
								text: advice ? `${body}\n\n${advice}` : body,
							},
						],
						details: { windows },
					} as any;
				}

				const region = normalizeRegion(params.region);
				const wantsWindow =
					params.window_id !== undefined || Boolean(params.app) || Boolean(params.window_title);

				const stamp = `shot-${Date.now()}`;
				const rawPath = path.join(outDir, `${stamp}.raw.png`);
				const opts = {
					cursor: Boolean(params.cursor),
					shadow: Boolean(params.shadow),
					delayMs: params.delay_ms === undefined ? undefined : Number(params.delay_ms),
				};

				let captured: string;
				let autoActivated = false;
				const notes: string[] = [];

				if (params.url) {
					// A page is not a screen. Render it rather than photograph it, so
					// everything below the fold is included.
					const web = await captureWebPage(rawPath, {
						url: String(params.url),
						width: params.viewport_width === undefined ? undefined : Number(params.viewport_width),
						selector: params.selector,
						fullPage: params.full_page,
						waitMs: opts.delayMs,
					});
					captured = `${web.finalUrl}${web.title ? ` — ${web.title}` : ""}`;
					if (params.selector) captured += ` [${params.selector}]`;
					if (web.clipped) {
						// Distinct from the slice cap: this is the browser being unable to
						// DRAW past its texture limit, not us choosing to return less.
						notes.push(
							`CLIPPED BY THE BROWSER: the document is ` +
								`${web.clipped.documentHeight.toLocaleString()}px tall, but Chromium cannot ` +
								`render past ${web.clipped.capturedHeight.toLocaleString()}px in one pass — ` +
								`beyond that it returns blank pixels rather than failing. Only the top ` +
								`${web.clipped.capturedHeight.toLocaleString()}px is real. Use a selector to ` +
								`reach a section further down.`,
						);
					}
					if (web.overflow > 0) {
						notes.push(
							`page scrolls sideways by ${web.overflow}px at this viewport width — ` +
								`the capture may be missing content to the right`,
						);
					}
					if (web.pageErrors.length) {
						notes.push(
							`${web.pageErrors.length} JavaScript error(s) on the page: ` +
								web.pageErrors.slice(0, 3).join(" | "),
						);
					}
				} else if (wantsWindow) {
					const pool = listWindows();
					const choice = resolveWindow(params, pool);
					let window = choice.window;
					if (choice.autoPicked) {
						notes.push(
							`${choice.autoPicked.total} windows match ${choice.autoPicked.query}; ` +
								`captured the only one currently on screen (id ${window.id}). Under macOS ` +
								`native tabbing every TAB counts as a window, so that number is usually ` +
								`much larger than the number of windows you can see. Pass window_id to ` +
								`choose a different one — list:true shows them all.`,
						);
					}
					const bringForward = async () => {
						await activateApp(window.app);
						// The window may have moved or resized coming forward, and a
						// stale record would make any later failure message wrong.
						const refreshed = findWindows({ id: window.id });
						if (refreshed[0]) window = refreshed[0];
					};

					if (params.activate) await bringForward();

					try {
						await captureWindow(rawPath, window, opts);
					} catch (err) {
						/*
						 * A window on another Space MAY still be capturable — measured 9
						 * of 10 were — so we cannot pre-emptively activate, and we cannot
						 * pre-emptively refuse either. The only honest move is to try,
						 * and on the one failure that does occur, do the thing the error
						 * message was about to tell the model to do itself. Saves a whole
						 * round-trip on the single case where it matters.
						 *
						 * Only when the caller did NOT already ask for it (no point
						 * activating twice) and only for an off-screen window (an
						 * on-screen failure is a different problem — permissions, most
						 * likely — and stealing focus would not help).
						 */
						// undefined means "no opinion" — the only case we may act on.
						// An explicit true already activated; an explicit false is a
						// deliberate opt-out; an on-screen failure is a different problem
						// (permissions, most likely) that stealing focus would not fix.
						const mayRetry = params.activate === undefined && !window.onScreen;
						if (!mayRetry) {
							// Same dead end, reached without the retry: an explicit
							// activate:false, or an on-screen window that failed anyway.
							const sibling = displayedSibling(window, pool);
							if (!sibling) throw err;
							throw new CaptureError(
								String((err as any).message ?? err) + tabRescueAdvice(window, sibling),
							);
						}
						try {
							await bringForward();
							await captureWindow(rawPath, window, opts);
							autoActivated = true;
						} catch (retryErr: any) {
							/*
							 * Bringing the app forward did not help, which for a tab means
							 * it never could: the group renders one tab at a time. Point at
							 * the sibling that IS displayed rather than stopping dead.
							 */
							const sibling = displayedSibling(window, pool);
							if (!sibling) throw retryErr;
							throw new CaptureError(
								String(retryErr.message ?? retryErr) + tabRescueAdvice(window, sibling),
							);
						}
					}
					captured = `${window.app} — ${window.title || "(untitled)"} [id ${window.id}]`;
					if (autoActivated) {
						captured += " (brought forward — it was on another Space)";
					}
					/*
					 * A region given alongside a window means "inside that window".
					 *
					 * Cropping AFTER the capture rather than converting to screen
					 * coordinates and calling captureRegion is deliberate: screen
					 * coordinates go stale the instant the window moves, and they cannot
					 * express the tab-bar offset that CGWindowBounds omits. Cropping the
					 * window's own pixels is correct by construction.
					 */
					if (region) {
						const shot = imageSize(rawPath);
						const scale = Math.max(1, Math.round(shot.width / window.width));
						const box = {
							x: region.x * scale,
							y: region.y * scale,
							width: region.width * scale,
							height: region.height * scale,
						};
						const clamped = {
							x: Math.max(0, Math.min(box.x, shot.width - 1)),
							y: Math.max(0, Math.min(box.y, shot.height - 1)),
							width: 0,
							height: 0,
						};
						clamped.width = Math.max(1, Math.min(box.width, shot.width - clamped.x));
						clamped.height = Math.max(1, Math.min(box.height, shot.height - clamped.y));
						save(crop(load(rawPath), clamped), rawPath);
						captured += ` — region ${region.x},${region.y} ${region.width}×${region.height} within the window`;
						if (clamped.width !== box.width || clamped.height !== box.height) {
							notes.push(
								`the requested region ran past the window edge and was clamped to ` +
									`${clamped.width / scale}×${clamped.height / scale} points. The window ` +
									`is ${shot.width / scale}×${shot.height / scale} points as captured.`,
							);
						}
					}
					/*
					 * `CGWindowBounds` and `screencapture -l` do not always agree, and the
					 * mismatch looks like a bug when it is not. Measured on Ghostty: the
					 * list reports 1920x1040 at y=40 (the content area) while the capture
					 * is 1920x1080 from y=0 — the difference is exactly the native tab
					 * bar, which the bounds exclude and the capture rightly includes.
					 * Verified by reading the top strip: it is Ghostty's tab bar, not the
					 * menu bar, so nothing extra was captured and nothing was lost.
					 *
					 * Saying so costs one line and stops a reviewer having to re-derive it.
					 *
					 * Only when the whole window was captured. After a region crop the
					 * comparison is meaningless — the image is deliberately smaller — and
					 * the note would end by claiming the full window was captured, which
					 * would be flatly untrue.
					 */
					if (!region) {
						try {
							const shot = imageSize(rawPath);
							const scale = Math.round(shot.width / window.width) || 1;
							const extra = shot.height - window.height * scale;
							if (extra !== 0) {
								notes.push(
									`the window listed as ${window.width}×${window.height} captured at ` +
										`${shot.width}×${shot.height} (${extra > 0 ? "+" : ""}${extra}px height). ` +
										`Window bounds exclude chrome such as a native tab bar; the capture ` +
										`includes it. The full window was captured.`,
								);
							}
						} catch {
							// A size read is a nicety; never fail a good capture over it.
						}
					}
				} else if (region) {
					await captureRegion(rawPath, region, opts);
					captured = `region ${region.x},${region.y} ${region.width}×${region.height}`;
				} else {
					await captureDisplay(rawPath, {
						...opts,
						display: params.display === undefined ? undefined : Number(params.display),
					});
					captured = params.display === undefined ? "main display" : `display ${params.display}`;
				}

				if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
					const advice = permissionAdvice();
					return {
						content: [
							{
								type: "text" as const,
								text:
									`screencapture reported success but wrote nothing.` +
									(advice ? `\n\n${advice}` : ""),
							},
						],
						isError: true,
					} as any;
				}

				const fit = fitImageFile(rawPath, {
					tier: params.tier,
					outDir,
					basename: stamp,
				});

				// The raw capture is only worth keeping when it IS the output.
				if (fit.outputs.every((o) => o.path !== rawPath)) {
					fs.rmSync(rawPath, { force: true });
				}

				const blocks = fitResultBlocks(fit);
				const last = blocks[blocks.length - 1] as { type: string; text: string };
				last.text = [`captured ${captured}`, last.text, ...notes].join("\n");

				return {
					content: blocks,
					details: {
						header: captured,
						plan: fit.plan,
						resamples: fit.resamples,
						totalTokens: fit.totalTokens,
						source: fit.source,
						outputs: fit.outputs.map(({ base64: _base64, ...rest }) => rest),
					},
				} as any;
			} catch (err: any) {
				const message =
					err instanceof CaptureError || err instanceof WebCaptureError
						? err.message
						: (err?.message ?? String(err));
				return {
					content: [{ type: "text" as const, text: message }],
					isError: true,
				} as any;
			}
		},
	};
}
