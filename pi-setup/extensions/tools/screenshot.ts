/**
 * screenshot: capture the screen, a window, a region or a web page, and return
 * it already inside the model's image limits (see lib/image-fit.ts), so neither
 * pi nor the API resamples it again.
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
import { planToolImages, recordReturnedImages, sessionNote } from "./lib/image-budget";
import { crop, load, save } from "./lib/image";
import { captureWebPage, WebCaptureError } from "./lib/web-capture";
import { boxRendererWindowed, textSection, type Excerpt } from "./lib/box-format";
import { getContainer, getText } from "./lib/tui";

const COLLAPSED_EXCERPTS: Excerpt[] = [{ focus: "head" as const, context: 6 }];

/** Cap the candidate list so an ambiguous match cannot flood the context. */
const MAX_CANDIDATES = 25;

/** Accepts the shapes models actually send: an array, a JSON or "x,y,w,h" string, or an object. */
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
 * A window list with native-tab groups folded into one entry each, the
 * capturable (on-screen) tab first. Ungrouped lists render flat.
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
		if (g.length === 1) {
			lines.push(describeWindow(head));
			continue;
		}
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

/** Windows of regular (Dock) apps; helper and system windows are counted, not listed. */
export function renderOpenWindows(pool: WindowInfo[]): string {
	const shown = pool.filter((w) => w.regularApp !== false);
	const hidden = pool.length - shown.length;
	const table = shown.length ? renderWindowTable(shown, `${shown.length} open windows:`) : "no app windows found.";
	return hidden > 0
		? `${table}\n(${hidden} window(s) of background/helper apps not listed; \`app\` still matches them)`
		: table;
}

export interface WindowChoice {
	window: WindowInfo;
	/** Set when several windows matched and one was picked, so the caller can say so. */
	autoPicked?: { total: number; query: string };
}

/**
 * The on-screen window sharing `target`'s app and exact frame: its tab group
 * as currently displayed. Undefined when `target` is itself on screen.
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
 * Advice after a background tab failed to capture. Background tabs often do
 * capture, so this is only used after a real failure, and the sibling is never
 * captured in its place: it shows the active tab's content, not the one asked for.
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

/** Resolve a window target, or explain the ambiguity well enough to fix it. `pool` is injectable for tests. */
export function resolveWindow(params: any, pool: WindowInfo[] = listWindows()): WindowChoice {
	if (params.window_id !== undefined) {
		const byId = findWindows({ id: Number(params.window_id) }, pool);
		if (byId.length === 1) return { window: byId[0]! };
		throw new CaptureError(
			`no window with id ${params.window_id}. Window ids change when an app relaunches, ` +
				`so re-read the list rather than reusing an old one.\n\n` +
				renderOpenWindows(pool),
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
				renderOpenWindows(pool) +
				(advice ? `\n\n${advice}` : ""),
		);
	}
	if (matches.length > 1) {
		const onScreen = matches.filter((w) => w.onScreen);
		if (onScreen.length === 1) {
			return { window: onScreen[0]!, autoPicked: { total: matches.length, query } };
		}
		// Suggest window_title only when the candidates' titles actually differ.
		const titleCouldHelp = new Set(matches.map((w) => w.title)).size > 1;
		const advice = titleCouldHelp
			? params.window_title
				? `Refine window_title (the candidates below differ), or pass window_id.`
				: `Narrow it with window_title, or pass window_id.`
			: `Every candidate reports the same title, so window_title cannot separate them — ` +
				`pass window_id.`;
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
			"as an image already fitted to the vision model's limits. Use it to verify UI you built, " +
			"read something on screen, or see what an app is showing.\n\n" +
			"Do NOT shell out to `screencapture` or `sips -Z`: the API would resample a second time " +
			"and small text stops being readable.\n\n" +
			"Targeting, in precedence order: window_id, then app/window_title, then region, otherwise " +
			"the whole display; a url beats all of them. A failed window match returns the candidate " +
			"list, so the error tells you what to pass next.\n\n" +
			"A whole screen or large window is shrunk to fit; to read small text, capture a region " +
			"around it, which comes back at full resolution.\n\n" +
			"A url renders the WHOLE page in a headless browser, below the fold included, as ordered " +
			"readable slices. A page too long for one call is truncated from the top and says so — pass " +
			"a selector to reach a specific section.\n\n" +
			'Example: screenshot({ app: "Safari" })',

		parameters: Type.Object({
			url: Type.Optional(
				Type.String({
					description:
						"Render this URL in a headless browser instead of capturing the screen. Animations are frozen so repeat runs agree.",
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
						"[x, y, width, height] in points, origin top-left. Alone: SCREEN coordinates. With window_id/app: coordinates INSIDE that window, so [0,0,600,200] is its top-left corner wherever it sits.",
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
						"Bring the app to the front (and its Space) before capturing; steals focus. Unset: done automatically only when a window on another Space fails to capture. false forbids it.",
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
						'Detail level. Defaults to the current model\'s own tier, "high" on Claude 4.7 and later; pass "standard" only to deliberately get a smaller image.',
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
			// Single-line sink: a newline is width-0 to pi-tui and still moves the cursor.
			what = what.replace(/[\r\n\t\v\f]+/g, " ").slice(0, 60);
			text.setText(theme.fg("toolTitle", theme.bold("Screenshot ")) + theme.fg("dim", what));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			// pi renders the image blocks itself; this shows the text audit trail.
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

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const outDir = defaultOutDir();
			try {
				fs.mkdirSync(outDir, { recursive: true });
				pruneOutDir(outDir);

				if (params.list) {
					const windows = listWindows();
					const advice = permissionAdvice();
					const body = renderOpenWindows(windows);
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

				const images = planToolImages(ctx, params.tier);
				if (!images.ok) {
					return { content: [{ type: "text" as const, text: images.reason }], isError: true } as any;
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
						notes.push(
							`CLIPPED BY THE BROWSER: the document is ` +
								`${web.clipped.documentHeight.toLocaleString("en-US")}px tall, but Chromium cannot ` +
								`render past ${web.clipped.capturedHeight.toLocaleString("en-US")}px in one pass — ` +
								`beyond that it returns blank pixels rather than failing. Only the top ` +
								`${web.clipped.capturedHeight.toLocaleString("en-US")}px is real. Use a selector to ` +
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
						// The window may move or resize coming forward.
						const refreshed = findWindows({ id: window.id });
						if (refreshed[0]) window = refreshed[0];
					};

					if (params.activate) await bringForward();

					try {
						await captureWindow(rawPath, window, opts);
					} catch (err) {
						// Most off-Space windows still capture, so activation is a retry,
						// never a precaution. Only when the caller left `activate` unset
						// and the window was off screen; an on-screen failure is usually
						// permissions, which focus would not fix.
						const mayRetry = params.activate === undefined && !window.onScreen;
						if (!mayRetry) {
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
					// A region with a window is relative to the window. Cropping the
					// capture stays correct if the window moves, and includes the
					// native tab bar that CGWindowBounds leaves out.
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
					// CGWindowBounds excludes a native tab bar that the capture includes;
					// say so, or the extra height looks like a bug.
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
							// informational only
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
					tier: images.tier,
					limits: images.limits,
					budget: images.budget,
					outDir,
					basename: stamp,
				});
				recordReturnedImages(ctx, toolCallId, fit.totalBase64, fit.outputs.length);
				const sessionLine = sessionNote(images.limits, images.usage, fit.totalBase64);
				if (sessionLine) notes.push(sessionLine);

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
						tier: images.tier,
						resamples: fit.resamples,
						totalTokens: fit.totalTokens,
						totalBase64: fit.totalBase64,
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
