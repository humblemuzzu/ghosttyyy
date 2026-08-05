/**
 * Screenshot a web page, including the parts below the fold.
 *
 * `screencapture` can only ever photograph what is rendered on the glass. For a
 * page that scrolls, that is the wrong tool — you get the visible third and no
 * way to ask for the rest. A headless browser can render the whole document and
 * hand back one tall image, which `planView` then slices into readable strips
 * rather than shrinking into a smear.
 *
 * The determinism CSS and the shoot-the-element-not-a-clip rule are lifted from
 * the `caliper` project's src/capture.ts, where they were arrived at the hard
 * way. See the comments on each for what breaks without them.
 *
 * OPTIONAL DEPENDENCY. `playwright-core` is resolved at call time, and we drive
 * the ALREADY-INSTALLED Google Chrome via `channel: "chrome"` rather than
 * downloading a browser. Full `playwright` ships a ~150MB Chromium per platform;
 * `playwright-core` is a few MB and brings none. If either is missing the tool
 * says exactly what to install rather than throwing a module-resolution stack.
 */

import { createRequire } from "node:module";
import path from "node:path";

export class WebCaptureError extends Error {}

/**
 * Sticky headers overlap whatever is scrolled under them, and a half-finished
 * transition makes the same page produce two different screenshots. Both are
 * removed before anything is captured, so two runs of the same URL agree.
 */
const DETERMINISM_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

function loadPlaywright(): any {
	const require = createRequire(import.meta.url);
	const candidates = [
		"playwright-core",
		"playwright",
		// the tools extension's own node_modules, when resolution is anchored elsewhere
		path.join(__dirname, "..", "node_modules", "playwright-core"),
	];
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			/* try the next one */
		}
	}
	throw new WebCaptureError(
		"web capture needs playwright-core, which is not installed.\n" +
			"  cd ~/.pi/agent/extensions/tools && npm install playwright-core\n" +
			"It drives your existing Google Chrome, so there is no browser download.",
	);
}

export interface WebCaptureOptions {
	url: string;
	/** Viewport width in CSS pixels. Height is incidental for a full-page shot. */
	width?: number;
	height?: number;
	/**
	 * Capture the whole scrollable document rather than just the viewport.
	 * On by default: seeing only the fold is what makes `screencapture` the
	 * wrong tool for a page in the first place.
	 */
	fullPage?: boolean;
	/** Shoot one element instead of the page. */
	selector?: string;
	/**
	 * Device pixel ratio. Deliberately defaults to 1, NOT 2: the token budget is
	 * counted in device pixels, so dsf 2 quadruples the cost of the same layout
	 * for detail a downscale is about to throw away.
	 */
	deviceScaleFactor?: number;
	waitMs?: number;
	timeoutMs?: number;
}

export interface WebCaptureResult {
	title: string;
	finalUrl: string;
	/** scrollWidth - clientWidth. Anything but 0 means the page scrolls sideways. */
	overflow: number;
	pageErrors: string[];
}

export async function captureWebPage(
	out: string,
	opts: WebCaptureOptions,
): Promise<WebCaptureResult> {
	const { chromium } = loadPlaywright();
	const width = opts.width ?? 1440;
	const timeout = opts.timeoutMs ?? 30_000;

	let browser: any;
	try {
		try {
			// `channel: "chrome"` uses the installed Google Chrome. Without it,
			// playwright-core looks for a bundled browser it does not ship.
			browser = await chromium.launch({ channel: "chrome" });
		} catch {
			// A machine with a real Chromium download available can still work.
			browser = await chromium.launch();
		}
	} catch (err: any) {
		throw new WebCaptureError(
			`could not launch a browser: ${err?.message ?? err}\n` +
				"Google Chrome must be installed, or run: npx playwright install chromium",
		);
	}

	const pageErrors: string[] = [];
	try {
		const context = await browser.newContext({
			viewport: { width, height: opts.height ?? 900 },
			deviceScaleFactor: opts.deviceScaleFactor ?? 1,
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		page.on("pageerror", (e: any) => pageErrors.push(String(e?.message ?? e)));

		try {
			await page.goto(opts.url, { waitUntil: "networkidle", timeout });
		} catch (err: any) {
			// networkidle never settles on pages with long-polling or analytics
			// beacons. A page that loaded but never went quiet is still worth
			// photographing, so fall back to the weaker condition.
			await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout });
		}

		await page.addStyleTag({ content: DETERMINISM_CSS });
		try {
			await page.evaluate(() => (document as any).fonts?.ready);
		} catch {
			/* no font loading API, or it rejected; not worth failing over */
		}
		if (opts.waitMs) await page.waitForTimeout(Math.min(opts.waitMs, 15_000));

		const info = await page.evaluate(() => ({
			title: document.title,
			url: location.href,
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		}));

		if (opts.selector) {
			const locator = page.locator(opts.selector).first();
			if ((await locator.count()) === 0) {
				throw new WebCaptureError(`no element matches selector ${JSON.stringify(opts.selector)}`);
			}
			// Shoot the ELEMENT. A page-level clip silently returns the wrong
			// region once the element is below the fold, because the clip is in
			// viewport coordinates and the element is not.
			await locator.scrollIntoViewIfNeeded();
			await locator.screenshot({ path: out });
		} else {
			await page.screenshot({ path: out, fullPage: opts.fullPage !== false });
		}

		return { title: info.title, finalUrl: info.url, overflow: info.overflow, pageErrors };
	} finally {
		await browser.close().catch(() => {});
	}
}
