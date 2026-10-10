import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureWebPage } from "../tools/lib/web-capture";
import type { Dataset, RangeId } from "./aggregate";
import { fg, type Ink, type RGB } from "./draw";
import { TABS } from "./tabs";
import { StatsView } from "./view";

const PAGE_BG = "rgb(29,32,33)";
const TEXT: RGB = [235, 219, 178];

/** Gruvbox-dark truecolor, so the page needs no theme to read. */
const htmlInk: Ink = {
	text: (s) => fg(TEXT, s),
	muted: (s) => fg([168, 153, 132], s),
	dim: (s) => fg([124, 111, 100], s),
	accent: (s) => fg([250, 189, 47], s),
	border: (s) => fg([102, 92, 84], s),
};

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truecolor and bold SGR runs become styled spans; any other escape sequence is dropped. */
export function ansiToHtml(lines: string[]): string {
	let color: string | undefined;
	let back: string | undefined;
	let strong = false;
	const span = (text: string) => {
		if (!text) return "";
		const style = [color && `color:${color}`, back && `background:${back}`, strong && "font-weight:700"].filter(Boolean).join(";");
		return style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text);
	};
	const out: string[] = [];
	for (const line of lines) {
		let html = "";
		let at = 0;
		for (const m of line.matchAll(/\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
			html += span(line.slice(at, m.index));
			at = m.index + m[0].length;
			if (m[2] !== "m") continue;
			const p = m[1].split(";").map(Number);
			for (let i = 0; i < p.length; i++) {
				const c = p[i];
				if (c === 0) [color, back, strong] = [undefined, undefined, false];
				else if (c === 1) strong = true;
				else if (c === 22) strong = false;
				else if (c === 39) color = undefined;
				else if (c === 49) back = undefined;
				else if ((c === 38 || c === 48) && p[i + 1] === 2) {
					const rgb = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
					if (c === 38) color = rgb;
					else back = rgb;
					i += 4;
				}
			}
		}
		out.push(html + span(line.slice(at)));
	}
	return out.join("\n");
}

function page(body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:${PAGE_BG}}
pre{display:inline-block;margin:0;padding:28px 32px;background:${PAGE_BG};color:rgb(${TEXT.join(",")});font:15px/1.1 Menlo,"SF Mono",Monaco,monospace}
</style></head><body><pre id="wrapped">${body}</pre></body></html>`;
}

/** The Wrapped tab for `range`, rendered to a PNG at `out`. Launches the local Chrome through playwright-core; no network. */
export async function writeWrappedPng(ds: Dataset, range: RangeId, planUsd: number, out: string): Promise<void> {
	const view = new StatsView(ds, htmlInk, { planUsd, windows: new Map(), range }, () => {});
	const lines = view.tabLines(TABS.findIndex((t) => t.title === "Wrapped"), 102);
	const html = `${out}.html`;
	await fs.mkdir(path.dirname(out), { recursive: true });
	await fs.writeFile(html, page(ansiToHtml(lines)));
	try {
		await captureWebPage(out, { url: pathToFileURL(html).href, selector: "#wrapped", deviceScaleFactor: 2, width: 1200, timeoutMs: 20_000 });
	} finally {
		await fs.unlink(html).catch(() => {});
	}
}
