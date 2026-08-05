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
	listWindows,
	permissionAdvice,
	type WindowInfo,
} from "./lib/capture";
import { defaultOutDir, fitImageFile, fitResultBlocks, pruneOutDir } from "./lib/image-fit";
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

function renderWindowTable(windows: WindowInfo[], heading: string): string {
	const shown = windows.slice(0, MAX_CANDIDATES);
	const lines = [heading, ...shown.map(describeWindow)];
	if (windows.length > shown.length) {
		lines.push(`  … and ${windows.length - shown.length} more`);
	}
	return lines.join("\n");
}

/** Resolve a window target, or explain the ambiguity well enough to fix it. */
function resolveWindow(params: any): WindowInfo {
	const pool = listWindows();

	if (params.window_id !== undefined) {
		const byId = findWindows({ id: Number(params.window_id) }, pool);
		if (byId.length === 1) return byId[0]!;
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
		if (onScreen.length === 1) return onScreen[0]!;
		throw new CaptureError(
			`${matches.length} windows match ${query}. Narrow it with window_title, or pass window_id.\n\n` +
				renderWindowTable(matches, "candidates:"),
		);
	}
	return matches[0]!;
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
			"illegible strip. Use it for web UI you are building.\n\n" +
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
						"Rectangle in screen points as [x, y, width, height], origin top-left. On a 2x display the captured image is twice these numbers in pixels, which is handled for you.",
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
						'Detail budget. "standard" is 1568 visual tokens and suits most UI. "high" is 4784 tokens (~3x the cost) and keeps small text readable on dense or high-resolution screens.',
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
					let window = resolveWindow(params);
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
						if (!mayRetry) throw err;
						await bringForward();
						await captureWindow(rawPath, window, opts);
						autoActivated = true;
					}
					captured = `${window.app} — ${window.title || "(untitled)"} [id ${window.id}]`;
					if (autoActivated) {
						captured += " (brought forward — it was on another Space)";
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
